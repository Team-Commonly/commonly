// Connect-code lifecycle: 128-bit, 10-minute TTL, legacy codes (no expiry)
// are dead, and /commonly-enable attempts are rate-limited per chat.
const {
  mintConnectCode, isConnectCodeShape, isConnectCodeExpired, registerEnableAttempt, resetEnableAttempts,
  CONNECT_CODE_TTL_MS, CONNECT_CODE_BYTES, ENABLE_ATTEMPT_LIMIT, ENABLE_ATTEMPT_WINDOW_MS,
  ENABLE_ATTEMPT_MAX_CHATS,
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

    it('draws its width from the same constant as the minter', () => {
      expect(mintConnectCode().connectCode).toHaveLength(CONNECT_CODE_BYTES * 2);
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

  it('allows N attempts per chat per window, then refuses until the window slides', () => {
    for (let i = 0; i < ENABLE_ATTEMPT_LIMIT; i += 1) expect(registerEnableAttempt('42', 0)).toBe(true);
    expect(registerEnableAttempt('42', 1)).toBe(false);
    expect(registerEnableAttempt('43', 1)).toBe(true); // other chats unaffected
    expect(registerEnableAttempt('42', ENABLE_ATTEMPT_WINDOW_MS + 1)).toBe(true);
  });

  // The key is any chat id an attacker chooses, so the map cannot grow without
  // bound: once the cap is reached, chats whose window has slid out are evicted
  // before a new key is admitted — and a chat still inside its window keeps
  // its count, so the sweep never resets a live limiter.
  it('evicts idle chats at the cap and keeps a live window intact', () => {
    for (let i = 0; i < ENABLE_ATTEMPT_LIMIT; i += 1) registerEnableAttempt('hot', 0);
    for (let i = 0; i < ENABLE_ATTEMPT_MAX_CHATS - 1; i += 1) registerEnableAttempt(`idle-${i}`, 0);
    // Cap reached; a new key one window later triggers the sweep.
    const later = ENABLE_ATTEMPT_WINDOW_MS - 1;
    expect(registerEnableAttempt('hot', later)).toBe(false); // still limited within its window
    expect(registerEnableAttempt('new', ENABLE_ATTEMPT_WINDOW_MS + 1)).toBe(true);
    // Everything from t=0 has slid out and was evicted; 'new' is the only key.
    expect(registerEnableAttempt('idle-0', ENABLE_ATTEMPT_WINDOW_MS + 1)).toBe(true);
    for (let i = 0; i < ENABLE_ATTEMPT_LIMIT - 1; i += 1) registerEnableAttempt('idle-0', ENABLE_ATTEMPT_WINDOW_MS + 1);
    expect(registerEnableAttempt('idle-0', ENABLE_ATTEMPT_WINDOW_MS + 1)).toBe(false);
  });
});
