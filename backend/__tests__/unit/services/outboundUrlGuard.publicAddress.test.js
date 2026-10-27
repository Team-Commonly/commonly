// The open-destination mode of the outbound guard: `postToPublicAddress`.
//
// DNS is replaced by a spy on `dns.promises.lookup`, so no name is resolved on
// the real network. Arms that must show a connection actually happening use a
// local HTTP server on 127.0.0.1 with OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES
// set, and reach it through `.test` hostnames that system DNS cannot resolve:
// a request arrives only if the socket used the address the guard checked.
const dns = require('dns');
const http = require('http');
const https = require('https');

const {
  classifyAddress,
  postToPublicAddress,
  isOutboundUrlRefused,
} = require('../../../services/outboundUrlGuard');

const refusalOf = (promise) => promise.then(
  () => { throw new Error('expected a refusal, got a response'); },
  (error) => error,
);

const POST = { headers: { 'Content-Type': 'application/json', 'X-Commonly-Event': 'heartbeat' }, body: '{"n":1}' };

describe('classifyAddress', () => {
  test.each([
    '8.8.8.8', '140.82.112.3', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808',
    // the edges of each refused IPv4 block
    '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0',
    '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0',
    '223.255.255.255', '2000::1',
  ])('%s is public', (address) => {
    expect(classifyAddress(address)).toBe('public');
  });

  test.each([
    '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255',
    '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '::1', 'fc00::1', 'fd12:3456::1',
    // IPv4-mapped and NAT64 forms of private IPv4
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:192.168.1.1', '64:ff9b::a00:1',
  ])('%s is private', (address) => {
    expect(classifyAddress(address)).toBe('private');
  });

  test.each([
    '0.0.0.0', '0.255.255.255', '169.254.169.254', '169.254.0.1', '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255', '::', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'ff02::1',
    // IPv4-mapped forms of reserved IPv4, in both spellings
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:0.0.0.0', '::ffff:255.255.255.255',
    // the deprecated IPv4-compatible block, and anything that is not an address
    '::7f00:1', '::a9fe:a9fe', 'not-an-ip', '',
    // the edge just below unique-local, which is outside global unicast
    'fbff::1',
  ])('%p is reserved', (address) => {
    expect(classifyAddress(address)).toBe('reserved');
  });
});

