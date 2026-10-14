// The guard every server-side fetch of a caller-supplied URL goes through.
// `fetch` is the global one, spied on per test: no request leaves the process,
// and "no request was made" is asserted directly on the spy.
const {
  fetchTextFromAllowedHost,
  isOutboundUrlRefused,
} = require('../../../services/outboundUrlGuard');

const ALLOWED = new Map([
  ['github.com', 'https://github.com/'],
  ['raw.githubusercontent.com', 'https://raw.githubusercontent.com/'],
]);
const OPTIONS = { allowedOrigins: ALLOWED, maxBytes: 1024 };

const redirectTo = (location, status = 302) => new Response(null, { status, headers: { location } });

const refusalOf = (promise) => promise.then(
  () => { throw new Error('expected a refusal, got a response'); },
  (error) => error,
);

describe('outbound URL guard', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  test('fetches an allowed https host, with redirects left to the guard and a live deadline', async () => {
    fetchSpy.mockResolvedValue(new Response('# skill'));

    const result = await fetchTextFromAllowedHost('https://raw.githubusercontent.com/o/r/main/SKILL.md', {
      ...OPTIONS,
      headers: { 'User-Agent': 'commonly-app' },
    });

    expect(result).toEqual({ ok: true, status: 200, text: '# skill' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://raw.githubusercontent.com/o/r/main/SKILL.md');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ 'User-Agent': 'commonly-app' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  test('requests the caller\'s constant origin for the host, carrying only the path and query', async () => {
    // The origin here deliberately differs from the parsed host, so the request
    // URL can only have come from the map: a guard that sent the parsed URL
    // would request github.com. The fragment is dropped (it is never sent).
    fetchSpy
      .mockResolvedValueOnce(redirectTo('/o/r/next?page=2'))
      .mockResolvedValueOnce(new Response('# mapped'));

    const result = await fetchTextFromAllowedHost('https://github.com/o/r/start?ref=main#readme', {
      allowedOrigins: new Map([['github.com', 'https://mapped-origin.test/']]),
      maxBytes: 1024,
    });

    expect(result.text).toBe('# mapped');
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      'https://mapped-origin.test/o/r/start?ref=main',
      // The redirect hop is rebuilt the same way, resolved against the parsed URL.
      'https://mapped-origin.test/o/r/next?page=2',
    ]);
  });

  // [url, the reason the refusal must give]. The reason is asserted so that each
  // arm is refused by the check it names, not by an earlier one.
  test.each([
    // loopback
    ['https://127.0.0.1/', 'host 127.0.0.1 is not allowed'],
    ['https://localhost/', 'host localhost is not allowed'],
    ['https://[::1]/', 'host [::1] is not allowed'],
    // RFC 1918
    ['https://10.0.0.1/', 'host 10.0.0.1 is not allowed'],
    ['https://172.16.0.1/', 'host 172.16.0.1 is not allowed'],
    ['https://192.168.0.1/', 'host 192.168.0.1 is not allowed'],
    // link-local and the metadata endpoint, by address and by name
    ['https://169.254.169.254/latest/meta-data/', 'host 169.254.169.254 is not allowed'],
    ['https://metadata.google.internal/computeMetadata/v1/', 'host metadata.google.internal is not allowed'],
    ['https://[fe80::1]/', 'host [fe80::1] is not allowed'],
    // CGNAT 100.64/10
    ['https://100.64.0.1/', 'host 100.64.0.1 is not allowed'],
    // unspecified
    ['https://0.0.0.0/', 'host 0.0.0.0 is not allowed'],
    ['https://[::]/', 'host [::] is not allowed'],
    // multicast and broadcast
    ['https://224.0.0.1/', 'host 224.0.0.1 is not allowed'],
    ['https://255.255.255.255/', 'host 255.255.255.255 is not allowed'],
    // IPv6 unique-local fc00::/7
    ['https://[fc00::1]/', 'host [fc00::1] is not allowed'],
    ['https://[fd12:3456::1]/', 'host [fd12:3456::1] is not allowed'],
    // IPv4-mapped IPv6 (the URL parser normalises these to hex groups)
    ['https://[::ffff:127.0.0.1]/', 'host [::ffff:7f00:1] is not allowed'],
    ['https://[::ffff:169.254.169.254]/', 'host [::ffff:a9fe:a9fe] is not allowed'],
    ['https://[::ffff:10.0.0.1]/', 'host [::ffff:a00:1] is not allowed'],
    // other spellings of an IPv4 address, normalised by the URL parser
    ['https://2130706433/', 'host 127.0.0.1 is not allowed'],
    ['https://0x7f.0.0.1/', 'host 127.0.0.1 is not allowed'],
    // in-cluster service names
    ['https://kubernetes.default.svc/', 'host kubernetes.default.svc is not allowed'],
    ['https://backend/', 'host backend is not allowed'],
    // names that contain an allowed host without being one
    ['https://github.com.example.net/', 'host github.com.example.net is not allowed'],
    ['https://evilgithub.com/', 'host evilgithub.com is not allowed'],
    ['https://github.com./', 'host github.com. is not allowed'],
    // an allowed host with a port, or with credentials in front of another host
    ['https://github.com:8443/', 'non-default port 8443'],
    ['https://user:pass@github.com/', 'credentials in URL'],
    ['https://github.com@169.254.169.254/', 'credentials in URL'],
  ])('refuses %s before making any request', async (url, reason) => {
    const error = await refusalOf(fetchTextFromAllowedHost(url, OPTIONS));

    expect(isOutboundUrlRefused(error)).toBe(true);
    expect(error.message).toBe(`outbound URL refused: ${reason}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['http://github.com/o/r', 'scheme http: is not https'],
    ['file:///etc/hostname', 'scheme file: is not https'],
    ['ftp://github.com/o/r', 'scheme ftp: is not https'],
    ['gopher://github.com/', 'scheme gopher: is not https'],
    ['data:text/plain,hello', 'scheme data: is not https'],
    ['ws://github.com/o/r', 'scheme ws: is not https'],
    ['not a url', 'not a valid URL'],
    ['', 'not a valid URL'],
  ])('refuses the non-https URL %p before making any request', async (url, reason) => {
    const error = await refusalOf(fetchTextFromAllowedHost(url, OPTIONS));

    expect(isOutboundUrlRefused(error)).toBe(true);
    expect(error.message).toBe(`outbound URL refused: ${reason}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['http://169.254.169.254/latest/meta-data/', 'scheme http: is not https'],
    ['https://169.254.169.254/latest/meta-data/', 'host 169.254.169.254 is not allowed'],
    ['https://metadata.google.internal/', 'host metadata.google.internal is not allowed'],
    ['https://[::ffff:169.254.169.254]/', 'host [::ffff:a9fe:a9fe] is not allowed'],
    ['//10.0.0.1/internal', 'host 10.0.0.1 is not allowed'],
    ['http://github.com/o/r', 'scheme http: is not https'],
  ])('refuses a redirect from an allowed host to %s without requesting it', async (location, reason) => {
    fetchSpy.mockResolvedValueOnce(redirectTo(location));

    const error = await refusalOf(fetchTextFromAllowedHost('https://github.com/o/r/raw/main/SKILL.md', OPTIONS));

    expect(isOutboundUrlRefused(error)).toBe(true);
    expect(error.message).toBe(`outbound URL refused: ${reason}`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://github.com/o/r/raw/main/SKILL.md');
  });

  test('follows a redirect that stays on allowed hosts, resolving a relative Location', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirectTo('https://raw.githubusercontent.com/o/r/main/SKILL.md', 301))
      .mockResolvedValueOnce(redirectTo('/o/renamed/main/SKILL.md', 307))
      .mockResolvedValueOnce(new Response('# moved skill'));

    const result = await fetchTextFromAllowedHost('https://github.com/o/r/raw/main/SKILL.md', OPTIONS);

    expect(result).toEqual({ ok: true, status: 200, text: '# moved skill' });
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      'https://github.com/o/r/raw/main/SKILL.md',
      'https://raw.githubusercontent.com/o/r/main/SKILL.md',
      'https://raw.githubusercontent.com/o/renamed/main/SKILL.md',
    ]);
    fetchSpy.mock.calls.forEach(([, init]) => expect(init.redirect).toBe('manual'));
  });

  test('follows five redirects and refuses the sixth, asserted on the literal count', async () => {
    const hop = (n) => `https://github.com/o/r/hop-${n}`;
    for (let n = 1; n <= 6; n += 1) fetchSpy.mockResolvedValueOnce(redirectTo(hop(n)));

    const error = await refusalOf(fetchTextFromAllowedHost(hop(0), OPTIONS));

    expect(isOutboundUrlRefused(error)).toBe(true);
    expect(error.message).toBe('outbound URL refused: more than 5 redirects');
    // The first request plus five followed redirects; the sixth Location is never requested.
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(fetchSpy.mock.calls.map(([url]) => url)).not.toContain(hop(6));
  });

  test('five redirects that end in a response are within the limit', async () => {
    const hop = (n) => `https://github.com/o/r/hop-${n}`;
    for (let n = 1; n <= 5; n += 1) fetchSpy.mockResolvedValueOnce(redirectTo(hop(n)));
    fetchSpy.mockResolvedValueOnce(new Response('# five hops'));

    const result = await fetchTextFromAllowedHost(hop(0), OPTIONS);

    expect(result.text).toBe('# five hops');
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  test('reads a body of exactly maxBytes, and rejects one byte more without calling it a refusal', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('a'.repeat(1024)));
    await expect(fetchTextFromAllowedHost('https://github.com/o/r', OPTIONS))
      .resolves.toEqual({ ok: true, status: 200, text: 'a'.repeat(1024) });

    fetchSpy.mockResolvedValueOnce(new Response('a'.repeat(1025)));
    const error = await refusalOf(fetchTextFromAllowedHost('https://github.com/o/r', OPTIONS));
    expect(error.message).toBe('response body exceeds 1024 bytes');
    expect(isOutboundUrlRefused(error)).toBe(false);
  });

  test('returns a non-2xx final response, and a 3xx with no Location, for the caller to handle', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(fetchTextFromAllowedHost('https://github.com/o/r', OPTIONS))
      .resolves.toEqual({ ok: false, status: 404, text: '' });

    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(fetchTextFromAllowedHost('https://github.com/o/r', OPTIONS))
      .resolves.toEqual({ ok: false, status: 302, text: '' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('a refusal reason is bounded to 200 characters, since callers log it', async () => {
    const longHost = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example`;

    const error = await refusalOf(fetchTextFromAllowedHost(`https://${longHost}/`, OPTIONS));

    expect(isOutboundUrlRefused(error)).toBe(true);
    expect(error.message).toBe(`outbound URL refused: ${`host ${longHost} is not allowed`.slice(0, 200)}`);
    expect(error.message).toHaveLength('outbound URL refused: '.length + 200);
  });

  test('isOutboundUrlRefused is false for errors the guard did not raise', () => {
    expect(isOutboundUrlRefused(new Error('outbound URL refused: forged'))).toBe(false);
    expect(isOutboundUrlRefused(null)).toBe(false);
    expect(isOutboundUrlRefused('OUTBOUND_URL_REFUSED')).toBe(false);
  });
});
