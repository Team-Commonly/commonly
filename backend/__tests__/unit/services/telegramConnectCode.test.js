// Connect-code lifecycle: 128-bit, 10-minute TTL, legacy codes (no expiry)
// are dead.
const {
  mintConnectCode, isConnectCodeShape, isConnectCodeExpired, resetEnableAttempts,
  CONNECT_CODE_TTL_MS, CONNECT_CODE_BYTES,
} = require('../../../services/telegramConnectCode');

describe('telegramConnectCode', () => {
  beforeEach(() => resetEnableAttempts());

  it('mints a 128-bit hex code with a 10-minute expiry', () => {
    const now = 1000000;
    const { connectCode, connectCodeExpiresAt } = mintConnectCode(now);
    expect(connectCode).toMatch(/^[0-9a-f]{32}$/);
    expect(connectCodeExpiresAt.getTime()).toBe(now + CONNECT_CODE_TTL_MS);
    expect(mintConnectCode().connectCode).not.toBe(connectCode);
  });

  // TASK-159. The shape is derived from the minter's byte count, so these arms
  // are written against what the minter PRODUCES rather than against a literal
  // width: widening the code cannot leave the predicate refusing real codes.
  describe('isConnectCodeShape', () => {
    it('accepts what the minter produces and refuses one character either side', () => {
      const { connectCode } = mintConnectCode();
      expect(isConnectCodeShape(connectCode)).toBe(true);
      expect(isConnectCodeShape(`${connectCode}a`)).toBe(false);
      expect(isConnectCodeShape(connectCode.slice(0, -1))).toBe(false);
    });

    it('refuses non-hex and uppercase, because the caller lowercases first', () => {
      const { connectCode } = mintConnectCode();
      expect(isConnectCodeShape(connectCode.replace(/[0-9a-f]/, 'z'))).toBe(false);
      expect(isConnectCodeShape(connectCode.toUpperCase())).toBe(false);
    });

    // vera 74641: the title this arm used to carry ("draws its width from the
    // same constant as the minter") claimed a derivation it cannot witness --
    // hex of N bytes is 2N characters whatever the constant is, so it survived
    // every constant mutation. The derivation is carried by `accepts what the
    // minter produces`; what this arm pins is that the code is HEX, which is
    // why its width tracks the byte count.
    it('mints hex, so the code is twice CONNECT_CODE_BYTES wide', () => {
      const { connectCode } = mintConnectCode();
      expect(connectCode).toMatch(/^[0-9a-f]+$/);
      expect(connectCode).toHaveLength(CONNECT_CODE_BYTES * 2);
    });
  });

  it('treats a code with no expiry (legacy 24-bit) as expired', () => {
    expect(isConnectCodeExpired({ connectCode: 'abc123' })).toBe(true);
    expect(isConnectCodeExpired(undefined)).toBe(true);
  });

  it('expires exactly at the deadline', () => {
    const cfg = { connectCodeExpiresAt: new Date(2000) };
    expect(isConnectCodeExpired(cfg, 1999)).toBe(false);
    expect(isConnectCodeExpired(cfg, 2000)).toBe(true);
  });
  // The per-chat attempt budget: telegramConnectCode.sharedAttempts.test.js.
});
