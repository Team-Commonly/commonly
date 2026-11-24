// Telegram connect-code lifecycle — the bearer secret that binds a chat to a
// Commonly integration via the unauthenticated /commonly-enable webhook.
//
// Because the webhook cannot authenticate the redeemer (no Telegram→Commonly
// identity mapping exists), the code IS the entire proof of ownership. It was
// 24 bits, non-expiring, single-lookup across every outstanding code (ADR-025
// review, 2026-08-26). Now: 128 bits, 10-minute TTL, single-use, and the
// webhook rate-limits redemption attempts per chat, counted in shared Redis.

import crypto from 'crypto';
import type { Options } from 'express-rate-limit';
import { SharedRateLimitStore } from '../middleware/sharedRateLimitStore';

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

// Per-chat budget for /commonly-enable attempts: ENABLE_ATTEMPT_LIMIT tries per
// ENABLE_ATTEMPT_WINDOW_MS. It counts in the same shared Redis store as the
// route limiters (middleware/sharedRateLimitStore.ts), so the budget holds
// across backend processes instead of multiplying by their number. Redis being
// down or slow never refuses a chat: the store falls back to a per-process
// memory count, with the same timeout and logging as every other limiter.
//
// The window is fixed, not sliding: it starts at a chat's first attempt and the
// count resets when it ends, as with express-rate-limit. A refused attempt
// still counts but does not extend the window.
//
// The key is attacker-supplied (any chat id). In Redis each key is hashed and
// carries the window as its expiry; the memory fallback drops a key once its
// window has passed. Neither grows without bound.
const newAttemptStore = (): SharedRateLimitStore => {
  const store = new SharedRateLimitStore({ name: 'telegram-enable-attempt' });
  store.init({ windowMs: ENABLE_ATTEMPT_WINDOW_MS } as Options);
  return store;
};
let attemptStore = newAttemptStore();

export const registerEnableAttempt = async (chatId: string): Promise<boolean> => {
  const { totalHits } = await attemptStore.increment(chatId);
  return totalHits <= ENABLE_ATTEMPT_LIMIT;
};

// For tests: a fresh store, so one case's count never leaks into the next.
export const resetEnableAttempts = (): void => {
  attemptStore.shutdown();
  attemptStore = newAttemptStore();
};

module.exports = {
  CONNECT_CODE_TTL_MS,
  CONNECT_CODE_BYTES,
  ENABLE_ATTEMPT_WINDOW_MS,
  ENABLE_ATTEMPT_LIMIT,
  mintConnectCode,
  isConnectCodeShape,
  isConnectCodeExpired,
  registerEnableAttempt,
  resetEnableAttempts,
};

export {};
