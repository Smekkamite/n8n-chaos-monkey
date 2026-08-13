import http from 'node:http';

const expected = process.env.TEST_HEADER_VALUE;
const requestLimit = Number(process.env.TEST_REQUEST_LIMIT ?? '1');
let seen = 0;

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    seen += 1;
    if (seen >= requestLimit) server.close();
    if (request.headers['x-test-key'] !== expected) {
      response.writeHead(403, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ status: 'FORBIDDEN' }));
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/ok' });
      return response.end();
    }
    if (request.url === '/slow') {
      return setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'LATE' }));
      }, 500);
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ACCEPTED', bodyReceived: Boolean(body) }));
  });
});

server.listen(0, '127.0.0.1', () => console.log(`PORT=${server.address().port}`));
