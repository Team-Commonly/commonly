// A stand-in Commonly API for the Windows smoke: enough for `commonly agent run`
// to bootstrap from an env token and receive one @mention. Every request is
// logged, so the report shows what the CLI asked for and what the turn did.
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
    log(req.method, req.url, raw ? raw.slice(0, 600) : '');
    if (req.method === 'GET' && path === '/api/agents/runtime/installations') {
      return send(res, 200, {
        agentName: 'win-smoke',
        displayName: 'win-smoke',
        instanceId: 'default',
        installations: [{
          type: 'installation', status: 'active', podId: POD, instanceId: 'default', displayName: 'win-smoke', runtimeAdapter: null,
        }],
      });
    }
    if (req.method === 'GET' && path === '/api/agents/runtime/events') {
      const events = served ? [] : [{
        _id: 'evt-win-1',
        type: 'chat.mention',
        podId: POD,
        agentName: 'win-smoke',
        instanceId: 'default',
        createdAt: new Date().toISOString(),
        payload: {
          podId: POD, messageId: '1', userId: 'u1', username: 'tester', content: '@win-smoke hello from the Windows smoke',
        },
      }];
      served = true;
      return send(res, 200, { events });
    }
    if (req.method === 'POST' && /^\/api\/agents\/runtime\/events\/[^/]+\/ack$/.test(path)) {
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  });
}).listen(port, '127.0.0.1', () => log(`stub listening on 127.0.0.1:${port}`));
