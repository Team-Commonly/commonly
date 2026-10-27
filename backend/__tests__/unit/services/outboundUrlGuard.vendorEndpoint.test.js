// `requestVendorEndpoint` and `hostedVendorFetch`: every hosted-MCP request,
// each carrying a credential, through the outbound guard (TASK-253).
//
// No test touches the network. DNS is a spy on `dns.promises.lookup`, and
// `https.request` is a fake answering from a route table (the harness in
// outboundUrlGuard.fetch.test.js), so a refusal arm can prove no request was
// made and a success arm can read the exact options the guard gave the socket.
const dns = require('dns');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const { requestVendorEndpoint, isOutboundUrlRefused } = require('../../../services/outboundUrlGuard');
const { hostedVendorFetch, HOSTED_VENDOR_MAX_RESPONSE_BYTES } = require('../../../services/hostedVendorFetch');

const refusalOf = (promise) => promise.then(
  () => { throw new Error('expected a refusal, got a response'); },
  (error) => error,
);

const fakeHttps = (route, calls) => (url, options, callback) => {
  const req = new EventEmitter();
  const call = { url: String(url), options, body: '', destroyed: false };
  calls.push(call);
  req.write = (chunk) => { call.body += String(chunk); };
  req.destroy = (error) => {
    call.destroyed = true;
    if (error) setImmediate(() => req.emit('error', error));
    return req;
  };
  req.end = () => {
    const { status, headers = {}, chunks = [] } = route(String(url), options);
    const res = new Readable({ read() {} });
    res.statusCode = status;
    res.headers = headers;
    // One chunk per tick, as a socket delivers them, so a reader that destroys
    // the request mid-body stops the stream before its end is pushed.
    const pushFrom = (i) => {
      if (call.destroyed) return;
      if (i >= chunks.length) { res.push(null); return; }
      res.push(chunks[i]);
      setImmediate(() => pushFrom(i + 1));
    };
    setImmediate(() => {
      callback(res);
      pushFrom(0);
    });
  };
  return req;
};

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const FORM = {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic Y2xpZW50OnNlY3JldA==' },
  body: 'grant_type=refresh_token&refresh_token=rt-1',
  maxBytes: 1024,
};

