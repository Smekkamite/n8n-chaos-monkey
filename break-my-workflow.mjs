#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const command = args.shift();
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);
const VERSION = '0.1.2';
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
};
const writeText = async (file, value) => {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, value);
};
const readApiKey = async (keyFile, keyEnv = 'N8N_API_KEY') => keyFile
  ? (await fs.readFile(keyFile, 'utf8')).split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'))
  : process.env[keyEnv];
const readWebhookHeader = async (file) => {
  if (!file) return undefined;
  const header = await readJson(file);
  if (typeof header.name !== 'string' || !header.name.trim() || typeof header.value !== 'string' || !header.value) {
    throw new Error('Webhook header file must contain non-empty string properties "name" and "value".');
  }
  if (['content-type', 'x-break-my-workflow-test', 'x-break-my-workflow-campaign', 'x-break-my-workflow-scenario'].includes(header.name.toLowerCase())) {
    throw new Error(`Webhook header name ${header.name} is reserved by Break My Workflow.`);
  }
  return { name: header.name.trim(), value: header.value };
};

function fetchOptions(timeoutMs, options = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Error('Request timeout must be an integer between 100 and 300000 milliseconds.');
  }
  return { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) };
}

function isolatedIdentityValue(value, scenarioId) {
  if (typeof value !== 'string') return value;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return randomUUID();
  return `${value}__${scenarioId}_${randomUUID().slice(0, 8)}`;
}

function isolatePayload(payload, identityFields, scenarioId) {
  const isolated = structuredClone(payload);
  for (const field of identityFields) {
    if (Object.hasOwn(isolated, field)) isolated[field] = isolatedIdentityValue(isolated[field], scenarioId);
  }
  return isolated;
}

