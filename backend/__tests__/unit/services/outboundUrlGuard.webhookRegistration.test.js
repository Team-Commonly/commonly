// A webhook URL written by an install, an agent-config PATCH or an app create
// must be https unless the operator sets OUTBOUND_WEBHOOK_ALLOW_HTTP=true
// (TASK-303 F2). Delivery of an already-stored URL is not decided here.
const { webhookUrlRegistrationRefusal } = require('../../../services/outboundUrlGuard');

describe('webhookUrlRegistrationRefusal', () => {
  const saved = process.env.OUTBOUND_WEBHOOK_ALLOW_HTTP;
  afterEach(() => {
    if (saved === undefined) delete process.env.OUTBOUND_WEBHOOK_ALLOW_HTTP;
    else process.env.OUTBOUND_WEBHOOK_ALLOW_HTTP = saved;
  });

  describe('without the operator flag', () => {
    beforeEach(() => { delete process.env.OUTBOUND_WEBHOOK_ALLOW_HTTP; });

    test.each([
      'https://hooks.example.test/cap',
      'HTTPS://hooks.example.test:8443/cap?x=1',
    ])('accepts %s', (url) => {
      expect(webhookUrlRegistrationRefusal(url)).toBeNull();
    });

    test.each([
      'http://hooks.example.test/cap',
      'HTTP://hooks.example.test/cap',
      'ftp://hooks.example.test/cap',
      'file:///etc/passwd',
    ])('refuses %s as not https', (url) => {
      expect(webhookUrlRegistrationRefusal(url)).toBe('webhookUrl must be an https URL');
    });

    test.each(['hooks.example.test/cap', '/cap', ''])('refuses %p as not a URL', (url) => {
      expect(webhookUrlRegistrationRefusal(url)).toBe('webhookUrl is not a valid URL');
    });

    test.each([[{ href: 'https://hooks.example.test' }], [['https://hooks.example.test']], [42]])(
      'refuses a non-string %p',
      (value) => {
        expect(webhookUrlRegistrationRefusal(value)).toBe('webhookUrl must be a string');
      },
    );
  });

  describe('with OUTBOUND_WEBHOOK_ALLOW_HTTP=true', () => {
    beforeEach(() => { process.env.OUTBOUND_WEBHOOK_ALLOW_HTTP = 'true'; });

    test('accepts http as well as https', () => {
      expect(webhookUrlRegistrationRefusal('http://hooks.example.test/cap')).toBeNull();
      expect(webhookUrlRegistrationRefusal('https://hooks.example.test/cap')).toBeNull();
    });

    test('still refuses every other scheme', () => {
      expect(webhookUrlRegistrationRefusal('ftp://hooks.example.test/cap')).toBe('webhookUrl must be an https URL');
    });
  });

  test.each(['1', 'TRUE', 'yes'])('only the exact string "true" turns the flag on, not %p', (value) => {
    process.env.OUTBOUND_WEBHOOK_ALLOW_HTTP = value;
    expect(webhookUrlRegistrationRefusal('http://hooks.example.test/cap')).toBe('webhookUrl must be an https URL');
  });
});
