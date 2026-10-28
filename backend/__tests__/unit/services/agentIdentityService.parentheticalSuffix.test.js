jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../models/User', () => ({}));

const { endsWithParenthetical } = require('../../../services/agentIdentityService');

// The check that lets an already-suffixed name ("Pixel (Pixel-Demo)") pass
// through the collision resolver unchanged. It replaced a regex, and must
// answer exactly as that regex did on every trimmed name.
describe('endsWithParenthetical', () => {
  const previous = (name) => /\([^)]+\)\s*$/.test(name);

  it('answers as the regex it replaced on every trimmed name up to 7 characters over ( ) a', () => {
    const alphabet = ['(', ')', 'a'];
    const names = [];
    let level = [''];
    for (let length = 1; length <= 7; length += 1) {
      level = level.flatMap((name) => alphabet.map((ch) => name + ch));
      names.push(...level);
    }

    expect(names).toHaveLength(3279);
    names.forEach((name) => {
      expect([name, endsWithParenthetical(name)]).toEqual([name, previous(name)]);
    });
  });

  it.each([
    ['Pixel (Pixel-Demo)', true],
    ['Pixel ( Demo )', true],
    ['Guide', false],
    ['Pixel ()', false],
    ['Pixel (a) b', false],
    ['x(a()', true],
  ])('%j → %s', (name, expected) => {
    expect(endsWithParenthetical(name)).toBe(expected);
  });

  it('answers a 200,000-character name quickly', () => {
    const name = '('.repeat(200000);
    const started = Date.now();

    expect(endsWithParenthetical(name)).toBe(false);
    expect(endsWithParenthetical(`${name})`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
