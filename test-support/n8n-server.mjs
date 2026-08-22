import http from 'node:http';

const executions = [];
let nextId = 1;

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.headers['x-n8n-api-key'] && request.headers['x-n8n-api-key'] !== 'fixture-api-key') {
    return send(response, 401, { error: 'unauthorized' });
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/workflows/fixture-workflow-id') {
    return send(response, 200, { id: 'fixture-workflow-id', active: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/executions') {
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const offset = Number(url.searchParams.get('cursor') ?? '0');
    const page = executions.slice(offset, offset + limit);
    const nextCursor = offset + limit < executions.length ? String(offset + limit) : undefined;
    return send(response, 200, { data: page, nextCursor });
  }
  if (request.method === 'POST' && url.pathname === '/webhook/fixture') {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try { JSON.parse(raw); } catch { return send(response, 400, { error: 'malformed JSON' }); }
      executions.unshift({
        id: String(nextId++),
        status: 'success',
        finished: true,
        data: {
          resultData: {
            runData: {
              Webhook: [{
                executionStatus: 'success',
                data: { main: [[{ json: { headers: request.headers } }]] }
              }]
            }
          }
        }
      });
      return send(response, 200, { status: 'accepted' });
    });
    return;
  }
  return send(response, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => console.log(`PORT=${server.address().port}`));
