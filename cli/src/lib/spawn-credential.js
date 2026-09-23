/**
 * spawn-credential.js — TASK-102 part B (the cli half of TASK-094).
 *
 * WHAT THIS REPLACES. Every adapter used to hand the child the seat's own
 * runtime token (`ctx.runtimeToken`, sourced from `COMMONLY_AGENT_TOKEN`): one
 * long-lived credential, the full authority of the seat, inherited by every
 * process the child spawns and written to a credential file that outlives the
 * turn. The backend half (TASK-094 PR A, merged as `3e08c328`) can mint a
 * per-spawn child instead — bounded lifetime, named in a ledger, revocable —
 * and this module is the caller that makes that real rather than available.
 *
 * WHY A LEASE AND NOT A SINGLE MINT. The granted TTL is 900s by default
 * (`SPAWN_TTL_MAX_SECONDS`), and a turn can outlive it: a long coding turn
 * would start failing mid-flight with 401s the seat cannot explain, which is
 * strictly worse than the seat token it replaced. So the lease renews at
 * half-life while the child runs (the absolute lifetime is 24h, so renewal is
 * the mechanism the backend already provides for exactly this) and revokes at
 * the end of the turn, which is what bounds a leaked child credential to one
 * turn instead of forever.
 *
 * THE FALLBACK PREDICATE IS ABOUT WHAT A FAILURE TELLS US (vera 71068/`#1823`
 * thread). A **capacity** refusal (429, 5xx, or no HTTP response at all) says
 * the server could not mint *right now* — it says nothing about whether this
 * seat may mint, and the seat token is an authority the seat already holds, so
 * falling back grants nothing new and keeps the seat working. Every **4xx** is
 * a verdict about the caller or the request (401 dead token, 403 not this
 * seat's installation, 400 malformed spawn id, 404/409 ledger conflict): a
 * refusal there must fail closed, because falling back would silently restore
 * the exact authority the refusal was about and make the whole mechanism
 * decorative. `no status` is classified with capacity — the request never got a
 * verdict, so it is an availability fact, not an authorization one.
 *
 * The caller's own identity is never used for its own HTTP call: the lease is
 * minted with the SEAT token over the seat's client, and only the CHILD gets
 * the scoped token. The wrapper keeps polling, claiming and posting with the
 * seat token, which is why `performRun` passes `spawnToken.token` to the
 * adapter and keeps `token` for its client.
 *
 * THE POLICY READ EXISTS SO THE CLAMP IS VISIBLE. `GET /policy` publishes the
 * bounds `clampSpawnTtlSeconds` actually applies (`minTtlSeconds`,
 * `maxTtlSeconds`, `absoluteLifetimeSeconds`). A caller that asks for 3600 used
 * to receive a 900s credential with no way to find out; here the ask is
 * compared against the published cap and the difference is logged once at
 * open. The read is best-effort: a missing policy degrades to sending the ask
 * and letting the server clamp, never to refusing to spawn.
 */

export const SPAWN_CREDENTIAL_BASE = '/api/agents/runtime/spawn-credentials';

// Renew at half the granted lifetime: one renewal is missed and the credential
// still has 450s of headroom at the default TTL, which covers a slow span
// between the timer firing and the request landing.
export const RENEW_AT_FRACTION = 0.5;

// Never renew faster than this. A server that grants a TTL shorter than two
// minutes would otherwise produce a renewal loop tight enough to be its own
// traffic; the floor keeps the loop's cadence a function of our intent rather
// than of an unexpectedly small grant.
export const MIN_RENEW_INTERVAL_MS = 30 * 1000;

/** Capacity (the server could not mint) vs verdict (the server refused). */
export const isCapacityRefusal = (status) => (
  status === undefined || status === null || status === 429 || status >= 500
);

/**
 * The ledger names the spawn, and the name has to be stable per spawn and
 * unique across spawns: the event id is the only identifier the wrapper has
 * that means "this turn" (a session id recurs across turns, an agent name
 * recurs forever). Truncated to the route's `MAX_SPAWN_ID_LENGTH`, keeping the
 * tail — the event id — because the prefix is the part a reader can infer.
 */
