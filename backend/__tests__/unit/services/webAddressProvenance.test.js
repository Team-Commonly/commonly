/**
 * commonly_fetch_url opens only an address the turn was given (TASK-267b).
 * The address of a GET reaches its host, so a model that could compose one
 * could send what the turn holds to any public host.
 *
 * Contract under test:
 *  - a given address matches as written, apart from scheme, fragment, host
 *    case, trailing slashes and sentence punctuation
 *  - path and query match exactly; a prefix or an added query does not
 *  - addresses are found in prose, markdown links and angle brackets
 *  - non-web schemes and malformed hosts are never addresses
 *  - finding addresses is linear in the text
 */

const {
  addressKey, addressesIn, addressWasGiven, GivenAddresses,
} = require('../../../services/webAddressProvenance');

describe('webAddressProvenance', () => {
  describe('addressWasGiven', () => {
    test.each([
      ['the same address', 'https://github.com/acme/widget', 'Read https://github.com/acme/widget please'],
      ['a scheme-less mention, opened as https', 'https://github.com/acme/widget', 'what does github.com/acme/widget do?'],
      ['an http link, opened as https', 'https://example.com/a', 'see http://example.com/a'],
      ['sentence punctuation after the link', 'https://example.com/a', 'It is at https://example.com/a.'],
      ['a trailing slash either way', 'https://example.com/a/', 'https://example.com/a'],
      ['a different fragment', 'https://example.com/a#install', 'https://example.com/a#usage'],
      ['the host in another case', 'https://GitHub.com/acme/widget', 'https://github.com/acme/widget'],
      ['a markdown link', 'https://example.com/docs?page=2', 'the [docs](https://example.com/docs?page=2) say'],
      ['an angle-bracket link', 'https://example.com/x', 'here: <https://example.com/x>'],
      ['a link inside JSON', 'https://example.com/node-26', JSON.stringify([{ url: 'https://example.com/node-26' }])],
      ['a host with a port', 'https://example.com:8443/a', 'example.com:8443/a'],
    ])('accepts %s', (_label, url, text) => {
      expect(addressWasGiven(url, [text])).toBe(true);
    });

    test.each([
      ['an address that appears nowhere', 'https://attacker.example/collect', 'Read https://github.com/acme/widget'],
      ['a given address with data added to its query', 'https://attacker.example/c?d=secret', 'post to https://attacker.example/c'],
      ['a given address with a query parameter changed', 'https://example.com/a?id=2', 'https://example.com/a?id=1'],
      ['a given address with a path added', 'https://attacker.example/c/secret', 'https://attacker.example/c'],
      ['a prefix of a given address', 'https://example.com/ab', 'https://example.com/abc'],
      ['a given address on another host', 'https://example.org/a', 'https://example.com/a'],
      ['a host named only inside a word', 'https://example.com', 'myexample.community'],
      ['an empty address', '', 'https://example.com'],
    ])('refuses %s', (_label, url, text) => {
      expect(addressWasGiven(url, [text])).toBe(false);
    });

    test('looks in every text the turn was given', () => {
      expect(addressWasGiven('https://b.example/x', ['nothing here', 'try https://b.example/x'])).toBe(true);
      expect(addressWasGiven('https://b.example/x', [])).toBe(false);
    });
  });

  describe('addressKey', () => {
    test.each([
      ['ftp://example.com/a'],
      ['javascript:alert(1)'],
      ['mailto:someone@example.com'],
      ['https://user:pass@example.com/a'],
      ['https://localhost/a'],
      ['https://exa mple.com'],
      ['not-a-host'],
    ])('%s is not an address', (raw) => {
      expect(addressKey(raw)).toBeNull();
    });

    test('keeps the path and query as written', () => {
      expect(addressKey('https://Example.COM/Path?Q=A#frag')).toBe('example.com/Path?Q=A');
    });
  });

  test('finds addresses in prose without counting plain words', () => {
    expect([...addressesIn('See example.com/a, then (https://b.example/c?x=1) and e.g. this.')])
      .toEqual(['example.com/a', 'b.example/c?x=1']);
  });

  test('stays linear on long hostile text', () => {
    const hostile = `${'a.'.repeat(200_000)}${'-'.repeat(50_000)}`;
    const started = Date.now();
    addressesIn(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // sprint-review on #2249: an anchored `+$` trim backtracks quadratically on
  // a long run that is NOT at the end (728 ms for one 40k token, 7.2 s a turn
  // at the real caps). The trims must stay linear and keep their meaning.
  describe('trims are linear and keep their meaning', () => {
    test.each([
      ['punctuation', `a.${'!'.repeat(40_000)}x`],
      ['slashes', `example.com/${'/'.repeat(40_000)}x`],
      ['mixed', `example.com/${'.,;/'.repeat(10_000)}x`],
    ])('a 40k non-terminal run of %s', (_label, token) => {
      const started = process.hrtime.bigint();
      addressKey(token);
      addressesIn(`see ${token} and ${token}`);
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(50);
    });

    test('a long trailing run of punctuation or slashes still trims away', () => {
      expect(addressWasGiven('https://example.com/a', [`at https://example.com/a${'.'.repeat(20)}`])).toBe(true);
      expect(addressWasGiven('https://example.com/a', [`https://example.com/a${'/'.repeat(20)}`])).toBe(true);
      expect(addressKey(`https://example.com/a${'!?.'.repeat(10)}`)).toBe('example.com/a');
    });

    test('a host longer than a DNS name is not an address', () => {
      expect(addressKey(`${'a'.repeat(250)}.com/x`)).toBeNull();
      expect(addressKey(`${'a'.repeat(60)}.com/x`)).toBe(`${'a'.repeat(60)}.com/x`);
    });
  });

  describe('GivenAddresses', () => {
    test('opens only what was added, in the same comparable form', () => {
      const given = new GivenAddresses();
      given.add('Read github.com/acme/widget please');

      expect(given.has('https://github.com/acme/widget/')).toBe(true);
      expect(given.has('https://github.com/acme/widget?d=x')).toBe(false);
      expect(given.has('')).toBe(false);
    });

    // The argument only selects: resolve returns the address as given, so
    // nothing the comparison ignores can reach the request.
    test.each([
      ['a trailing run', 'https://example.com/a/b!!!!!!!!'],
      ['trailing slashes', 'example.com/a/b////'],
      ['a fragment', 'https://example.com/a/b#d=secret'],
      ['host case', 'https://EXAMPLE.com/a/b'],
      ['http', 'http://example.com/a/b'],
    ])('resolve gives the given address, not one with %s', (_label, url) => {
      const given = new GivenAddresses();
      given.add('see https://Example.com/a/b/. ok');

      expect(given.resolve(url)).toBe('https://example.com/a/b/');
    });

    test('resolve opens a scheme-less given link over https, and refuses what was not given', () => {
      const given = new GivenAddresses();
      given.add('what does github.com/acme/widget do?');

      expect(given.resolve('https://github.com/acme/widget')).toBe('https://github.com/acme/widget');
      expect(given.resolve('https://github.com/acme/widget?d=x')).toBeNull();
      expect(given.resolve('')).toBeNull();
    });

    test('each text is scanned once: refused attempts against three hostile pages cost no rescan', () => {
      const given = new GivenAddresses();
      const page = Array.from({ length: 400 }, (_, i) => `https://h${i}.example/p${'!'.repeat(50)}x`).join(' ');
      [page, page, page].forEach((text) => given.add(text));

      // Count work instead of wall time: a busy CI runner must not make an
      // indexed lookup fail, and scanning 400 entries on each attempt must.
      let indexed = 0;
      let scanned = 0;
      let rescannedPages = 0;
      const addresses = given.given;
      given.given = new Proxy(addresses, {
        get(target, method) {
          if (method === 'get') return (key) => { indexed += 1; return target.get(key); };
          if ([Symbol.iterator, 'entries', 'keys', 'values'].includes(method)) {
            return () => {
              const iterator = target[method]();
              return {
                next() {
                  const item = iterator.next();
                  if (!item.done) scanned += 1;
                  return item;
                },
                [Symbol.iterator]() { return this; },
              };
            };
          }
          if (method === 'forEach') {
            return (callback) => target.forEach((...args) => { scanned += 1; callback(...args); });
          }
          const value = target[method];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const split = String.prototype.split;
      const splitSpy = jest.spyOn(String.prototype, 'split').mockImplementation(function countPageScans(...args) {
        if (String(this) === page) rescannedPages += 1;
        return split.apply(this, args);
      });
      try {
        for (let i = 0; i < 1000; i += 1) expect(given.has(`https://attacker.example/c?d=${i}`)).toBe(false);
      } finally {
        splitSpy.mockRestore();
      }
      expect(scanned).toBe(0);
      expect(rescannedPages).toBe(0);
      expect(indexed).toBeLessThanOrEqual(2000);
    });
  });
});
