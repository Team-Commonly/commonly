// A stand-in Commonly API: enough for `commonly agent run` to bootstrap from an
// env token, take one @mention, and spawn its CLI. Every request is logged.
import http from 'node:http';

const port = Number(process.argv[2] || 47123);
const POD = '6a0000000000000000000001';
let served = false;
const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const path = req.url.split('?')[0];
    log(req.method, req.url, raw ? raw.slice(0, 300) : '');
    if (req.method === 'GET' && path === '/api/agents/runtime/installations') {
      return send(res, 200, {
        agentName: 'linux-smoke', displayName: 'linux-smoke', instanceId: 'default',
        installations: [{ type: 'installation', status: 'active', podId: POD, instanceId: 'default', displayName: 'linux-smoke', runtimeAdapter: null }],
      });
    }
    if (req.method === 'GET' && path === '/api/agents/runtime/events') {
      const events = served ? [] : [{
        _id: 'evt-linux-1', type: 'chat.mention', podId: POD, agentName: 'linux-smoke', instanceId: 'default',
        createdAt: new Date().toISOString(),
        payload: { podId: POD, messageId: '1', userId: 'u1', username: 'tester', content: '@linux-smoke hello' },
      }];
      served = true;
      return send(res, 200, { events });
    }
    if (req.method === 'GET' && path === `/api/agents/runtime/pods/${POD}/context`) {
      return send(res, 200, { focus: { podId: POD, revision: 0, focus: null } });
    }
    if (req.method === 'GET' && path === `/api/agents/runtime/pods/${POD}/messages`) return send(res, 200, { messages: [] });
    if (req.method === 'POST' && /\/ack$/.test(path)) return send(res, 200, { ok: true });
    return send(res, 404, { error: 'not found' });
  });
}).listen(port, '127.0.0.1', () => log(`stub listening on 127.0.0.1:${port}`));