export const buildSpawnId = ({ agentName = 'agent', eventId = null, maxLength = 128 } = {}) => {
  const suffix = eventId === null || eventId === undefined ? 'unknown' : String(eventId);
  const prefix = `${agentName}:`;
  const room = Math.max(1, maxLength - prefix.length);
  const keptSuffix = suffix.length > room ? suffix.slice(-room) : suffix;
  return `${prefix}${keptSuffix}`;
};

/**
 * The operator's ask, read from `COMMONLY_SPAWN_TTL_SECONDS`.
 *
 * Unset is the normal case and means "the server's published default" — the
 * cli has no business inventing a lifetime for a credential it does not own.
 * A malformed value degrades to unset rather than to a guess: this knob exists
 * so an operator can discover the cap, and a typo must not become a different
 * number that nobody chose.
 */
export const resolveSpawnTtlSeconds = (env = {}) => {
  const raw = String(env.COMMONLY_SPAWN_TTL_SECONDS || '').trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

/**
 * Best-effort bounds read. Returns null when the route is absent (an older
 * server) or unreachable — the caller then sends its ask unclamped and lets the
 * server's own clamp decide, which is the pre-policy behaviour and never worse.
 */
export const readSpawnPolicy = async ({ client, log = () => {} }) => {
  try {
    const policy = await client.get(`${SPAWN_CREDENTIAL_BASE}/policy`);
    return policy && typeof policy === 'object' ? policy : null;
  } catch (err) {
    log(`spawn credential policy unavailable (${err?.status ?? 'no response'}) — sending the TTL ask unclamped`);
    return null;
  }
};

/**
 * Open one lease. Returns `{ token, credentialId, source, expiresAt, grantedSeconds }`.
 *
 * `source` is `'spawn'` when the child got a scoped credential and
 * `'seat-fallback'` when it got the seat token because the server could not
 * mint. A refusal (a verdict — see the header) throws with
 * `spawnCredentialRefused` set and the status attached, so the caller fails the
 * spawn closed rather than falling back.
 */
export const openSpawnCredential = async ({
  client,
  seatToken,
  spawnId,
  desiredTtlSeconds = null,
  policy = null,
  log = () => {},
}) => {
  const cap = typeof policy?.maxTtlSeconds === 'number' ? policy.maxTtlSeconds : null;
  let ask = desiredTtlSeconds;
  if (typeof ask === 'number' && Number.isFinite(ask)) {
    if (cap !== null && ask > cap) {
      log(`spawn credential: asked for ${ask}s, the server's cap is ${cap}s — asking for ${cap}s instead`);
      ask = cap;
    }
  } else {
    ask = null;
  }

  let minted;
  try {
    minted = await client.post(
      SPAWN_CREDENTIAL_BASE,
      ask === null ? { spawnId } : { spawnId, ttlSeconds: ask },
    );
  } catch (err) {
    const status = err?.status ?? null;
    if (isCapacityRefusal(status === null ? undefined : status)) {
      log(`spawn credential unavailable (${status === null ? 'no response' : `HTTP ${status}`}) — spawning with the seat token`);
      return { token: seatToken, credentialId: null, source: 'seat-fallback', expiresAt: null, grantedSeconds: null };
    }
    const code = err?.body?.code ? ` code=${err.body.code}` : '';
    const refusal = new Error(`spawn credential refused: HTTP ${status}${code}`);
    refusal.spawnCredentialRefused = true;
    refusal.status = status;
    refusal.body = err?.body ?? null;
    throw refusal;
  }

  // A 201 with no usable token is not a credential. Treat it as un-mintable
  // and fall back, rather than handing the child `undefined` — which would
  // look like a scoped credential everywhere downstream while silently being
  // no credential at all. (It is also the shape a stub client returns, so this
  // guard is what keeps a test that does not care about minting on the seat
  // token instead of on nothing.)
  if (typeof minted?.token !== 'string' || !minted.token.trim()) {
    log('spawn credential response carried no token — spawning with the seat token');
    return {
      token: seatToken, credentialId: null, source: 'seat-fallback', expiresAt: null, grantedSeconds: null, reason: 'no-token',
    };
  }

  const grantedSeconds = minted?.expiresAt
    ? Math.max(0, Math.round((new Date(minted.expiresAt).getTime() - Date.now()) / 1000))
    : (typeof ask === 'number' ? ask : cap);
  return {
    token: minted.token,
    credentialId: minted.credentialId || null,
    source: 'spawn',
    expiresAt: minted.expiresAt || null,
    grantedSeconds,
  };
};

/** Renewal cadence for a granted lifetime. */
export const renewIntervalMs = (grantedSeconds) => {
  const half = typeof grantedSeconds === 'number' && grantedSeconds > 0
    ? (grantedSeconds * 1000) * RENEW_AT_FRACTION
    : MIN_RENEW_INTERVAL_MS;
  return Math.max(MIN_RENEW_INTERVAL_MS, Math.round(half));
};

/**
 * A lease owns the credential's lifetime: open, renew while the child runs,
 * revoke when it ends. `setIntervalImpl`/`clearIntervalImpl` are injected so a
 * test can drive the cadence without waiting on wall-clock time.
 */
export const createSpawnCredentialLease = ({
  client,
  seatToken,
  spawnId,
  desiredTtlSeconds = null,
  policy = null,
  log = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) => {
  let credentialId = null;
  let timer = null;
  let grantedSeconds = null;

  const stopRenewal = () => {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };

  const renew = async () => {
    if (!credentialId) return;
    // A renewal extends the SAME credential, so the TTL to ask for is the one
    // the server already granted rather than the caller's original desire: a
    // caller that asked for 3600 and was capped at 900 must not turn every
    // renewal into another request for 3600.
    const ask = typeof grantedSeconds === 'number' && grantedSeconds > 0
      ? Math.floor(grantedSeconds)
      : undefined;
    try {
      await client.post(
        `${SPAWN_CREDENTIAL_BASE}/${credentialId}/renew`,
        ask === undefined ? {} : { ttlSeconds: ask },
      );
      log(`spawn credential renewed (${credentialId})`);
    } catch (err) {
      const status = err?.status ?? null;
      if (isCapacityRefusal(status === null ? undefined : status)) {
        // The credential is still live; we simply could not reach the server.
        // Keep the timer: the next tick is a fresh attempt.
        log(`spawn credential renewal deferred (${status === null ? 'no response' : `HTTP ${status}`})`);
        return;
      }
      // A verdict — expired or revoked. The route's contract is explicit that
      // this is the caller's signal to stop, not to retry harder: a late
      // renewal must not resurrect a dead child.
      stopRenewal();
      log(`spawn credential renewal refused (HTTP ${status}) — the child keeps its remaining lifetime and is not extended`);
    }
  };

  const startRenewal = () => {
    const interval = renewIntervalMs(grantedSeconds);
    timer = setIntervalImpl(() => { renew(); }, interval);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  return {
    async open() {
      const opened = await openSpawnCredential({ client, seatToken, spawnId, desiredTtlSeconds, policy, log });
      credentialId = opened.credentialId;
      grantedSeconds = opened.grantedSeconds;
      if (opened.source === 'spawn' && credentialId) startRenewal();
      log(opened.source === 'spawn'
        ? `spawn credential minted (${credentialId}, granted ${opened.grantedSeconds}s)`
        : 'spawning with the seat token (spawn credential unavailable)');
      return opened;
    },

    /**
     * End the spawn: stop extending it and revoke it. Revocation is
     * best-effort on purpose — the boot sweep (`revoke-orphans`) is the second
     * net, and a failed revoke must never fail a turn that already produced an
     * answer.
     */
    async close() {
      stopRenewal();
      if (!credentialId) return { revoked: false, reason: 'no-credential' };
      const id = credentialId;
      credentialId = null;
      try {
        await client.del(`${SPAWN_CREDENTIAL_BASE}/${id}`);
        log(`spawn credential revoked (${id})`);
        return { revoked: true };
      } catch (err) {
        log(`spawn credential revoke failed (${id}, ${err?.status ?? 'no response'}) — the boot sweep will collect it`);
        return { revoked: false, reason: 'revoke-failed' };
      }
    },

    // Exposed for tests and for a caller that wants the cadence it got.
    get credentialId() { return credentialId; },
    get grantedSeconds() { return grantedSeconds; },
  };
};