describe('postToPublicAddress', () => {
  let lookupSpy;
  let httpRequestSpy;
  let httpsRequestSpy;
  const savedFlag = process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;

  beforeEach(() => {
    delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
    lookupSpy = jest.spyOn(dns.promises, 'lookup');
    httpRequestSpy = jest.spyOn(http, 'request');
    httpsRequestSpy = jest.spyOn(https, 'request');
  });

  afterAll(() => {
    if (savedFlag === undefined) delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
    else process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES = savedFlag;
  });

  const noConnection = () => {
    expect(httpRequestSpy).not.toHaveBeenCalled();
    expect(httpsRequestSpy).not.toHaveBeenCalled();
  };

  describe('refusals, with the private-address flag unset (the default)', () => {
    beforeEach(() => {
      // A refusal arm must never open a socket, even against a broken guard:
      // a call fails here instead of reaching the network.
      const noNetwork = () => { throw new Error('no network in refusal tests'); };
      httpRequestSpy.mockImplementation(noNetwork);
      httpsRequestSpy.mockImplementation(noNetwork);
    });

    test.each([
      ['10.0.0.5'], ['172.20.1.1'], ['192.168.1.20'], ['100.64.0.9'], ['127.0.0.1'],
      ['169.254.169.254'], ['0.0.0.0'], ['224.0.0.1'], ['255.255.255.255'],
      ['::1'], ['fd00::1'], ['fe80::1'], ['::ffff:127.0.0.1'], ['::ffff:169.254.169.254'],
    ])('a name resolving to %s is refused without connecting', async (address) => {
      lookupSpy.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);

      const error = await refusalOf(postToPublicAddress('https://hooks.example.test/in', POST));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toBe(`outbound URL refused: host hooks.example.test resolves to ${address}, which is not allowed`);
      expect(lookupSpy).toHaveBeenCalledTimes(1);
      noConnection();
    });

    test('a name with one public and one private answer is refused', async () => {
      lookupSpy.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }]);

      const error = await refusalOf(postToPublicAddress('https://hooks.example.test/in', POST));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toContain('resolves to 10.0.0.5');
      noConnection();
    });

    test.each([
      ['http://127.0.0.1:8080/hook', 'host 127.0.0.1 resolves to 127.0.0.1, which is not allowed'],
      ['http://169.254.169.254/latest/meta-data/', 'host 169.254.169.254 resolves to 169.254.169.254, which is not allowed'],
      ['http://[::1]/hook', 'host ::1 resolves to ::1, which is not allowed'],
      ['http://[::ffff:169.254.169.254]/', 'host ::ffff:a9fe:a9fe resolves to ::ffff:a9fe:a9fe, which is not allowed'],
      ['http://[fe80::1]/', 'host fe80::1 resolves to fe80::1, which is not allowed'],
      ['http://2130706433/', 'host 127.0.0.1 resolves to 127.0.0.1, which is not allowed'],
      ['http://100.64.1.1/', 'host 100.64.1.1 resolves to 100.64.1.1, which is not allowed'],
    ])('the address literal in %s is refused without a lookup or a connection', async (url, reason) => {
      const error = await refusalOf(postToPublicAddress(url, POST));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toBe(`outbound URL refused: ${reason}`);
      expect(lookupSpy).not.toHaveBeenCalled();
      noConnection();
    });

    test('the metadata host is refused by name, before any lookup', async () => {
      lookupSpy.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));

      const error = await refusalOf(postToPublicAddress('http://metadata.google.internal/computeMetadata/v1/', POST));

      expect(error.message).toBe('outbound URL refused: host metadata.google.internal is not allowed');
      expect(lookupSpy).not.toHaveBeenCalled();
      noConnection();
    });

    test.each([
      ['file:///etc/hostname', 'scheme file: is not http or https'],
      ['ftp://hooks.example.test/x', 'scheme ftp: is not http or https'],
      ['gopher://hooks.example.test/', 'scheme gopher: is not http or https'],
      ['data:text/plain,hello', 'scheme data: is not http or https'],
      ['not a url', 'not a valid URL'],
    ])('%s is refused', async (url, reason) => {
      const error = await refusalOf(postToPublicAddress(url, POST));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toBe(`outbound URL refused: ${reason}`);
      noConnection();
    });

    test('a name that does not resolve is refused', async () => {
      lookupSpy.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));

      const error = await refusalOf(postToPublicAddress('https://nowhere.example.test/', POST));

      expect(error.message).toBe('outbound URL refused: host nowhere.example.test does not resolve');
      noConnection();
    });
  });

  describe('connections, against a local receiver', () => {
    let server;
    let port;
    let received;
    let respond;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
          respond(req, res);
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      ({ port } = server.address());
    });

    afterAll(() => new Promise((resolve) => server.close(resolve)));

    beforeEach(() => {
      received = [];
      respond = (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"outcome":"acknowledged"}'); };
      process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES = 'true';
      lookupSpy.mockImplementation(async (host) => {
        if (host === 'hooks.example.test' || host === 'next.example.test') return [{ address: '127.0.0.1', family: 4 }];
        if (host === 'metadata-alias.example.test') return [{ address: '169.254.169.254', family: 4 }];
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      });
    });

    test('posts to the checked address: the request arrives through a name system DNS cannot resolve', async () => {
      const result = await postToPublicAddress(`http://hooks.example.test:${port}/in?x=1`, POST);

      expect(result).toEqual({ ok: true, status: 200, text: '{"outcome":"acknowledged"}' });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ method: 'POST', url: '/in?x=1', body: '{"n":1}' });
      expect(received[0].headers.host).toBe(`hooks.example.test:${port}`);
      expect(received[0].headers['x-commonly-event']).toBe('heartbeat');
      expect(lookupSpy).toHaveBeenCalledTimes(1);
    });

    test('a later DNS answer cannot move the connection: the host is resolved once per hop and pinned', async () => {
      lookupSpy
        .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
        .mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

      const result = await postToPublicAddress(`http://hooks.example.test:${port}/in`, POST);

      expect(result.ok).toBe(true);
      expect(received).toHaveLength(1);
      expect(lookupSpy).toHaveBeenCalledTimes(1);
    });

    test('the flag admits private addresses but never link-local or the metadata host', async () => {
      const byAddress = await refusalOf(postToPublicAddress('http://169.254.169.254/latest/meta-data/', POST));
      const byName = await refusalOf(postToPublicAddress('http://metadata.google.internal/', POST));
      const byResolution = await refusalOf(postToPublicAddress('http://metadata-alias.example.test/', POST));

      [byAddress, byName, byResolution].forEach((error) => expect(isOutboundUrlRefused(error)).toBe(true));
      expect(received).toHaveLength(0);
    });

    test('a 307 is followed with the method and body kept, and the next hop is resolved again', async () => {
      respond = (req, res) => {
        if (req.url === '/in') { res.writeHead(307, { Location: `http://next.example.test:${port}/moved` }); res.end(); return; }
        res.writeHead(200); res.end('{}');
      };

      const result = await postToPublicAddress(`http://hooks.example.test:${port}/in`, POST);

      expect(result.ok).toBe(true);
      expect(received.map((r) => [r.method, r.url, r.body])).toEqual([
        ['POST', '/in', '{"n":1}'],
        ['POST', '/moved', '{"n":1}'],
      ]);
      expect(lookupSpy.mock.calls.map(([host]) => host)).toEqual(['hooks.example.test', 'next.example.test']);
    });

    test('a 302 continues as a GET without the body', async () => {
      respond = (req, res) => {
        if (req.url === '/in') { res.writeHead(302, { Location: '/landing' }); res.end(); return; }
        res.writeHead(200); res.end('ok');
      };

      await postToPublicAddress(`http://hooks.example.test:${port}/in`, POST);

      expect(received[1]).toMatchObject({ method: 'GET', url: '/landing', body: '' });
      expect(received[1].headers['content-type']).toBeUndefined();
    });

    test.each([
      ['an address literal', 'http://169.254.169.254/latest/meta-data/'],
      ['a name resolving to link-local', 'http://metadata-alias.example.test/'],
      ['the metadata host', 'http://metadata.google.internal/'],
      ['a non-http scheme', 'file:///etc/hostname'],
    ])('a redirect to %s is refused after exactly one request', async (_label, location) => {
      respond = (req, res) => { res.writeHead(307, { Location: location }); res.end(); };

      const error = await refusalOf(postToPublicAddress(`http://hooks.example.test:${port}/in`, POST));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(received).toHaveLength(1);
    });

    test('five redirects are followed and the sixth is refused', async () => {
      respond = (req, res) => {
        const n = Number(req.url.split('/').pop()) || 0;
        res.writeHead(307, { Location: `/hop/${n + 1}` });
        res.end();
      };

      const error = await refusalOf(postToPublicAddress(`http://hooks.example.test:${port}/hop/0`, POST));

      expect(error.message).toBe('outbound URL refused: more than 5 redirects');
      expect(received.map((r) => r.url)).toEqual(['/hop/0', '/hop/1', '/hop/2', '/hop/3', '/hop/4', '/hop/5']);
    });

    test('a non-2xx response is returned, not thrown', async () => {
      respond = (req, res) => { res.writeHead(503); res.end('busy'); };

      await expect(postToPublicAddress(`http://hooks.example.test:${port}/in`, POST))
        .resolves.toEqual({ ok: false, status: 503, text: '' });
    });

    test('a response body over 1 MB is not read past the cap', async () => {
      respond = (req, res) => { res.writeHead(200); res.end('a'.repeat((1024 * 1024) + 1)); };

      const error = await refusalOf(postToPublicAddress(`http://hooks.example.test:${port}/in`, POST));

      expect(error.message).toBe('response body exceeds 1048576 bytes');
      expect(isOutboundUrlRefused(error)).toBe(false);
    });

    test('with the flag unset, the same local receiver is refused', async () => {
      delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;

      const error = await refusalOf(postToPublicAddress(`http://hooks.example.test:${port}/in`, POST));

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(received).toHaveLength(0);
    });
  });
});
