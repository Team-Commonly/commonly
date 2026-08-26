// Connect-code lifecycle: 128-bit, 10-minute TTL, legacy codes (no expiry)
// are dead, and /commonly-enable attempts are rate-limited per chat.
const {
  mintConnectCode, isConnectCodeExpired, registerEnableAttempt, resetEnableAttempts,
  CONNECT_CODE_TTL_MS, ENABLE_ATTEMPT_LIMIT, ENABLE_ATTEMPT_WINDOW_MS,
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
});
