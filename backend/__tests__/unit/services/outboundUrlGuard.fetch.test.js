// `getFromPublicAddress`: a GET of a URL an agent chose (TASK-267b).
//
// No test touches the network. DNS is a spy on `dns.promises.lookup`, and
// `https.request` is replaced by a fake that answers from a route table, so a
// refusal arm can prove no request was made and a success arm can read the
// exact options (pinned lookup, headers) the guard passed to the socket.
const dns = require('dns');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const { getFromPublicAddress, isOutboundUrlRefused } = require('../../../services/outboundUrlGuard');

const refusalOf = (promise) => promise.then(
  () => { throw new Error('expected a refusal, got a response'); },
  (error) => error,
);

// One fake request per call. `route(url, options)` returns { status, headers, chunks }.
const fakeHttps = (route, calls) => (url, options, callback) => {
  const req = new EventEmitter();
  const call = { url: String(url), options, dataListened: false, destroyed: false };
  calls.push(call);
  req.write = () => {};
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
    setImmediate(() => {
      callback(res);
      call.dataListened = res.listenerCount('data') > 0;
      for (const chunk of chunks) {
        if (call.destroyed) return;
        res.push(chunk);
      }
      if (!call.destroyed) res.push(null);
    });
  };
  return req;
};

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

describe('getFromPublicAddress', () => {
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

  describe('refusals, made before any request', () => {
    beforeEach(() => {
      httpsRequestSpy.mockImplementation(() => { throw new Error('no network in refusal tests'); });
    });

    const noRequest = () => {
      expect(httpsRequestSpy).not.toHaveBeenCalled();
      expect(httpRequestSpy).not.toHaveBeenCalled();
    };

    test.each([
      ['http://example.test/page', 'scheme http: is not https'],
      ['ftp://example.test/page', 'scheme ftp: is not https'],
      ['file:///etc/hostname', 'scheme file: is not https'],
      ['https://user:secret@example.test/', 'credentials in URL'],
      ['not a url', 'not a valid URL'],
    ])('%s is refused', async (url, reason) => {
      const error = await refusalOf(getFromPublicAddress(url));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toBe(`outbound URL refused: ${reason}`);
      expect(lookupSpy).not.toHaveBeenCalled();
      noRequest();
    });

    test.each([
      ['10.0.0.5'], ['172.20.1.1'], ['192.168.1.20'], ['100.64.0.9'], ['127.0.0.1'], ['::1'], ['fd00::1'],
    ])('a name resolving to private %s is refused, even with the webhook private-address flag set', async (address) => {
      // The webhook flag lets a local receiver through for postToPublicAddress; it must not open an agent's fetch.
      process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES = 'true';
      lookupSpy.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);

      const error = await refusalOf(getFromPublicAddress('https://page.example.test/'));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toBe(`outbound URL refused: host page.example.test resolves to ${address}, which is not allowed`);
      noRequest();
    });

    test.each([
      ['https://169.254.169.254/latest/meta-data/', 'host 169.254.169.254 resolves to 169.254.169.254, which is not allowed'],
      ['https://[::ffff:169.254.169.254]/', 'host ::ffff:a9fe:a9fe resolves to ::ffff:a9fe:a9fe, which is not allowed'],
      ['https://metadata.google.internal/computeMetadata/v1/', 'host metadata.google.internal is not allowed'],
    ])('the metadata endpoint %s is refused without a lookup', async (url, reason) => {
      const error = await refusalOf(getFromPublicAddress(url));

      expect(error.message).toBe(`outbound URL refused: ${reason}`);
      expect(lookupSpy).not.toHaveBeenCalled();
      noRequest();
    });

    test('a name with one public and one private answer is refused', async () => {
      lookupSpy.mockResolvedValue([...PUBLIC, { address: '10.0.0.5', family: 4 }]);

      const error = await refusalOf(getFromPublicAddress('https://page.example.test/'));

      expect(error.message).toContain('resolves to 10.0.0.5');
      noRequest();
    });
  });

  describe('requests', () => {
    let route;

    beforeEach(() => {
      delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
      route = () => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, chunks: [Buffer.from('hello')] });
      httpsRequestSpy.mockImplementation(fakeHttps((url, options) => route(url, options), calls));
    });

    test('a text/plain page is returned as text, from the final URL, with only the fixed headers', async () => {
      lookupSpy.mockResolvedValue(PUBLIC);

      const result = await getFromPublicAddress('https://page.example.test/a?b=1');

      expect(result).toEqual({
        ok: true, status: 200, contentType: 'text/plain', text: 'hello', truncated: false, url: 'https://page.example.test/a?b=1',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].options.method).toBe('GET');
      expect(calls[0].options.headers).toEqual({
        'User-Agent': 'CommonlyAgentFetch/1.0 (+https://commonly.me)',
        Accept: 'text/html, text/plain;q=0.9, application/json;q=0.9',
      });
      const sent = Object.keys(calls[0].options.headers).map((name) => name.toLowerCase());
      expect(sent).not.toContain('cookie');
      expect(sent).not.toContain('authorization');
    });

    test('the socket is pinned to the checked address: a second DNS answer (rebinding) is never used', async () => {
      // First answer public, any later answer private. The guard resolves once per
      // hop and hands the socket a lookup that returns only the checked address.
      lookupSpy.mockResolvedValueOnce(PUBLIC).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

      await getFromPublicAddress('https://rebind.example.test/');

      expect(lookupSpy).toHaveBeenCalledTimes(1);
      const pinned = calls[0].options.lookup;
      const all = await new Promise((resolve) => pinned('rebind.example.test', { all: true }, (_e, list) => resolve(list)));
      const one = await new Promise((resolve) => pinned('rebind.example.test', {}, (_e, address, family) => resolve({ address, family })));
      expect(all).toEqual(PUBLIC);
      expect(one).toEqual({ address: '93.184.216.34', family: 4 });
    });

    test('text/html is reduced to its text', async () => {
      lookupSpy.mockResolvedValue(PUBLIC);
      route = () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        chunks: [Buffer.from('<html><head><title>T</title><script>steal()</script></head><body><h1>Release notes</h1><p>Fixed &amp; shipped.</p></body></html>')],
      });

      const result = await getFromPublicAddress('https://page.example.test/notes');

      expect(result.contentType).toBe('text/html');
      expect(result.text).toBe('Release notes\nFixed & shipped.');
    });

    test('application/json is returned as its text', async () => {
      lookupSpy.mockResolvedValue(PUBLIC);
      route = () => ({ status: 200, headers: { 'content-type': 'application/json' }, chunks: [Buffer.from('{"version":"1.2.3"}')] });

      const result = await getFromPublicAddress('https://api.example.test/v');

      expect(result).toMatchObject({ ok: true, contentType: 'application/json', text: '{"version":"1.2.3"}' });
    });

    test.each([
      ['image/png'], ['application/octet-stream'], ['application/pdf'], [undefined],
    ])('a 2xx with content type %p is refused before any body byte is read', async (contentType) => {
      lookupSpy.mockResolvedValue(PUBLIC);
      route = () => ({ status: 200, headers: contentType ? { 'content-type': contentType } : {}, chunks: [Buffer.from('BINARY')] });

      const error = await refusalOf(getFromPublicAddress('https://files.example.test/x'));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toBe(`outbound URL refused: content type ${contentType || '(none)'} is not allowed`);
      expect(calls[0].dataListened).toBe(false);
      expect(calls[0].destroyed).toBe(true);
    });

    test('a body over 1 MB is cut off at exactly 1 MB and reported as truncated', async () => {
      lookupSpy.mockResolvedValue(PUBLIC);
      const half = Buffer.alloc(512 * 1024, 'a');
      route = () => ({ status: 200, headers: { 'content-type': 'text/plain' }, chunks: [half, half, half] });

      const result = await getFromPublicAddress('https://big.example.test/');

      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.text)).toBe(1024 * 1024);
      expect(calls[0].destroyed).toBe(true);
    });

    test('a non-2xx final response is returned, not thrown, with no body', async () => {
      lookupSpy.mockResolvedValue(PUBLIC);
      route = () => ({ status: 404, headers: { 'content-type': 'text/html' }, chunks: [Buffer.from('<p>not found</p>')] });

      const result = await getFromPublicAddress('https://page.example.test/missing');

      expect(result).toEqual({
        ok: false, status: 404, contentType: 'text/html', text: '', truncated: false, url: 'https://page.example.test/missing',
      });
    });

    test('a relative redirect is resolved, re-checked and followed', async () => {
      lookupSpy.mockResolvedValue(PUBLIC);
      route = (url) => (url.endsWith('/old')
        ? { status: 301, headers: { location: '/new' } }
        : { status: 200, headers: { 'content-type': 'text/plain' }, chunks: [Buffer.from('moved here')] });

      const result = await getFromPublicAddress('https://page.example.test/old');

      expect(result).toMatchObject({ ok: true, text: 'moved here', url: 'https://page.example.test/new' });
      expect(lookupSpy).toHaveBeenCalledTimes(2);
      expect(calls.map((c) => c.url)).toEqual(['https://page.example.test/old', 'https://page.example.test/new']);
    });

    test('a redirect to a private address is refused before the second request', async () => {
      lookupSpy.mockImplementation(async (host) => (host === 'inside.example.test'
        ? [{ address: '10.1.2.3', family: 4 }]
        : PUBLIC));
      route = () => ({ status: 302, headers: { location: 'https://inside.example.test/admin' } });

      const error = await refusalOf(getFromPublicAddress('https://page.example.test/'));

      expect(error.message).toBe('outbound URL refused: host inside.example.test resolves to 10.1.2.3, which is not allowed');
      expect(calls).toHaveLength(1);
    });

    test.each([
      ['http://page.example.test/plain', 'scheme http: is not https'],
      ['https://169.254.169.254/latest/meta-data/', 'host 169.254.169.254 resolves to 169.254.169.254, which is not allowed'],
    ])('a redirect to %s is refused before the second request', async (location, reason) => {
      lookupSpy.mockResolvedValue(PUBLIC);
      route = () => ({ status: 307, headers: { location } });

      const error = await refusalOf(getFromPublicAddress('https://page.example.test/'));

      expect(error.message).toBe(`outbound URL refused: ${reason}`);
      expect(calls).toHaveLength(1);
    });

    test('a fourth redirect is refused: at most three are followed', async () => {
      lookupSpy.mockResolvedValue(PUBLIC);
      let hop = 0;
      route = () => { hop += 1; return { status: 302, headers: { location: `/hop${hop}` } }; };

      const error = await refusalOf(getFromPublicAddress('https://loop.example.test/'));

      expect(error.message).toBe('outbound URL refused: more than 3 redirects');
      expect(calls).toHaveLength(4);
    });

    test('exactly three redirects are followed to a 200', async () => {
      lookupSpy.mockResolvedValue(PUBLIC);
      route = (url) => {
        const n = Number((url.match(/hop(\d)$/) || [0, 0])[1]);
        return n < 3
          ? { status: 302, headers: { location: `/hop${n + 1}` } }
          : { status: 200, headers: { 'content-type': 'text/plain' }, chunks: [Buffer.from('arrived')] };
      };

      const result = await getFromPublicAddress('https://loop.example.test/hop0');

      expect(result).toMatchObject({ ok: true, text: 'arrived', url: 'https://loop.example.test/hop3' });
      expect(calls).toHaveLength(4);
    });
  });
});
