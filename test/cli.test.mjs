import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../chaos-tester.mjs', import.meta.url)));
const cli = path.join(root, 'chaos-tester.mjs');
const fixture = (name) => path.join(root, 'test', 'fixtures', name);
const support = (name) => path.join(root, 'test-support', name);
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('prints help and version', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /n8n-chaos test/);
  assert.equal(run(['--version']).stdout.trim(), '0.1.1');
});

async function startHeaderServer(requestLimit = 1) {
  const child = spawn(process.execPath, [support('header-server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_HEADER_VALUE: 'fixture-secret', TEST_REQUEST_LIMIT: String(requestLimit) } });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Header server did not start: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/PORT=(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Header server exited with ${code}`)); });
  });
  return { child, port };
}

test('analyzes webhook fields and side effects', () => {
  const result = run(['analyze', '--workflow', fixture('workflow.json')]);
  assert.equal(result.status, 0, result.stderr);
  const analysis = JSON.parse(result.stdout);
  assert.deepEqual(analysis.inputFields, ['email']);
  assert.equal(analysis.webhooks[0].path, 'fixture');
  assert.ok(analysis.risks.some((risk) => risk.node === 'Create Draft' && risk.risks.some((tag) => tag.startsWith('external side effect'))));
});

test('generates required-field scenarios from expectations', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-chaos-'));
  const out = path.join(temp, 'scenarios.json');
  const result = run(['generate', '--workflow', fixture('workflow.json'), '--payload', fixture('payload.json'), '--expectations', fixture('expectations.json'), '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const generated = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(generated.scenarios.find((scenario) => scenario.id === 'missing_email').required, true);
  assert.equal(generated.scenarios.find((scenario) => scenario.id === 'duplicate_event').requests.length, 10);
});

test('isolates identity fields across scenarios but shares one identity inside duplicate deliveries', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-chaos-isolation-'));
  const workflowFile = path.join(temp, 'workflow.json');
  const payloadFile = path.join(temp, 'payload.json');
  const expectationsFile = path.join(temp, 'expectations.json');
  const out = path.join(temp, 'scenarios.json');
  await fs.writeFile(workflowFile, JSON.stringify({ name: 'Identity fixture', nodes: [{ name: 'Use ID', type: 'n8n-nodes-base.set', parameters: { value: '={{ $json.body.ticket_id }}' } }] }));
  await fs.writeFile(payloadFile, JSON.stringify({ ticket_id: 'ticket-original', message: 'hello' }));
  await fs.writeFile(expectationsFile, JSON.stringify({ identityFields: ['ticket_id'], duplicateConcurrency: 3 }));
  const result = run(['generate', '--workflow', workflowFile, '--payload', payloadFile, '--expectations', expectationsFile, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const generated = JSON.parse(await fs.readFile(out, 'utf8'));
  const baselineId = generated.scenarios.find((scenario) => scenario.id === 'baseline_valid').requests[0].body.ticket_id;
  const duplicateIds = generated.scenarios.find((scenario) => scenario.id === 'duplicate_event').requests.map((request) => request.body.ticket_id);
  assert.notEqual(baselineId, 'ticket-original');
  assert.equal(new Set(duplicateIds).size, 1);
  assert.notEqual(duplicateIds[0], baselineId);
});

test('uses webhook auth from a file without persisting the secret or payload', async () => {
  const { port } = await startHeaderServer();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-chaos-header-'));
  const headerFile = path.join(temp, 'header.json');
  const reportFile = path.join(temp, 'campaign.json');
  await fs.writeFile(headerFile, JSON.stringify({ name: 'X-Test-Key', value: 'fixture-secret' }));
  const result = run(['run', '--workflow', fixture('workflow.json'), '--payload', fixture('payload.json'), '--target', `http://127.0.0.1:${port}/ok`, '--scenario', 'baseline_valid', '--webhook-header-file', headerFile, '--report', reportFile]);
  assert.equal(result.status, 0, result.stderr);
  const raw = await fs.readFile(reportFile, 'utf8');
  const campaign = JSON.parse(raw);
  assert.equal(campaign.results[0].results[0].status, 200);
  assert.equal(campaign.payloadsIncluded, false);
  assert.equal('requests' in campaign.results[0], false);
  assert.doesNotMatch(raw, /fixture-secret|test@example\.invalid/);
});

test('times out slow webhooks and refuses redirects', async () => {
  const { port } = await startHeaderServer(2);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-chaos-network-'));
  const headerFile = path.join(temp, 'header.json');
  await fs.writeFile(headerFile, JSON.stringify({ name: 'X-Test-Key', value: 'fixture-secret' }));
  for (const [route, timeout] of [['slow', '100'], ['redirect', '1000']]) {
    const reportFile = path.join(temp, `${route}.json`);
    const result = run(['run', '--workflow', fixture('workflow.json'), '--payload', fixture('payload.json'), '--target', `http://127.0.0.1:${port}/${route}`, '--scenario', 'baseline_valid', '--webhook-header-file', headerFile, '--request-timeout-ms', timeout, '--report', reportFile]);
    assert.equal(result.status, 0, result.stderr);
    const campaign = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    assert.equal(campaign.results[0].results[0].ok, false);
    assert.match(campaign.results[0].results[0].error, /fetch failed|timed out|aborted/i);
  }
});

test('recognizes an exported Postgres atomic idempotency candidate', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-chaos-atomic-'));
  const workflowFile = path.join(temp, 'workflow.json');
  await fs.writeFile(workflowFile, JSON.stringify({ name: 'Atomic fixture', nodes: [{ name: 'Claim Event', type: 'n8n-nodes-base.postgres', parameters: { operation: 'executeQuery', query: 'INSERT INTO processed_events(event_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_key' } }] }));
  const result = run(['analyze', '--workflow', workflowFile]);
  assert.equal(result.status, 0, result.stderr);
  const analysis = JSON.parse(result.stdout);
  assert.equal(analysis.idempotency.classification, 'ATOMIC_CANDIDATE_DETECTED');
});

test('keeps undeclared missing fields as needs-review', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-chaos-report-'));
  const campaignFile = path.join(temp, 'campaign.json');
  const tracesFile = path.join(temp, 'traces.json');
  const summaryFile = path.join(temp, 'summary.json');
  await fs.writeFile(campaignFile, JSON.stringify({
    campaignId: 'test-campaign',
    analysis: { workflow: 'Fixture', risks: [{ node: 'Create Draft', risks: ['external side effect: email/draft'] }] },
    results: [{ id: 'missing_email', title: 'Missing input field: email', required: false, results: [{ status: 200 }] }]
  }));
  await fs.writeFile(tracesFile, JSON.stringify({ traces: [{ chaos: { scenarioId: 'missing_email' }, nodes: [{ name: 'Create Draft' }], errors: [] }] }));
  const result = run(['report', '--campaign', campaignFile, '--traces', tracesFile, '--out', path.join(temp, 'report.md'), '--json-out', summaryFile]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await fs.readFile(summaryFile, 'utf8'));
  assert.equal(summary.counts.WARN, 1);
  assert.equal(summary.counts.FAIL, 0);
});

test('fails concurrent duplicates when multiple executions reach side effects', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-chaos-duplicate-'));
  const campaignFile = path.join(temp, 'campaign.json');
  const tracesFile = path.join(temp, 'traces.json');
  const summaryFile = path.join(temp, 'summary.json');
  await fs.writeFile(campaignFile, JSON.stringify({
    campaignId: 'duplicate-campaign',
    analysis: { workflow: 'Fixture', idempotency: { classification: 'NO_ATOMIC_CONTROL_DETECTED', evidence: [] }, risks: [{ node: 'Create Draft', risks: ['external side effect: email/draft'] }] },
    results: [{ id: 'duplicate_event', title: 'Duplicate event (10 concurrent deliveries)', results: Array.from({ length: 10 }, () => ({ status: 200 })) }]
  }));
  await fs.writeFile(tracesFile, JSON.stringify({ traces: Array.from({ length: 10 }, (_, index) => ({ chaos: { scenarioId: 'duplicate_event' }, nodes: index < 2 ? [{ name: 'Create Draft', status: 'COMPLETED' }] : [], errors: [] })) }));
  const result = run(['report', '--campaign', campaignFile, '--traces', tracesFile, '--out', path.join(temp, 'report.md'), '--json-out', summaryFile]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await fs.readFile(summaryFile, 'utf8'));
  assert.equal(summary.counts.FAIL, 1);
  assert.equal(summary.rootCauses[0].cause, 'Idempotency absent');
});
