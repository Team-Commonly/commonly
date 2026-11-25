/**
 * F631: a rate-limited daemon request names its client in the log, once per
 * limiter key per minute, with no secret, IP, query string or body.
 */
const {
  createRateLimitRejectionLog,
  userAgentFamily,
  routeLabel,
} = require('../../../utils/rateLimitLog');

const TOK_KEY = 'tok:0123456789abcdef';
const OTHER_TOK_KEY = 'tok:fedcba9876543210';
const MACHINE_ID = '0123456789abcdef01234567';

const makeReq = (overrides = {}) => ({
  method: 'POST',
  baseUrl: '/api/machines',
  path: `/${MACHINE_ID}/heartbeat`,
  originalUrl: `/api/machines/${MACHINE_ID}/heartbeat?secret=shh`,
  route: { path: '/:id/heartbeat' },
  params: { id: MACHINE_ID },
  rateLimit: { key: TOK_KEY },
  get: (h) => (h.toLowerCase() === 'user-agent' ? 'commonly-cli/1.4.2 (darwin; arm64)' : undefined),
  ...overrides,
});

const setup = (opts = {}) => {
  let clock = 1_000_000;
  const log = jest.fn();
  const logger = createRateLimitRejectionLog('machine', {
    now: () => clock,
    log,
    ...opts,
  });
  return {
    logger,
    log,
    advance: (ms) => { clock += ms; },
  };
};

const fieldsOf = (call) => call[1];

