/**
 * The CAP request timeout (TASK-338), on its own so modules that only need the
 * number (the long-poll's wait, lib/long-poll.js) don't import the HTTP client.
 * api.js re-exports both names; see its comment for why every request has one.
 *
 * Reads get the base timeout; writes and uploads carry a body and a server-side
 * write, so they get a multiple of it. COMMONLY_CAP_TIMEOUT_MS sets the base.
 */
export const CAP_TIMEOUT_DEFAULT_MS = 30_000;
const TIMEOUT_SCALE = { read: 1, write: 2, upload: 4 };

export const capTimeoutMs = (kind, { baseMs, env = process.env } = {}) => {
  const fromEnv = Number(env.COMMONLY_CAP_TIMEOUT_MS);
  const base = [baseMs, fromEnv].find((value) => Number.isFinite(value) && value > 0)
    ?? CAP_TIMEOUT_DEFAULT_MS;
  return Math.min(base * (TIMEOUT_SCALE[kind] || 1), 2_147_483_647);
};
