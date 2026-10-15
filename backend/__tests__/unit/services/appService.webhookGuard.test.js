// App webhook delivery goes through the outbound guard's open-destination
// mode. The real guard runs; DNS is a spy, and the allowed arm posts to a local
// receiver on 127.0.0.1 with OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES set.
jest.mock('../../../models/App', () => ({}));
jest.mock('../../../models/AppInstallation', () => ({}));

const dns = require('dns');
const http = require('http');
const https = require('https');
const AppService = require('../../../services/appService');

const installation = (webhookUrl) => ({
  _id: 'inst-1',
  appId: { webhookUrl },
  targetType: 'pod',
  targetId: 'pod-1',
  tokenHash: 'a'.repeat(64),
});

describe('App webhook delivery is confined to allowed addresses', () => {
  const savedFlag = process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
  let lookupSpy;

  beforeEach(() => {
    delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
    lookupSpy = jest.spyOn(dns.promises, 'lookup');
  });

  afterAll(() => {
    if (savedFlag === undefined) delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
    else process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES = savedFlag;
  });

  test.each([
    ['a private address literal', 'http://10.0.0.5/hook'],
    ['the metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['a name resolving to loopback', 'https://hooks.example.test/hook'],
  ])('%s is refused and no request is made', async (_label, url) => {
    lookupSpy.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    // Fail instead of connecting, so even a broken guard cannot open a socket here.
    const noNetwork = () => { throw new Error('no network in refusal tests'); };
    const httpSpy = jest.spyOn(http, 'request').mockImplementation(noNetwork);
    const httpsSpy = jest.spyOn(https, 'request').mockImplementation(noNetwork);

    const result = await AppService.deliverWebhookByInstallation(installation(url), 'app.installed', { a: 1 });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^outbound URL refused: /);
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  });

  describe('against a local receiver', () => {
    let server;
    let port;
    let received;
    let status;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
          res.writeHead(status);
          res.end();
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      ({ port } = server.address());
    });

    afterAll(() => new Promise((resolve) => server.close(resolve)));

    beforeEach(() => {
      received = [];
      status = 200;
      process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES = 'true';
      lookupSpy.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    });

    test('delivers the signed event to an allowed address', async () => {
      const result = await AppService.deliverWebhookByInstallation(
        installation(`http://hooks.example.test:${port}/hook`), 'app.installed', { a: 1 },
      );

      expect(result).toEqual({ success: true, statusCode: 200 });
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('POST');
      expect(received[0].headers['x-commonly-event']).toBe('app.installed');
      expect(received[0].headers['x-commonly-installation']).toBe('inst-1');
      expect(received[0].headers['x-commonly-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(JSON.parse(received[0].body)).toMatchObject({ event: 'app.installed', installationId: 'inst-1', payload: { a: 1 } });
    });

    test('a non-2xx reply is reported as a failure with its status', async () => {
      status = 500;

      const result = await AppService.deliverWebhookByInstallation(
        installation(`http://hooks.example.test:${port}/hook`), 'app.installed', {},
      );

      expect(result).toEqual({ success: false, reason: 'HTTP 500', statusCode: 500 });
    });
  });
});