function analyze(workflow) {
  const nodes = workflow.nodes ?? [];
  const webhooks = nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => ({
    name: n.name, method: n.parameters?.httpMethod ?? 'GET', path: n.parameters?.path ?? '', responseMode: n.parameters?.responseMode,
    authentication: n.parameters?.authentication ?? 'none'
  }));
  const inputFields = new Set();
  for (const node of nodes) {
    const text = JSON.stringify(node.parameters ?? {});
    for (const match of text.matchAll(/\$json\.body\.([A-Za-z_][A-Za-z0-9_]*)/g)) inputFields.add(match[1]);
  }
  const risks = nodes.flatMap((n) => {
    const tags = [];
    const operationText = JSON.stringify({ operation: n.parameters?.operation, resource: n.parameters?.resource, method: n.parameters?.method }).toLowerCase();
    const mutating = /append|create|delete|draft|insert|patch|post|send|update|upsert/.test(operationText);
    if (n.type.includes('webhook')) tags.push('external input');
    if (n.type.includes('httpRequest')) tags.push('external service dependency');
    if (n.type.includes('openAi') || n.type.includes('langchain')) tags.push('AI structured-output dependency');
    if (n.type.includes('gmail')) tags.push('external side effect: email/draft');
    if (/(telegram|slack|discord|twilio|sendemail)/i.test(n.type)) tags.push('external side effect: outbound message');
    if (n.type.includes('googleSheets')) tags.push('external service dependency');
    if (n.type.includes('googleSheets') && mutating) tags.push('external side effect: state mutation');
    if (/(telegram|slack|discord|stripe|postgres|mysql|airtable|notion|hubspot|twilio|salesforce|mongodb|redis|sendemail)/i.test(n.type)) tags.push('external service dependency');
    if (mutating && /(stripe|postgres|mysql|airtable|notion|hubspot|salesforce|mongodb|redis)/i.test(n.type)) tags.push('external side effect: service mutation');
    if (n.type === 'n8n-nodes-base.if') tags.push('branching / type-sensitive logic');
    return tags.length ? [{ node: n.name, type: n.type, risks: tags }] : [];
  });
  const atomicCandidates = [];
  const unverifiedControls = [];
  for (const node of nodes) {
    const parameters = JSON.stringify(node.parameters ?? {});
    if (/postgres/i.test(node.type) && /on\s+conflict[\s\S]*do\s+nothing/i.test(parameters)) atomicCandidates.push(`${node.name}: Postgres ON CONFLICT DO NOTHING`);
    if (/redis/i.test(node.type) && /(setifnotexists|setnx|["'\s]nx["'\s])/i.test(parameters)) atomicCandidates.push(`${node.name}: Redis set-if-not-exists/NX`);
    if (/removeduplicates/i.test(node.type)) unverifiedControls.push(`${node.name}: Remove Duplicates has no asserted atomicity guarantee`);
    if (/datatable/i.test(node.type)) unverifiedControls.push(`${node.name}: Data Table atomicity is not established by the workflow export`);
  }
  const idempotency = atomicCandidates.length
    ? { classification: 'ATOMIC_CANDIDATE_DETECTED', evidence: atomicCandidates }
    : unverifiedControls.length
      ? { classification: 'UNVERIFIED_DEDUPLICATION_CONTROL', evidence: unverifiedControls }
      : { classification: 'NO_ATOMIC_CONTROL_DETECTED', evidence: [] };
  return { workflow: workflow.name ?? 'Unnamed workflow', nodeCount: nodes.length, webhooks, inputFields: [...inputFields].sort(), risks, idempotency };
}

function scenarios(payload, fields, expectations = {}) {
  const first = fields[0];
  const requiredFields = new Set(expectations.requiredFields ?? []);
  const inferredIdentityFields = fields.filter((field) => /(^id$|_id$|Id$|^(event|request|ticket|order|message)Id$)/.test(field) && typeof payload[field] === 'string');
  const identityFields = [...new Set(expectations.identityFields ?? inferredIdentityFields)];
  const scenarioPayload = (scenarioId) => isolatePayload(payload, identityFields, scenarioId);
  const result = [{ id: 'baseline_valid', title: 'Valid payload baseline', identityFields, requests: [{ body: scenarioPayload('baseline_valid') }] }];
  for (const field of fields) {
    const missing = scenarioPayload(`missing_${field}`); delete missing[field];
    const required = requiredFields.has(field);
    result.push({ id: `missing_${field}`, title: `Missing input field: ${field}`, required, requests: [{ body: missing }], expectation: required ? 'Reject or route safely before external side effects.' : 'Needs review unless the field is declared required.' });
  }
  if (first) {
    const nullValue = scenarioPayload(`null_${first}`); nullValue[first] = null;
    result.push({ id: `null_${first}`, title: `Null value: ${first}`, required: requiredFields.has(first), requests: [{ body: nullValue }], expectation: 'Validate nullability before external side effects.' });
    const wrongType = scenarioPayload(`wrong_type_${first}`); wrongType[first] = { invalid: true };
    result.push({ id: `wrong_type_${first}`, title: `Wrong type: ${first}`, requests: [{ body: wrongType }], expectation: 'Reject an incompatible type or route safely before external side effects.' });
  }
  const extra = scenarioPayload('unexpected_extra_field'); extra.__break_my_workflow_unexpected = { source: 'break-my-workflow' };
  result.push({ id: 'unexpected_extra_field', title: 'Unexpected nested field', requests: [{ body: extra }] });
  result.push({ id: 'malformed_json', title: 'Malformed JSON body', requests: [{ raw: '{"incomplete":' }], expectation: 'Respond 4xx; no execution or side effect.' });
  const duplicateConcurrency = Number(expectations.duplicateConcurrency ?? 10);
  if (!Number.isInteger(duplicateConcurrency) || duplicateConcurrency < 2 || duplicateConcurrency > 100) throw new Error('duplicateConcurrency must be an integer between 2 and 100.');
  const duplicatePayload = scenarioPayload('duplicate_event');
  result.push({ id: 'duplicate_event', title: `Duplicate event (${duplicateConcurrency} concurrent deliveries)`, identityFields, concurrency: duplicateConcurrency, requests: Array.from({ length: duplicateConcurrency }, () => ({ body: structuredClone(duplicatePayload) })), expectation: 'At most one external action; deduplicate or safely acknowledge duplicates.' });
  return result;
}

async function request(target, req, marker = {}, options = {}) {
  const headers = { 'content-type': 'application/json', 'x-break-my-workflow-test': 'true', 'x-break-my-workflow-campaign': marker.campaignId ?? '', 'x-break-my-workflow-scenario': marker.scenarioId ?? '' };
  if (options.webhookHeader) headers[options.webhookHeader.name] = options.webhookHeader.value;
  const init = fetchOptions(options.timeoutMs ?? 15_000, { method: 'POST', headers, body: req.raw ?? JSON.stringify(req.body) });
  const started = performance.now();
  try {
    const response = await fetch(target, init);
    const text = await response.text();
    let responseJson;
    try { responseJson = JSON.parse(text); } catch { /* A response body need not be JSON. */ }
    return { ok: response.ok, status: response.status, durationMs: Math.round(performance.now() - started), response: text.slice(0, 4000), responseJson };
  } catch (error) {
    return { ok: false, error: error.message, durationMs: Math.round(performance.now() - started) };
  }
}

function summarizeExecution(execution) {
  const runData = execution?.data?.resultData?.runData ?? execution?.resultData?.runData ?? {};
  const webhookRun = Object.entries(runData).find(([name]) => name.toLowerCase().includes('webhook'))?.[1]?.at?.(-1);
  const webhookJson = webhookRun?.data?.main?.[0]?.[0]?.json ?? {};
  const headers = webhookJson.headers ?? {};
  const nodes = Object.entries(runData).map(([name, runs]) => {
    const last = Array.isArray(runs) ? runs.at(-1) : runs;
    const status = last?.error ? 'ERROR' : last?.executionStatus === 'running' ? 'RUNNING' : 'COMPLETED';
    return { name, status, error: last?.error?.message };
  });
  return { executionId: execution.id, status: execution.status, finished: execution.finished, testRun: { campaignId: headers['x-break-my-workflow-campaign'], scenarioId: headers['x-break-my-workflow-scenario'] }, nodes, errors: nodes.filter((node) => node.status === 'ERROR') };
}

function hasFields(value, expected) {
  return Object.entries(expected ?? {}).every(([key, expectedValue]) => value?.[key] === expectedValue);
}

async function assess() {
  const suiteFile = opt('--suite');
  const reportsArg = opt('--reports');
  if (!suiteFile || !reportsArg) throw new Error('assess requires --suite <suite.json> and --reports <report1.json,report2.json>');
  const suite = await readJson(suiteFile);
  const reports = await Promise.all(reportsArg.split(',').map((file) => readJson(file.trim())));
  const rows = suite.checks.map((check) => {
    const observations = reports.flatMap((report) => report.results ?? []).filter((result) => result.id === check.scenario)
      .flatMap((result) => result.results ?? []);
    const responseBodies = observations.map((result) => {
      if (result.responseJson) return result.responseJson;
      try { return JSON.parse(result.response); } catch { return undefined; }
    }).filter(Boolean);
    const forbidden = responseBodies.filter((body) => hasFields(body, check.forbidResponse)).length;
    const matches = responseBodies.filter((body) => hasFields(body, check.countResponseMatch)).length;
    const allowed = !check.allowResponse?.length || responseBodies.some((body) => check.allowResponse.some((rule) => hasFields(body, rule)));
    const enough = observations.length >= (check.minObservations ?? 1);
    let status = 'PASS';
    if (!enough) status = 'WARN';
    else if (forbidden || (check.maxResponseMatches !== undefined && matches > check.maxResponseMatches)) status = 'FAIL';
    else if (!allowed) status = 'WARN';
    return { ...check, status, observations: observations.length, forbidden, matches };
  });
  const counts = Object.fromEntries(['PASS', 'WARN', 'FAIL'].map((status) => [status, rows.filter((row) => row.status === status).length]));
  const markdown = [
    `# Resilience report — ${suite.name ?? 'n8n workflow'}`,
    '',
    `**Result:** ${counts.PASS}/${rows.length} passed · ${counts.FAIL} failed · ${counts.WARN} needs review`, '',
    '| Status | Scenario | Evidence |', '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.status} | ${row.title ?? row.scenario} | ${row.observations} observation(s); ${row.evidence ?? ''} |`), '',
    '## Recommended workflow corrections', '',
    ...rows.filter((row) => row.status !== 'PASS').flatMap((row) => [`### ${row.title ?? row.scenario}`, row.recommendation ?? 'Define an explicit safe behavior for this scenario.', ''])
  ].join('\n');
  const out = opt('--out', 'resilience-report.md');
  await writeText(out, markdown);
  console.log(`Assessment written to ${out}. ${counts.FAIL} failure(s), ${counts.WARN} warning(s).`);
}

async function collectExecutions() {
  const apiBase = opt('--api-base', 'http://localhost:5678').replace(/\/$/, '');
  const workflowId = opt('--workflow-id');
  const keyEnv = opt('--api-key-env', 'N8N_API_KEY');
  const keyFile = opt('--api-key-file');
  const apiKey = await readApiKey(keyFile, keyEnv);
  if (!workflowId) throw new Error('collect requires --workflow-id <n8n-workflow-id>');
  if (!apiKey) throw new Error(`No API key found in ${keyFile ? `file ${keyFile}` : `environment variable ${keyEnv}`}. The key is never accepted as a CLI argument or saved to reports.`);
  const headers = { 'X-N8N-API-KEY': apiKey };
  const listUrl = new URL(`${apiBase}/api/v1/executions`);
  listUrl.searchParams.set('workflowId', workflowId);
  listUrl.searchParams.set('limit', opt('--limit', '100'));
  listUrl.searchParams.set('includeData', 'true');
  const campaignId = opt('--campaign-id');
  const expected = Number(opt('--expected', '0'));
  const waitMs = Number(opt('--wait-ms', '10000'));
  const settleMs = Number(opt('--settle-ms', '1500'));
  const requestTimeoutMs = Number(opt('--request-timeout-ms', '15000'));
  if (!Number.isInteger(settleMs) || settleMs < 250 || settleMs > waitMs) throw new Error('settle-ms must be an integer between 250 and wait-ms.');
  const deadline = Date.now() + waitMs;
  let traces = [];
  let previousCount = -1;
  let lastChangeAt = Date.now();
  do {
    const listResponse = await fetch(listUrl, fetchOptions(requestTimeoutMs, { headers }));
    if (!listResponse.ok) throw new Error(`n8n execution list failed: HTTP ${listResponse.status}`);
    const listPayload = await listResponse.json();
    const executions = listPayload.data ?? listPayload.executions ?? [];
    const expanded = await Promise.all(executions.map(async (execution) => {
      if (execution.data || execution.resultData) return execution;
      const response = await fetch(`${apiBase}/api/v1/executions/${execution.id}?includeData=true`, fetchOptions(requestTimeoutMs, { headers }));
      return response.ok ? response.json() : execution;
    }));
    const allTraces = expanded.map(summarizeExecution);
    traces = campaignId ? allTraces.filter((trace) => trace.testRun.campaignId === campaignId) : allTraces;
    if (traces.length !== previousCount) {
      previousCount = traces.length;
      lastChangeAt = Date.now();
    }
    const settled = traces.length > 0 && Date.now() - lastChangeAt >= settleMs;
    if ((expected && traces.length >= expected) || settled || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (true);
  const out = opt('--out', 'execution-traces.json');
  await writeJson(out, { collectedAt: new Date().toISOString(), workflowId, traces });
  console.log(`Collected ${traces.length} execution trace(s) into ${out}.`);
}

async function reportCampaign() {
  const campaignFile = opt('--campaign');
  const tracesFile = opt('--traces');
  if (!campaignFile || !tracesFile) throw new Error('report requires --campaign <campaign.json> and --traces <execution-traces.json>');
  const campaign = await readJson(campaignFile);
  const traces = (await readJson(tracesFile)).traces ?? [];
  const sideEffectNodes = campaign.analysis.risks.filter((risk) => risk.risks.some((tag) => tag.startsWith('external side effect'))).map((risk) => risk.node);
  const rows = campaign.results.map((scenario) => {
    const matched = traces.filter((trace) => trace.testRun?.scenarioId === scenario.id);
    const errorNodes = matched.flatMap((trace) => trace.errors ?? []);
    const reached = new Set(matched.flatMap((trace) => trace.nodes ?? []).map((node) => node.name));
    const sideEffects = sideEffectNodes.filter((node) => reached.has(node));
    const reachedSideEffectExecutions = matched.filter((trace) => (trace.nodes ?? []).some((node) => sideEffectNodes.includes(node.name))).length;
    const completedSideEffectExecutions = matched.filter((trace) => (trace.nodes ?? []).some((node) => sideEffectNodes.includes(node.name) && node.status === 'COMPLETED')).length;
    const sideEffectCounts = Object.fromEntries(sideEffects.map((nodeName) => [nodeName, {
      reached: matched.filter((trace) => (trace.nodes ?? []).some((node) => node.name === nodeName)).length,
      completed: matched.filter((trace) => (trace.nodes ?? []).some((node) => node.name === nodeName && node.status === 'COMPLETED')).length,
      errored: matched.filter((trace) => (trace.nodes ?? []).some((node) => node.name === nodeName && node.status === 'ERROR')).length
    }]));
    const statuses = scenario.results.map((result) => result.status).filter(Boolean);
    const safeResponse = scenario.results.some((result) => result.status >= 400 && result.status < 500)
      || scenario.results.some((result) => /human[_ ]review/i.test(JSON.stringify(result.responseJson ?? result.response ?? '')));
    let status = 'WARN';
    if (scenario.id === 'malformed_json') status = statuses.some((code) => code >= 400 && code < 500) ? 'PASS' : 'FAIL';
    else if (scenario.id === 'duplicate_event') {
      if (completedSideEffectExecutions > 1) status = 'FAIL';
      else if (reachedSideEffectExecutions > 1) status = 'WARN';
      else if (completedSideEffectExecutions === 1 && matched.length >= 2) status = 'PASS';
      else status = 'WARN';
    }
    else if ((scenario.id.startsWith('api_') || scenario.id.startsWith('llm_')) && (errorNodes.length > 0 || sideEffects.length > 0)) status = 'FAIL';
    else if (scenario.id.startsWith('wrong_type_') && sideEffects.length > 0) status = 'FAIL';
    else if ((scenario.id.startsWith('missing_') || scenario.id.startsWith('null_')) && scenario.required && sideEffects.length > 0) status = 'FAIL';
    else if (scenario.id === 'baseline_valid') status = matched.length > 0 && errorNodes.length === 0 ? 'PASS' : 'FAIL';
    else if (scenario.id === 'unexpected_extra_field') status = matched.length > 0 && errorNodes.length === 0 ? 'PASS' : 'WARN';
    else if (safeResponse && sideEffects.length === 0) status = 'PASS';
    else if (errorNodes.length > 0) status = 'WARN';
    const details = [
      `HTTP ${statuses.join(', ') || 'n/a'}`,
      matched.length ? `${matched.length} execution(s)` : 'no matching execution',
      sideEffects.length ? `external-action nodes: ${Object.entries(sideEffectCounts).map(([node, count]) => `${node} reached=${count.reached}, completed=${count.completed}, errored=${count.errored}`).join('; ')}` : '',
      scenario.id === 'duplicate_event' ? `${reachedSideEffectExecutions} execution(s) reached and ${completedSideEffectExecutions} completed external-action nodes` : '',
      errorNodes.length ? `errors: ${errorNodes.map((node) => `${node.name}: ${node.error}`).join('; ')}` : ''
    ].filter(Boolean).join(' · ');
    const rootCauses = [];
    if (scenario.id.startsWith('missing_') || scenario.id.startsWith('null_')) rootCauses.push('Input validation absent or insufficient');
    if (scenario.id.startsWith('wrong_type_')) rootCauses.push('Type validation insufficient', 'Downstream error handling incomplete');
    if (scenario.id === 'duplicate_event') {
      const classification = campaign.analysis.idempotency?.classification;
      if (classification === 'ATOMIC_CANDIDATE_DETECTED') rootCauses.push('Atomic idempotency control ineffective');
      else if (classification === 'UNVERIFIED_DEDUPLICATION_CONTROL') rootCauses.push('Non-atomic or unverified deduplication pattern');
      else rootCauses.push('Idempotency absent');
    }
    if (scenario.id === 'api_429_rate_limit') rootCauses.push('Rate-limit handling absent');
    if (scenario.id === 'api_500_server_error') rootCauses.push('Upstream error handling incomplete');
    if (scenario.id === 'api_timeout') rootCauses.push('Timeout handling incomplete');
    if (scenario.id === 'api_empty_response' || scenario.id === 'api_changed_schema') rootCauses.push('Response schema validation absent');
    if (scenario.id === 'llm_malformed_json' || scenario.id === 'llm_invalid_schema') rootCauses.push('LLM output validation absent');
    return { id: scenario.id, title: scenario.title, status, details, rootCauses };
  });
  const counts = Object.fromEntries(['PASS', 'WARN', 'FAIL'].map((status) => [status, rows.filter((row) => row.status === status).length]));
  const rootCauseGroups = new Map();
  for (const row of rows.filter((row) => row.status === 'FAIL')) for (const cause of row.rootCauses) {
    const scenarios = rootCauseGroups.get(cause) ?? [];
    scenarios.push(row.title);
    rootCauseGroups.set(cause, scenarios);
  }
  const rootCauseCatalog = {
    'Input validation absent or insufficient': {
      severity: 'HIGH',
      impact: 'Malformed or incomplete input reaches external side effects.',
      remediation: 'Validate required fields and formats immediately after the trigger. Return 4xx or route to a safe review path before external actions.'
    },
    'Type validation insufficient': {
      severity: 'HIGH',
      impact: 'Values of an unexpected type can enter the automatic-response path.',
      remediation: 'Validate each field against its declared type and format before branching or calling external services.'
    },
    'Downstream error handling incomplete': {
      severity: 'HIGH',
      impact: 'A downstream failure occurs after AI and stateful external nodes have already run.',
      remediation: 'Add error branches around external actions and return a controlled failure or Human Review outcome; prevent partial side effects where possible.'
    },
    'Idempotency absent': {
      severity: 'CRITICAL',
      impact: 'A duplicate event can create duplicate external side effects.',
      remediation: 'Use an atomic durable idempotency record keyed by ticket_id before external actions; return a duplicate/no-op response for already-processed events.'
    },
    'Non-atomic or unverified deduplication pattern': {
      severity: 'CRITICAL',
      impact: 'Concurrent duplicate deliveries bypass the workflow deduplication control and reach external side effects.',
      remediation: 'Replace lookup-then-write logic with one atomic claim operation, such as Postgres INSERT ... ON CONFLICT DO NOTHING RETURNING or Redis SET NX.'
    },
    'Atomic idempotency control ineffective': {
      severity: 'CRITICAL',
      impact: 'A primitive that appears atomic in the export did not prevent concurrent duplicate side effects.',
      remediation: 'Verify the unique key, transaction boundary, branch condition, and that the claim occurs before every external side effect.'
    },
    'Rate-limit handling absent': {
      severity: 'HIGH',
      impact: 'An upstream 429 stops the workflow without a controlled retry or fallback.',
      remediation: 'Respect Retry-After where available, retry with bounded exponential backoff, and route exhausted retries to a durable queue or Human Review.'
    },
    'Upstream error handling incomplete': {
      severity: 'HIGH',
      impact: 'An upstream server error can stop processing without preserving a safe recovery path.',
      remediation: 'Add a bounded retry policy and an error branch that persists the event for replay or routes it to Human Review.'
    },
    'Timeout handling incomplete': {
      severity: 'HIGH',
      impact: 'A slow dependency can stall or fail a workflow without deterministic recovery.',
      remediation: 'Set explicit request timeouts, make retries idempotent, and preserve the event before retrying or escalating.'
    },
    'Response schema validation absent': {
      severity: 'HIGH',
      impact: 'A syntactically successful response with missing or renamed fields can reach unsafe logic.',
      remediation: 'Validate response shape and required fields before branching; quarantine unexpected schemas.'
    },
    'LLM output validation absent': {
      severity: 'HIGH',
      impact: 'Malformed or semantically invalid model output can drive workflow decisions.',
      remediation: 'Parse and validate against a strict schema, then send parse/schema failures to Human Review.'
    }
  };
  const markdown = [
    `# Break My Workflow report — ${campaign.analysis.workflow}`,
    '',
    `Campaign: \`${campaign.campaignId}\``, '',
    `**Resilience:** ${counts.PASS}/${rows.length} passed · ${counts.FAIL} failed resilience scenarios · ${counts.WARN} needs review`, '',
    '## Idempotency architecture', '',
    `Static classification: **${campaign.analysis.idempotency?.classification ?? 'UNKNOWN'}**`, '',
    ...((campaign.analysis.idempotency?.evidence ?? []).length ? campaign.analysis.idempotency.evidence.map((item) => `- ${item}`) : ['- No atomic idempotency primitive was recognized in the workflow export.']), '',
    '| Status | Scenario | Evidence |', '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.status} | ${row.title} | ${row.details} |`), '',
    '## Root causes', '',
    ...[...rootCauseGroups.entries()].flatMap(([cause, scenarios]) => {
      const detail = rootCauseCatalog[cause] ?? { severity: 'MEDIUM', impact: 'Resilience behavior requires review.', remediation: 'Define and enforce a safe expected behavior.' };
      return [
        `### ${detail.severity} · ${cause}`,
        detail.impact,
        '',
        `**Evidence:** ${scenarios.length} failed scenario(s): ${scenarios.join('; ')}.`,
        '',
        `**Remediation:** ${detail.remediation}`,
        ''
      ];
    })
  ].join('\n');
  const out = opt('--out', 'break-my-workflow-report.md');
  await writeText(out, markdown);
  const jsonOut = opt('--json-out');
  if (jsonOut) await writeJson(jsonOut, { campaignId: campaign.campaignId, workflow: campaign.analysis.workflow, counts, scenarios: rows, rootCauses: [...rootCauseGroups.entries()].map(([cause, scenarios]) => ({ cause, ...rootCauseCatalog[cause], scenarios })) });
  console.log(`Campaign report written to ${out}. ${counts.FAIL} failure(s), ${counts.WARN} warning(s).`);
}

const usage = () => `break-workflow ${VERSION}

Usage:
  break-workflow test --workflow workflow.json --payload payload.json --webhook URL [options]

Required for execution evidence:
  --api-key-file FILE       File containing an n8n API key
  or N8N_API_KEY            Environment variable containing the key

Options:
  --n8n URL                 n8n base URL (defaults to webhook origin)
  --workflow-id ID          Override workflow ID from the export
  --out-dir DIRECTORY       Campaign output directory
  --expectations FILE       Optional required-field contract
  --webhook-header-file FILE JSON file with webhook header name/value
  --duplicate-concurrency N Concurrent duplicate deliveries (default 10)
  --wait-ms NUMBER          Execution collection timeout (default 15000)
  --settle-ms NUMBER        Stop after traces are stable (default 1500)
  --request-timeout-ms N    Per-request timeout (default 15000)
  --include-payloads        Save generated request bodies in campaign.json
  --allow-nonlocal-target   Explicitly allow a non-local webhook

Advanced commands: analyze, generate, run, collect, report, assess, trace
`;

async function runOneCommandTest() {
  const workflowFile = opt('--workflow');
  const payloadFile = opt('--payload');
  const webhook = opt('--webhook') ?? opt('--target');
  if (!workflowFile || !payloadFile || !webhook) throw new Error('test requires --workflow, --payload, and --webhook');
  const workflow = await readJson(workflowFile);
  await readJson(payloadFile);
  const webhookUrl = new URL(webhook);
  const local = ['localhost', '127.0.0.1', '::1'].includes(webhookUrl.hostname);
  if (!local && !has('--allow-nonlocal-target')) throw new Error('Refusing a non-local webhook. Use an isolated test environment and add --allow-nonlocal-target explicitly.');
  if (webhookUrl.pathname.includes('/webhook-test/')) throw new Error('A full campaign requires an active /webhook/ Production URL; n8n Test URLs accept one request only.');
  const workflowId = opt('--workflow-id', workflow.id);
  if (!workflowId) throw new Error('Workflow ID is missing from the export. Add --workflow-id <id>.');
  const apiBase = opt('--n8n', webhookUrl.origin);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(opt('--out-dir', path.join('break-my-workflow-results', stamp)));
  await fs.mkdir(outDir, { recursive: true });
  const campaignFile = path.join(outDir, 'campaign.json');
  const tracesFile = path.join(outDir, 'execution-traces.json');
  const reportFile = path.join(outDir, 'report.md');
  const summaryFile = path.join(outDir, 'report.json');
  const passthrough = has('--allow-nonlocal-target') ? ['--allow-nonlocal-target'] : [];
  const keyFile = opt('--api-key-file');
  const expectationsFile = opt('--expectations');
  const webhookHeaderFile = opt('--webhook-header-file');
  const apiKey = await readApiKey(keyFile);
  if (!apiKey) throw new Error('test requires --api-key-file or N8N_API_KEY so execution evidence can be collected.');
  const requestTimeoutMs = Number(opt('--request-timeout-ms', '15000'));
  const workflowResponse = await fetch(`${apiBase.replace(/\/$/, '')}/api/v1/workflows/${workflowId}`, fetchOptions(requestTimeoutMs, { headers: { 'X-N8N-API-KEY': apiKey } }));
  if (!workflowResponse.ok) throw new Error(`n8n API preflight failed: HTTP ${workflowResponse.status}`);
  const liveWorkflow = await workflowResponse.json();
  if (!liveWorkflow.active) throw new Error('The selected workflow is not active. Activate its isolated test copy before running a campaign.');
  const invoke = (subcommand, subArgs) => {
    const result = spawnSync(process.execPath, [process.argv[1], subcommand, ...subArgs], { encoding: 'utf8', env: process.env });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0) throw new Error((result.stderr || `${subcommand} failed`).trim());
  };
  console.log(`Preflight passed. Output: ${outDir}`);
  const runArgs = ['--workflow', workflowFile, '--payload', payloadFile, '--target', webhook, '--report', campaignFile, ...passthrough];
  if (expectationsFile) runArgs.push('--expectations', expectationsFile);
  if (webhookHeaderFile) runArgs.push('--webhook-header-file', webhookHeaderFile);
  if (has('--include-payloads')) runArgs.push('--include-payloads');
  runArgs.push('--request-timeout-ms', String(requestTimeoutMs));
  const duplicateConcurrency = opt('--duplicate-concurrency');
  if (duplicateConcurrency) runArgs.push('--duplicate-concurrency', duplicateConcurrency);
  invoke('run', runArgs);
  const campaign = await readJson(campaignFile);
  const expectedExecutions = campaign.results.flatMap((scenario) => scenario.results).length;
  const collectArgs = ['--api-base', apiBase, '--workflow-id', workflowId, '--campaign-id', campaign.campaignId, '--expected', String(expectedExecutions), '--wait-ms', opt('--wait-ms', '15000'), '--settle-ms', opt('--settle-ms', '1500'), '--request-timeout-ms', String(requestTimeoutMs), '--out', tracesFile];
  if (keyFile) collectArgs.push('--api-key-file', keyFile);
  invoke('collect', collectArgs);
  invoke('report', ['--campaign', campaignFile, '--traces', tracesFile, '--out', reportFile, '--json-out', summaryFile]);
  const summary = await readJson(summaryFile);
  console.log(`Done. ${summary.counts.PASS}/${summary.scenarios.length} passed, ${summary.counts.FAIL} failed, ${summary.counts.WARN} need review.`);
  console.log(`Report: ${reportFile}`);
  if (summary.counts.FAIL > 0) process.exitCode = 2;
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') return console.log(usage());
  if (command === '--version' || command === '-v') return console.log(VERSION);
  if (!['test', 'analyze', 'generate', 'run', 'assess', 'trace', 'collect', 'report'].includes(command)) throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  if (command === 'test') return runOneCommandTest();
  if (command === 'assess') return assess();
  if (command === 'collect') return collectExecutions();
  if (command === 'report') return reportCampaign();
  if (command === 'trace') {
    const executionFile = opt('--execution');
    if (!executionFile) throw new Error('trace requires --execution <n8n-execution.json>');
    const out = opt('--out', 'execution-trace.json');
    await writeJson(out, summarizeExecution(await readJson(executionFile)));
    return console.log(`Execution trace written to ${out}.`);
  }
  const workflowFile = opt('--workflow');
  if (!workflowFile) throw new Error('--workflow <exported-n8n-workflow.json> is required');
  const analysis = analyze(await readJson(workflowFile));
  if (command === 'analyze') return console.log(JSON.stringify(analysis, null, 2));
  const payloadFile = opt('--payload');
  if (!payloadFile) throw new Error('--payload <valid-payload.json> is required');
  const expectationsFile = opt('--expectations');
  const expectations = expectationsFile ? await readJson(expectationsFile) : {};
  const duplicateConcurrency = opt('--duplicate-concurrency');
  if (duplicateConcurrency !== undefined) expectations.duplicateConcurrency = Number(duplicateConcurrency);
  const testScenarios = scenarios(await readJson(payloadFile), analysis.inputFields, expectations);
  if (command === 'generate') {
    const out = opt('--out', 'scenarios.generated.json');
    await writeJson(out, { generatedAt: new Date().toISOString(), analysis, scenarios: testScenarios });
    return console.log(`Created ${out} (${testScenarios.length} scenarios).`);
  }
  const target = opt('--target');
  if (!target) throw new Error('--target <n8n-test-webhook-url> is required');
  const url = new URL(target);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!local && !has('--allow-nonlocal-target')) throw new Error('Refusing a non-local target. Use a local n8n Test URL, or explicitly add --allow-nonlocal-target for an isolated staging endpoint.');
  const scenarioId = opt('--scenario');
  const faultScenarioId = opt('--fault-scenario');
  let selectedScenarios = scenarioId ? testScenarios.filter((scenario) => scenario.id === scenarioId) : testScenarios;
  if (scenarioId && selectedScenarios.length === 0) throw new Error(`Unknown scenario: ${scenarioId}`);
  if (faultScenarioId) {
    const baseline = testScenarios.find((scenario) => scenario.id === 'baseline_valid');
    selectedScenarios = [{ ...baseline, id: faultScenarioId, title: `Injected dependency fault: ${faultScenarioId}`, expectation: 'Workflow must fail safely without entering a success path.' }];
  }
  const testWebhook = url.pathname.includes('/webhook-test/');
  if (testWebhook && selectedScenarios.length > 1) throw new Error('n8n Test URLs accept one request only. Use --scenario for a single case, or activate an isolated test workflow and use its /webhook/ Production URL for a full campaign.');
  const campaignId = `workflow-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const webhookHeader = await readWebhookHeader(opt('--webhook-header-file'));
  const requestTimeoutMs = Number(opt('--request-timeout-ms', '15000'));
  const results = [];
  for (const scenario of selectedScenarios) {
    const scenarioResults = await Promise.all(scenario.requests.map((r) => request(target, r, { campaignId, scenarioId: scenario.id }, { webhookHeader, timeoutMs: requestTimeoutMs })));
    if (results.length === 0 && scenarioResults.some((result) => result.status === 404 && result.responseJson?.message?.includes('is not registered'))) {
      throw new Error('The webhook is not registered. In n8n, save and activate the isolated test workflow, then retry its /webhook/ Production URL. No scenarios were executed.');
    }
    const { requests, ...scenarioMetadata } = scenario;
    results.push({ ...scenarioMetadata, ...(has('--include-payloads') ? { requests } : {}), results: scenarioResults });
  }
  const report = { generatedAt: new Date().toISOString(), campaignId, target, analysis, expectations, payloadsIncluded: has('--include-payloads'), results, note: 'HTTP outcomes only. Request bodies are excluded by default. Collect n8n execution traces with --campaign-id to attach node-level evidence.' };
  const out = opt('--report', 'resilience-report.json'); await writeJson(out, report);
  console.log(`Report written to ${out}. ${results.length} scenarios executed.`);
}

main().catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