describe('requestVendorEndpoint', () => {
  let lookupSpy;
  let httpRequestSpy;
  let httpsRequestSpy;
  let calls;
  const savedFlag = process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;

  beforeEach(() => {
    calls = [];
    lookupSpy = jest.spyOn(dns.promises, 'lookup');
    httpRequestSpy = jest.spyOn(http, 'request').mockImplementation(() => { throw new Error('no plain http in these tests'); });
    httpsRequestSpy = jest.spyOn(https, 'request');
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(() => {
    if (savedFlag === undefined) delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
    else process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES = savedFlag;
  });

  const send = (url, extra = {}) => requestVendorEndpoint(url, {
    ...FORM, signal: AbortSignal.timeout(5000), ...extra,
  });

  describe('refusals, made before any request', () => {
    beforeEach(() => {
      httpsRequestSpy.mockImplementation(() => { throw new Error('no network in refusal tests'); });
    });

    const noRequest = () => {
      expect(httpsRequestSpy).not.toHaveBeenCalled();
      expect(httpRequestSpy).not.toHaveBeenCalled();
    };

    test.each([
      ['http://auth.vendor.test/token', 'scheme http: is not https'],
      ['https://auth.vendor.test:8443/token', 'non-default port 8443'],
      ['https://user:pw@auth.vendor.test/token', 'credentials in URL'],
      ['https://metadata.google.internal/computeMetadata/v1/', 'host metadata.google.internal is not allowed'],
    ])('%s is refused without a lookup', async (url, reason) => {
      const error = await refusalOf(send(url));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toBe(`outbound URL refused: ${reason}`);
      expect(lookupSpy).not.toHaveBeenCalled();
      noRequest();
    });

    test.each([
      ['127.0.0.1'], ['10.0.0.5'], ['192.168.1.20'], ['169.254.169.254'], ['::1'], ['fd00::1'],
    ])('a vendor host resolving to %s is refused, even with the webhook private-address flag set', async (address) => {
      process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES = 'true';
      lookupSpy.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);

      const error = await refusalOf(send('https://auth.vendor.test/token'));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toContain(`resolves to ${address}`);
      noRequest();
    });

    test('a name with one public and one private answer is refused', async () => {
      lookupSpy.mockResolvedValue([...PUBLIC, { address: '10.0.0.5', family: 4 }]);

      const error = await refusalOf(send('https://auth.vendor.test/token'));

      expect(error.message).toContain('resolves to 10.0.0.5');
      noRequest();
    });
  });

  describe('requests', () => {
    let route;

    beforeEach(() => {
      delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
      lookupSpy.mockResolvedValue(PUBLIC);
      route = () => ({
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        chunks: [Buffer.from('{"access_token":"at-2"}')],
      });
      httpsRequestSpy.mockImplementation(fakeHttps((url, options) => route(url, options), calls));
    });

    test('sends the method, headers and body, pinned to the address that was checked', async () => {
      const result = await send('https://auth.vendor.test/token');

      expect(result).toEqual({ status: 200, contentType: 'application/json', text: '{"access_token":"at-2"}' });
      expect(calls).toHaveLength(1);
      expect(calls[0].options.method).toBe('POST');
      expect(calls[0].options.headers.Authorization).toBe('Basic Y2xpZW50OnNlY3JldA==');
      expect(calls[0].body).toBe('grant_type=refresh_token&refresh_token=rt-1');
      const pinned = await new Promise((resolve) => {
        calls[0].options.lookup('auth.vendor.test', {}, (error, address, family) => resolve({ address, family }));
      });
      expect(pinned).toEqual({ address: '93.184.216.34', family: 4 });
    });

    test.each([[301], [302], [307], [308]])('a %i is returned with its Location and never followed', async (status) => {
      route = () => ({ status, headers: { location: 'https://elsewhere.test/collect' } });

      const result = await send('https://auth.vendor.test/token');

      expect(result).toMatchObject({ status, location: 'https://elsewhere.test/collect' });
      expect(calls).toHaveLength(1);
      expect(lookupSpy).toHaveBeenCalledTimes(1);
    });

    test('reads a non-2xx body, so the caller can tell invalid_grant from an outage', async () => {
      route = () => ({
        status: 400,
        headers: { 'content-type': 'application/json' },
        chunks: [Buffer.from('{"error":"invalid_grant"}')],
      });

      const result = await send('https://auth.vendor.test/token');

      expect(result).toEqual({ status: 400, contentType: 'application/json', text: '{"error":"invalid_grant"}' });
    });

    test('fails a body over maxBytes instead of buffering it', async () => {
      route = () => ({ status: 200, headers: { 'content-type': 'application/json' }, chunks: [Buffer.alloc(2048, 120)] });

      const error = await refusalOf(send('https://auth.vendor.test/token'));

      expect(error.message).toMatch(/exceeds 1024 bytes/);
      expect(calls[0].destroyed).toBe(true);
    });
  });
});

describe('hostedVendorFetch', () => {
  let lookupSpy;
  let calls;

  beforeEach(() => {
    calls = [];
    lookupSpy = jest.spyOn(dns.promises, 'lookup');
    jest.spyOn(http, 'request').mockImplementation(() => { throw new Error('no plain http in these tests'); });
  });

  afterEach(() => jest.restoreAllMocks());

  test('reads at most 4 MiB of a vendor reply', () => {
    expect(HOSTED_VENDOR_MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
  });

  test('answers as fetch does: a Response with the status, media type and body', async () => {
    lookupSpy.mockResolvedValue(PUBLIC);
    jest.spyOn(https, 'request').mockImplementation(fakeHttps(() => ({
      status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'vendor-session', 'set-cookie': 'private-cookie' }, chunks: [Buffer.from('data: {"result":{}}\n')],
    }), calls));

    const response = await hostedVendorFetch('https://mcp.vendor.test/mcp', {
      method: 'post',
      headers: { Authorization: 'Bearer at-1', 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0"}',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('mcp-session-id')).toBe('vendor-session');
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(response.text()).resolves.toBe('data: {"result":{}}\n');
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.headers.authorization).toBe('Bearer at-1');
  });

  test('carries the SDK session from the pinned socket response through the next guarded request', async () => {
    const { hostedToolDefinitions } = require('../../../services/hostedMcpToolDefinitions');
    const { LINEAR_ENTRY } = require('../../../integrations/hostedMcp/linear');
    const fixture = require('../../fixtures/hostedMcp/linear-tools-list-2026-10-14.json');
    const { createHostedMcpRuntimeDriftCache } = require('../../../services/hostedMcpToolDefinitions');
    lookupSpy.mockResolvedValue(PUBLIC);
    jest.spyOn(https, 'request').mockImplementation(fakeHttps((_url, options) => {
      if (options.method === 'DELETE') return { status: 204 };
      const body = JSON.parse(calls[calls.length - 1].body);
      if (body.method === 'initialize') return { status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'socket-session' },
        chunks: [Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Linear fixture', version: '1' },
        } }))],
      };
      if (options.headers['mcp-session-id'] !== 'socket-session'
        || options.headers['mcp-protocol-version'] !== '2025-06-18') {
        return { status: 400, headers: { 'content-type': 'text/plain' }, chunks: [Buffer.from('session required')] };
      }
      if (body.method === 'notifications/initialized') return { status: 202 };
      return { status: 200, headers: { 'content-type': 'application/json' }, chunks: [Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: body.id,
        result: body.method === 'tools/list' ? { tools: fixture.tools } : { content: [{ type: 'text', text: 'guarded' }] },
      }))] };
    }, calls));
    const deps = { loadRow: async () => ({ _id: 'row-1', config: { entryId: 'linear' } }),
      credentialFor: async () => ({ token: 'fixture-token' }), fetcher: hostedVendorFetch };
    deps.driftCache = createHostedMcpRuntimeDriftCache(deps, [LINEAR_ENTRY]);
    const definition = hostedToolDefinitions([LINEAR_ENTRY], deps).find((tool) => tool.name === 'linear.list_issues');
    await expect(definition.call({}, { type: 'hosted-mcp', entryId: 'linear', connectionId: 'row-1' }))
      .resolves.toEqual({ content: [{ type: 'text', text: 'guarded' }] });
    expect(calls.filter(({ options }) => options.method === 'DELETE')).toHaveLength(2);
    expect(calls.every(({ url }) => url === LINEAR_ENTRY.resource)).toBe(true);
  });

  test('sends a URLSearchParams body as its form encoding', async () => {
    lookupSpy.mockResolvedValue(PUBLIC);
    jest.spyOn(https, 'request').mockImplementation(fakeHttps(() => ({ status: 200, chunks: [Buffer.from('{}')] }), calls));

    await hostedVendorFetch('https://auth.vendor.test/token', {
      method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c-1' }),
    });

    expect(calls[0].body).toBe('grant_type=authorization_code&code=c-1');
  });

  test('a redirect is a non-ok Response carrying its Location, not a second request', async () => {
    lookupSpy.mockResolvedValue(PUBLIC);
    jest.spyOn(https, 'request').mockImplementation(fakeHttps(() => ({
      status: 307, headers: { location: 'https://elsewhere.test/' },
    }), calls));

    const response = await hostedVendorFetch('https://auth.vendor.test/token', { method: 'POST', body: 'x=1' });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://elsewhere.test/');
    expect(calls).toHaveLength(1);
  });

  test('a refusal surfaces the way fetch reports a network failure, with the detail only in the log', async () => {
    lookupSpy.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const httpsSpy = jest.spyOn(https, 'request');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const error = await refusalOf(hostedVendorFetch('https://mcp.vendor.test/mcp', { method: 'POST', body: '{}' }));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe('fetch failed: the outbound guard refused the vendor endpoint');
    expect(error.message).not.toContain('10.0.0.5');
    expect(warn.mock.calls[0][0]).toContain('10.0.0.5');
    expect(httpsSpy).not.toHaveBeenCalled();
  });

  test('refuses a body it cannot send as text, rather than stringifying it', async () => {
    lookupSpy.mockResolvedValue(PUBLIC);
    jest.spyOn(https, 'request').mockImplementation(fakeHttps(() => ({ status: 200 }), calls));

    await expect(hostedVendorFetch('https://mcp.vendor.test/mcp', { method: 'POST', body: new Blob(['x']) }))
      .rejects.toThrow('hostedVendorFetch sends only a string or URLSearchParams body');
    expect(calls).toHaveLength(0);
  });
});
