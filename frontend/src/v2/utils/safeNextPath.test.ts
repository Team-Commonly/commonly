import { pathOfLocation, safeNextPath } from './safeNextPath';

// The re-engagement email links straight to a deep link, and login has to carry
// it through every sign-in path without becoming an open redirect.
describe('safeNextPath', () => {
  test('keeps a same-origin path with its query and hash', () => {
    expect(safeNextPath('/v2/agents/byo?mode=hosted')).toBe('/v2/agents/byo?mode=hosted');
    expect(safeNextPath('/v2/pods/abc#message-12')).toBe('/v2/pods/abc#message-12');
    expect(safeNextPath('/')).toBe('/');
  });

  test.each([
    ['protocol-relative', '//evil.example/x'],
    ['backslash, which browsers read as //', '/\\evil.example/x'],
    ['absolute URL', 'https://evil.example/x'],
    ['javascript: URL', 'javascript:alert(1)'],
    ['a control character the parser could strip into //', '/\t/evil.example'],
    ['a dot segment that normalises to //', '/.//evil.example/x'],
    ['a parent segment that normalises to //', '/x/..//evil.example'],
    ['an encoded dot segment that normalises to //', '/%2e//evil.example'],
    ['a dot segment before a backslash', '/./\\evil.example'],
    ['a relative path', 'v2/agents'],
    ['empty', ''],
  ])('refuses %s', (_label, raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });

  test('refuses anything that is not a string', () => {
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath({ pathname: '/v2' })).toBeNull();
  });

  test('pathOfLocation joins a router location, query and hash included', () => {
    expect(pathOfLocation({ pathname: '/v2/agents/byo', search: '?mode=hosted', hash: '' }))
      .toBe('/v2/agents/byo?mode=hosted');
    expect(pathOfLocation({ pathname: '/v2/pods/abc' })).toBe('/v2/pods/abc');
    expect(pathOfLocation(undefined)).toBeNull();
  });
});
