const http = require('http');
const net = require('net');
const {
  createSink, tokenMatches, recipient, extractLinks,
} = require('../../../services/stagingEmailSink');
const { sendEmail } = require('../../../services/emailService');

const TOKEN = 'sink-read-token-for-tests';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const start = async (config = {}) => {
  const sink = createSink({ readToken: TOKEN, ...config });
  await new Promise((resolve) => { sink.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${sink.server.address().port}`;
  return { ...sink, base, close: () => new Promise((resolve) => { sink.server.close(resolve); }) };
};

const post = (base, body) => fetch(`${base}/v3/email/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const inbox = (base, to, headers = AUTH) => fetch(`${base}/inbox?to=${encodeURIComponent(to)}`, { headers });

describe('stagingEmailSink helpers', () => {
  test('tokenMatches needs the exact bearer token', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    // An unset token never matches, even an empty bearer.
    expect(tokenMatches('Bearer ', '')).toBe(false);
  });

  test('recipient lowercases and unwraps a named address', () => {
    expect(recipient(' Walk1@Seed.Staging.Commonly.me ')).toBe('walk1@seed.staging.commonly.me');
    expect(recipient('Walker <w@x.io>')).toBe('w@x.io');
    expect(recipient('<>')).toBe('<>');
  });

  test('recipient stays linear on a long run of < (CodeQL polynomial regex)', () => {
    const hostile = `${'<'.repeat(200000)}a@b.io`;
    const started = Date.now();
    expect(recipient(hostile)).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('extractLinks finds each link once across text and html', () => {
    const link = 'https://staging.commonly.me/verify-email?token=abc';
    expect(extractLinks(`Verify: ${link}`, `<a href="${link}">Verify</a>`)).toEqual([link]);
  });
});

describe('stagingEmailSink server', () => {
  let sink;
  afterEach(async () => { if (sink) await sink.close(); sink = null; });

  test('stores a send and answers in the provider shape', async () => {
    sink = await start();
    const res = await post(sink.base, {
      api_key: 'email-sink',
      to: ['walk1@seed.staging.commonly.me'],
      sender: 'noreply@staging.commonly.me',
      subject: 'Verify your email',
      text_body: 'Open https://staging.commonly.me/verify-email?token=t1 to verify.',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ succeeded: 1, failed: 0, failures: [] });
    expect(sink.messages).toHaveLength(1);
  });

  test('reading needs the token; the inbox is per recipient, newest first', async () => {
    sink = await start();
    await post(sink.base, { to: ['a@seed.staging.commonly.me'], subject: 'first', text_body: 'https://x.io/1' });
    await post(sink.base, { to: ['b@seed.staging.commonly.me'], subject: 'other', text_body: 'https://x.io/2' });
    await post(sink.base, { to: ['A@seed.staging.commonly.me'], subject: 'second', text_body: 'https://x.io/3' });

    expect((await inbox(sink.base, 'a@seed.staging.commonly.me', {})).status).toBe(401);
    expect((await inbox(sink.base, 'a@seed.staging.commonly.me', { Authorization: 'Bearer wrong' })).status).toBe(401);

    const res = await inbox(sink.base, 'a@seed.staging.commonly.me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.messages.map((m) => m.subject)).toEqual(['second', 'first']);
    expect(body.messages[0].links).toEqual(['https://x.io/3']);
  });

  test('refuses a send without recipients, or with bad JSON', async () => {
    sink = await start();
    expect((await post(sink.base, { subject: 'no to' })).status).toBe(400);
    expect((await post(sink.base, { to: [], subject: 'empty' })).status).toBe(400);
    expect((await post(sink.base, { to: ['not-an-address'] })).status).toBe(400);
    expect((await post(sink.base, '{not json')).status).toBe(400);
    expect(sink.messages).toHaveLength(0);
  });

  test('answers an oversized body with a 413 the client receives', async () => {
    sink = await start();
    // Declared length over the limit.
    const big = await post(sink.base, { to: ['a@x.io'], text_body: 'x'.repeat(300000) });
    expect(big.status).toBe(413);
    // No declared length: chunked, caught while streaming.
    const { port } = sink.server.address();
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/v3/email/send', 
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      for (let i = 0; i < 6; i += 1) req.write('x'.repeat(50000));
      req.end();
    });
    expect(status).toBe(413);
    expect(sink.messages).toHaveLength(0);
  });

  test('a request target URL cannot parse is a 400, not a crash', async () => {
    sink = await start();
    const { port } = sink.server.address();
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.end('GET http://[/ HTTP/1.1\r\nHost: email-sink\r\nConnection: close\r\n\r\n');
      });
      let out = '';
      socket.on('data', (d) => { out += d; });
      socket.on('end', () => resolve(out));
      socket.on('error', reject);
    });
    expect(reply.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
    expect((await fetch(`${sink.base}/healthz`)).status).toBe(200);
  });

  test('caps each stored part', async () => {
    sink = await start();
    await post(sink.base, { to: ['a@x.io'], text_body: 'y'.repeat(100000) });
    expect(sink.messages[0].text).toHaveLength(64000);
  });

  test('keeps only the newest messages past its capacity', async () => {
    sink = await start({ capacity: 2 });
    await post(sink.base, { to: ['a@x.io'], subject: 'm1' });
    await post(sink.base, { to: ['a@x.io'], subject: 'm2' });
    await post(sink.base, { to: ['a@x.io'], subject: 'm3' });
    expect(sink.messages.map((m) => m.subject)).toEqual(['m2', 'm3']);
  });

  test('unknown routes 404 and health reports the count', async () => {
    sink = await start();
    expect((await fetch(`${sink.base}/v3/other`)).status).toBe(404);
    const health = await (await fetch(`${sink.base}/healthz`)).json();
    expect(health).toEqual({ ok: true, stored: 0 });
  });

  test('refuses a recipient that has no address once unwrapped', async () => {
    sink = await start();
    expect((await post(sink.base, { to: ['x@y <bar>'] })).status).toBe(400);
    expect(sink.messages).toHaveLength(0);
  });

  test('defaults: 32 connections, a 15 s deadline checked every 5 s', () => {
    const { server } = createSink({ readToken: TOKEN });
    expect(server.maxConnections).toBe(32);
    expect(server.requestTimeout).toBe(15000);
    expect(server.headersTimeout).toBe(15000);
  });

  const connect = (port) => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
    socket.on('error', reject);
  });
  const closed = (socket) => new Promise((resolve) => {
    let out = '';
    socket.on('data', (d) => { out += d; });
    socket.on('close', () => resolve(out));
  });

  test('drops a connection past the limit', async () => {
    sink = await start({ maxConnections: 2 });
    const { server } = sink;
    const { port } = server.address();
    const held = [await connect(port), await connect(port)];
    // Wait until the server has accepted both, so the third is the one over.
    const accepted = () => new Promise((r) => { server.getConnections((_e, n) => r(n)); });
    const settle = async () => { if (await accepted() < 2) await new Promise(setImmediate).then(settle); };
    await settle();
    const extra = await connect(port);
    expect(await closed(extra)).toBe('');
    held.forEach((s) => s.destroy());
  });

  test('answers 408 and closes a request left unfinished past its deadline', async () => {
    sink = await start({ requestTimeoutMs: 300 });
    const socket = await connect(sink.server.address().port);
    const reply = closed(socket);
    socket.write('POST /v3/email/send HTTP/1.1\r\nHost: email-sink\r\nContent-Length: 100\r\n\r\n{"to"');
    expect((await reply).split('\r\n')[0]).toBe('HTTP/1.1 408 Request Timeout');
    expect(sink.messages).toHaveLength(0);
  });

  describe('the backend send lands in the sink', () => {
    const saved = {};
    const KEYS = ['SMTP2GO_API_KEY', 'SMTP2GO_BASE_URL', 'SMTP2GO_FROM_EMAIL'];
    beforeEach(() => { KEYS.forEach((k) => { saved[k] = process.env[k]; }); });
    afterEach(() => {
      KEYS.forEach((k) => {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      });
    });

    test('emailService.sendEmail with the chart values reaches the inbox', async () => {
      sink = await start();
      // The values the chart sets when emailSink is on (backend-deployment.yaml).
      process.env.SMTP2GO_API_KEY = 'email-sink';
      process.env.SMTP2GO_FROM_EMAIL = 'noreply@staging.commonly.me';
      process.env.SMTP2GO_BASE_URL = `${sink.base}/v3/`;
      await sendEmail({
        to: 'walk2@seed.staging.commonly.me',
        subject: 'Verify your email',
        textBody: 'https://staging.commonly.me/verify-email?token=t2',
        htmlBody: '<a href="https://staging.commonly.me/verify-email?token=t2">Verify</a>',
      });
      const body = await (await inbox(sink.base, 'walk2@seed.staging.commonly.me')).json();
      expect(body.count).toBe(1);
      expect(body.messages[0]).toMatchObject({
        from: 'noreply@staging.commonly.me',
        links: ['https://staging.commonly.me/verify-email?token=t2'],
      });
    });
  });
});
