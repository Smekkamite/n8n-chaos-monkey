#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(opt('--port', '8787'));
const configFile = opt('--config', 'fault-scenarios.json');
const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
const faults = new Map((config.faults ?? []).map((fault) => [fault.id, fault]));
const log = [];
const send = (response, status, headers, body) => {
  response.writeHead(status, headers);
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const baselineFor = (service) => {
  if (service === 'triage') return { message: { content: { ticket_id: 'chaos-mock-ticket', category: 'GENERAL_QUESTION', priority: 'LOW', sentiment: 'NEUTRAL', suggested_team: 'GENERAL_SUPPORT', knowledge_key: 'PASSWORD_RESET', automatic_resolution_recommended: true, human_review_recommended: false, confidence: 95, summary: 'Mock triage result', review_reason: '', status: 'OK' } } };
  if (service === 'response') return { message: { content: { subject: 'Mock support response', email_body: 'This draft was generated through the local Chaos Monkey mock.' } } };
  return { ok: true, service, mocked: true };
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/health') return send(response, 200, { 'content-type': 'application/json' }, { ok: true, faults: faults.size });
  if (url.pathname === '/__chaos/logs') return send(response, 200, { 'content-type': 'application/json' }, log);
  if (!url.pathname.startsWith('/mock/')) return send(response, 404, { 'content-type': 'application/json' }, { error: 'Use /mock/<service>' });

  const scenarioId = request.headers['x-chaos-scenario'] ?? url.searchParams.get('scenario');
  const fault = faults.get(scenarioId);
  const service = url.pathname.slice('/mock/'.length);
  const entry = { at: new Date().toISOString(), service, scenarioId: scenarioId ?? 'baseline', method: request.method };
  log.push(entry);
  if (!fault) return send(response, 200, { 'content-type': 'application/json' }, baselineFor(service));
  if (fault.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
  if (fault.disconnect) return request.socket.destroy();
  const headers = { 'content-type': fault.contentType ?? 'application/json', ...(fault.headers ?? {}) };
  return send(response, fault.status ?? 200, headers, fault.body ?? { ok: true, service, mocked: true });
});

server.listen(port, '127.0.0.1', () => console.log(`Chaos mock listening at http://127.0.0.1:${port} with ${faults.size} faults.`));
