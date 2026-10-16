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

const { addressKey, addressesIn, addressWasGiven } = require('../../../services/webAddressProvenance');

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
});
