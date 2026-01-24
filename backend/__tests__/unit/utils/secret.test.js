const { hash, randomSecret, safeEqual } = require('../../../utils/secret');

describe('secret utils', () => {
  test('hash produces deterministic sha256', () => {
    expect(hash('abc')).toBe(hash('abc'));
    expect(hash('abc')).not.toBe(hash('abcd'));
  });

  test('randomSecret returns hex of requested length', () => {
    const s = randomSecret(8);
    expect(s).toHaveLength(16); // 8 bytes -> 16 hex chars
  });

  test('safeEqual handles different lengths', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'b')).toBe(false);
    expect(safeEqual('a', 'aa')).toBe(false);
  });
});