describe('createRateLimitRejectionLog', () => {
  it('logs one line with the expected fields on a first rejection, with a fixed format string', () => {
    const { logger, log } = setup();
    logger(makeReq());
    expect(log).toHaveBeenCalledTimes(1);
    const [format, fields] = log.mock.calls[0];
    expect(format).toBe('[rate-limit] rejected %j');
    expect(fields).toEqual({
      limiter: 'machine',
      route: 'POST /api/machines/:id/heartbeat',
      keyKind: 'tok',
      keyPrefix: '01234567',
      machineDbId: MACHINE_ID,
      ua: 'commonly-cli/1.4.2',
      suppressed: 0,
    });
  });

  it('logs nothing for 50 more rejections inside the minute', () => {
    const { logger, log } = setup();
    logger(makeReq());
    for (let i = 0; i < 50; i += 1) logger(makeReq());
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('carries the suppressed count on the next line after the minute', () => {
    const { logger, log, advance } = setup();
    logger(makeReq());
    for (let i = 0; i < 50; i += 1) { advance(1000); logger(makeReq()); }
    expect(log).toHaveBeenCalledTimes(1);
    advance(10_001);
    logger(makeReq());
    expect(log).toHaveBeenCalledTimes(2);
    expect(fieldsOf(log.mock.calls[1]).suppressed).toBe(50);
    // and the count resets after it is reported
    advance(60_001);
    logger(makeReq());
    expect(fieldsOf(log.mock.calls[2]).suppressed).toBe(0);
  });

  it('logs two keys separately', () => {
    const { logger, log } = setup();
    logger(makeReq());
    logger(makeReq({ rateLimit: { key: OTHER_TOK_KEY } }));
    logger(makeReq());
    expect(log).toHaveBeenCalledTimes(2);
    expect(fieldsOf(log.mock.calls[0]).keyPrefix).toBe('01234567');
    expect(fieldsOf(log.mock.calls[1]).keyPrefix).toBe('fedcba98');
  });

  it('never prints an IP for an ip key', () => {
    const { logger, log } = setup();
    logger(makeReq({ rateLimit: { key: '203.0.113.77' }, ip: '203.0.113.77' }));
    logger(makeReq({ rateLimit: { key: '2001:db8:abcd:12::/56' } }));
    expect(log).toHaveBeenCalledTimes(2);
    for (const call of log.mock.calls) {
      const line = JSON.stringify(call);
      expect(line).not.toMatch(/203\.0\.113|2001:db8/);
      expect(fieldsOf(call).keyKind).toBe('ip');
      expect(fieldsOf(call)).not.toHaveProperty('keyPrefix');
    }
  });

  it('never prints a query string, an Authorization header or a body', () => {
    const { logger, log } = setup();
    logger(makeReq({
      body: { token: 'cm_dmn_bodysecret' },
      get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer cm_dmn_headersecret' : 'x/1'),
    }));
    const line = JSON.stringify(log.mock.calls);
    expect(line).not.toMatch(/secret|shh|Bearer/);
  });

  it('omits machineDbId when :id is not a 24-hex ObjectId', () => {
    const { logger, log } = setup();
    logger(makeReq({ params: { id: 'abcdefghijkl' } }));
    expect(fieldsOf(log.mock.calls[0])).not.toHaveProperty('machineDbId');
  });

  it('falls back to the method and an id-stripped path when there is no matched route', () => {
    const { logger, log } = setup();
    logger(makeReq({ route: undefined, baseUrl: '', path: `/api/machines/${MACHINE_ID}/heartbeat` }));
    expect(fieldsOf(log.mock.calls[0]).route).toBe('POST /api/machines/:id/heartbeat');
  });

  it('keeps the throttle map at or below its cap under 5,000 distinct keys', () => {
    const { logger, log } = setup({ maxKeys: 1000 });
    for (let i = 0; i < 5000; i += 1) {
      logger(makeReq({ rateLimit: { key: `tok:${i.toString(16).padStart(16, '0')}` } }));
      expect(logger.size()).toBeLessThanOrEqual(1000);
    }
    expect(logger.size()).toBe(1000);
    expect(log).toHaveBeenCalledTimes(5000);
  });

  it('prunes entries older than the window before evicting live ones', () => {
    const { logger, advance } = setup({ maxKeys: 3 });
    logger(makeReq({ rateLimit: { key: 'tok:aaaaaaaaaaaaaaaa' } }));
    logger(makeReq({ rateLimit: { key: 'tok:bbbbbbbbbbbbbbbb' } }));
    advance(61_000);
    logger(makeReq({ rateLimit: { key: 'tok:cccccccccccccccc' } }));
    logger(makeReq({ rateLimit: { key: 'tok:dddddddddddddddd' } }));
    expect(logger.size()).toBe(2);
  });

  it('a log sink that throws does not mark the key as logged', () => {
    const { logger, log } = setup();
    log.mockImplementationOnce(() => { throw new Error('sink down'); });
    logger(makeReq());
    logger(makeReq());
    expect(log).toHaveBeenCalledTimes(2);
    expect(fieldsOf(log.mock.calls[1]).suppressed).toBe(0);
  });

  it('a throw on an expired entry keeps its suppressed count for the next line', () => {
    const { logger, log, advance } = setup();
    logger(makeReq());
    for (let i = 0; i < 3; i += 1) logger(makeReq());
    advance(60_001);
    log.mockImplementationOnce(() => { throw new Error('sink down'); });
    logger(makeReq());
    logger(makeReq());
    expect(log).toHaveBeenCalledTimes(3);
    expect(fieldsOf(log.mock.calls[2]).suppressed).toBe(3);
  });

  it('a throw while building the fields leaves the entry untouched', () => {
    const { logger, log } = setup();
    logger(makeReq({ get: () => { throw new Error('bad getter'); } }));
    expect(log).not.toHaveBeenCalled();
    logger(makeReq());
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('labels a missing key none and shares one bucket for keyless rejections', () => {
    const { logger, log, advance } = setup();
    logger(makeReq({ rateLimit: undefined }));
    logger(makeReq({ rateLimit: { key: 42 } }));
    expect(log).toHaveBeenCalledTimes(1);
    expect(fieldsOf(log.mock.calls[0]).keyKind).toBe('none');
    expect(fieldsOf(log.mock.calls[0])).not.toHaveProperty('keyPrefix');
    advance(60_001);
    logger(makeReq({ rateLimit: {} }));
    expect(log).toHaveBeenCalledTimes(2);
    expect(fieldsOf(log.mock.calls[1])).toMatchObject({ keyKind: 'none', suppressed: 1 });
  });

  it('never throws, even on a hostile request object', () => {
    const { logger } = setup();
    const hostile = {};
    Object.defineProperty(hostile, 'rateLimit', { get() { throw new Error('boom'); } });
    expect(() => logger(hostile)).not.toThrow();
  });
});

describe('userAgentFamily', () => {
  it('keeps a leading name/version token', () => {
    expect(userAgentFamily('commonly-cli/1.4.2 (darwin)')).toBe('commonly-cli/1.4.2');
    expect(userAgentFamily('node-fetch/3.3.2')).toBe('node-fetch/3.3.2');
  });

  it('cuts at a newline or control character', () => {
    expect(userAgentFamily('commonly-cli/1.2\r\nX-Injected: yes')).toBe('commonly-cli/1.2');
    expect(userAgentFamily('evil/1.0\u0000\u001b[31mred')).toBe('evil/1.0');
  });

  it('truncates to 40 characters', () => {
    const ua = `${'a'.repeat(30)}/${'1'.repeat(30)}`;
    expect(userAgentFamily(ua)).toHaveLength(40);
  });

  it('gives other for anything that is not name/version', () => {
    expect(userAgentFamily('Mozilla')).toBe('other');
    expect(userAgentFamily('\r\ncommonly-cli/1.2')).toBe('other');
    expect(userAgentFamily('')).toBe('other');
    expect(userAgentFamily(undefined)).toBe('other');
    expect(userAgentFamily('${jndi:ldap://x}/1')).toBe('other');
  });
});

describe('routeLabel', () => {
  it('strips uuid and numeric ids in the fallback path', () => {
    expect(routeLabel({ method: 'GET', path: '/a/550e8400-e29b-41d4-a716-446655440000/b/42' }))
      .toBe('GET /a/:id/b/:id');
  });
});
