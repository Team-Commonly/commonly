// Telegram connect-code lifecycle — the bearer secret that binds a chat to a
// Commonly integration via the unauthenticated /commonly-enable webhook.
//
// Because the webhook cannot authenticate the redeemer (no Telegram→Commonly
// identity mapping exists), the code IS the entire proof of ownership. It was
// 24 bits, non-expiring, single-lookup across every outstanding code (ADR-025
// review, 2026-08-26). Now: 128 bits, 10-minute TTL, single-use, and the
// webhook rate-limits redemption attempts per chat.

import crypto from 'crypto';

export const CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
// The one number the minted code and its shape both come from. Changing the
// entropy without the shape (or the shape without the entropy) refuses every
// real code, so the two are derived from this rather than restated.
export const CONNECT_CODE_BYTES = 16;
export const ENABLE_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const ENABLE_ATTEMPT_LIMIT = 5;

export const mintConnectCode = (now: number = Date.now()): { connectCode: string; connectCodeExpiresAt: Date } => ({
  connectCode: crypto.randomBytes(CONNECT_CODE_BYTES).toString('hex'),
  connectCodeExpiresAt: new Date(now + CONNECT_CODE_TTL_MS),
});

// What a minted code looks like, derived from the minter's own constant rather
// than written out: `mintConnectCode` is the only mint path, and the enable
// webhook cannot authenticate the redeemer, so telling a typo from a guess has
// to happen without touching the database. The route must consult THIS — a
// second regex in the route is a second answer to the same question, and the
// failure it invites is silent (widen the minter, update the pins, every real
// code is refused).
const CONNECT_CODE_SHAPE = new RegExp(`^[0-9a-f]{${CONNECT_CODE_BYTES * 2}}$`);
export const isConnectCodeShape = (code: string): boolean => CONNECT_CODE_SHAPE.test(code);

// A code without an expiry predates the TTL — treat it as expired so legacy
// 24-bit codes can never be redeemed; the owner re-mints from the UI.
export const isConnectCodeExpired = (
  config: { connectCode?: string; connectCodeExpiresAt?: Date | string | null } | undefined,
  now: number = Date.now(),
): boolean => {
  if (!config?.connectCodeExpiresAt) return true;
  return new Date(config.connectCodeExpiresAt).getTime() <= now;
};

// Per-chat sliding window for /commonly-enable attempts. In-memory is enough:
// a code lives 10 minutes and the backend runs one replica; a restart resets
// the window, which is the failure mode we accept over a Redis dependency.
// COUPLING: the "one replica" premise is `replicaCount: 1` in the Helm values
// AND `autoscaling.backend.enabled: false` (values.yaml). Enabling backend
// autoscaling silently makes the effective limit ENABLE_ATTEMPT_LIMIT × replicas
// — move this window to Redis in the same change.
// The key is attacker-supplied (any chat id), so the map is bounded: past
// ENABLE_ATTEMPT_MAX_CHATS keys, every chat whose window has fully slid out is
// evicted before a new key is added. A chat that attempts once and never
// returns costs one slot for one window, not forever.
export const ENABLE_ATTEMPT_MAX_CHATS = 10_000;
const attempts = new Map<string, number[]>();

const sweepIdleChats = (now: number): void => {
  attempts.forEach((stamps, key) => {
    if (!stamps.some((t) => now - t < ENABLE_ATTEMPT_WINDOW_MS)) attempts.delete(key);
  });
};

export const registerEnableAttempt = (chatId: string, now: number = Date.now()): boolean => {
  if (!attempts.has(chatId) && attempts.size >= ENABLE_ATTEMPT_MAX_CHATS) sweepIdleChats(now);
  const recent = (attempts.get(chatId) || []).filter((t) => now - t < ENABLE_ATTEMPT_WINDOW_MS);
  if (recent.length >= ENABLE_ATTEMPT_LIMIT) {
    attempts.set(chatId, recent);
    return false;
  }
  recent.push(now);
  attempts.set(chatId, recent);
  return true;
};

export const resetEnableAttempts = (): void => { attempts.clear(); };

module.exports = {
  CONNECT_CODE_TTL_MS,
  CONNECT_CODE_BYTES,
  ENABLE_ATTEMPT_WINDOW_MS,
  ENABLE_ATTEMPT_LIMIT,
  ENABLE_ATTEMPT_MAX_CHATS,
  mintConnectCode,
  isConnectCodeShape,
  isConnectCodeExpired,
  registerEnableAttempt,
  resetEnableAttempts,
};

export {};
