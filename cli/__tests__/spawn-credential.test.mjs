/**
 * spawn-credential.test.mjs — TASK-102 part B.
 *
 * The module's contract, asserted at the seam that matters: what the CHILD is
 * handed, and what happens when the server cannot or will not mint. Every test
 * drives a fake `client` (the same interface `createClient` returns), so the
 * assertions are about behavior rather than about fetch.
 *
 * The fallback predicate is the load-bearing part and is tested in both
 * directions on purpose: capacity (429/5xx/no response) must keep the seat
 * working, and every 4xx verdict must fail closed. A test that only proved the
 * fallback would pass on an implementation that fell back for everything, which
 * is the version that makes this whole mechanism decorative.
 */

import { jest } from '@jest/globals';

const {
  MIN_RENEW_INTERVAL_MS,
  SPAWN_CREDENTIAL_BASE,
  buildSpawnId,
  createSpawnCredentialLease,
  isCapacityRefusal,
  isRouteAbsentRefusal,
  openSpawnCredential,
  readSpawnPolicy,
  renewIntervalMs,
  resolveSpawnTtlSeconds,
  revokeOrphanedSpawnCredentials,
} = await import('../src/lib/spawn-credential.js');

const SEAT = 'cm_agent_seat_token';
const CHILD = 'cm_agent_child_token';
const POLICY = {
  defaultTtlSeconds: 900,
  minTtlSeconds: 60,
  maxTtlSeconds: 900,
  absoluteLifetimeSeconds: 86400,
  maxSpawnIdLength: 128,
};

const httpError = (status, body = null) => {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  err.body = body;
  return err;
};

const mintedAt = (seconds = 900) => new Date(Date.now() + seconds * 1000).toISOString();

const fakeClient = ({ post, get, del } = {}) => ({
  post: post || jest.fn(async () => ({ token: CHILD, credentialId: 'cred-1', expiresAt: mintedAt() })),
  get: get || jest.fn(async () => POLICY),
  del: del || jest.fn(async () => ({ revoked: true })),
});

describe('resolveSpawnTtlSeconds', () => {
  test('unset means the server default, and a malformed value does not become a guess', () => {
    expect(resolveSpawnTtlSeconds({})).toBeNull();
    expect(resolveSpawnTtlSeconds({ COMMONLY_SPAWN_TTL_SECONDS: '   ' })).toBeNull();
    expect(resolveSpawnTtlSeconds({ COMMONLY_SPAWN_TTL_SECONDS: 'soon' })).toBeNull();
    expect(resolveSpawnTtlSeconds({ COMMONLY_SPAWN_TTL_SECONDS: '-60' })).toBeNull();
    expect(resolveSpawnTtlSeconds({ COMMONLY_SPAWN_TTL_SECONDS: '3600' })).toBe(3600);
  });
});

describe('buildSpawnId', () => {
  test('names the spawn after the event and stays inside the route bound', () => {
    expect(buildSpawnId({ agentName: 'kai', eventId: '72120' })).toBe('kai:72120');
    expect(buildSpawnId({ agentName: 'kai', eventId: null })).toBe('kai:unknown');
    const long = buildSpawnId({ agentName: 'kai', eventId: 'x'.repeat(400) });
    expect(long.length).toBe(128);
    // The TAIL is the event id, so truncation keeps the identifying part.
    expect(long.endsWith('x')).toBe(true);
  });

  test('the bound is on the WHOLE id, not on the suffix (vera 72149)', () => {
    // The first version bounded only the suffix, so a long enough agent name
    // produced an id over the route's 128 limit — `invalid_spawn_id` → 400 →
    // fail closed, i.e. a name that makes its own seat unspawnable. Latent
    // today (longest live instanceId is 25), which is why it is pinned here.
    const longName = buildSpawnId({ agentName: 'a'.repeat(200), eventId: 'batch-evt-1' });
    expect(longName.length).toBeLessThanOrEqual(128);
    expect(longName.length).toBe(128);
    // The event id is kept whole when the name is what had to give: it is what
    // makes the ledger row unique across turns, and the name is inferable.
    expect(longName.endsWith(':batch-evt-1')).toBe(true);

    // A gigantic event id still cannot escape the bound, even though the name
    // has no room left to give.
    const bothLong = buildSpawnId({ agentName: 'b'.repeat(200), eventId: 'y'.repeat(200) });
    expect(bothLong.length).toBe(128);

    // A name at the real fleet maximum is untouched, so nothing about today's
    // seats changes shape.
    expect(buildSpawnId({ agentName: 'a'.repeat(25), eventId: 'batch-evt-1' }))
      .toBe(`${'a'.repeat(25)}:batch-evt-1`);
  });
});

describe('isRouteAbsentRefusal', () => {
  test('an UNTYPED 404 is a missing route; a typed 404 is a verdict', () => {
    // The mint's own refusals always carry a code (`not_found` → 404 in
    // REFUSAL_STATUS), so the body is what separates the two cases.
    expect(isRouteAbsentRefusal(404, null)).toBe(true);
    expect(isRouteAbsentRefusal(404, {})).toBe(true);
    expect(isRouteAbsentRefusal(404, { message: 'Not Found' })).toBe(true);
    expect(isRouteAbsentRefusal(404, { code: 'not_found' })).toBe(false);
    expect(isRouteAbsentRefusal(400, { code: 'invalid_spawn_id' })).toBe(false);
    expect(isRouteAbsentRefusal(500, null)).toBe(false);
    expect(isRouteAbsentRefusal(undefined, null)).toBe(false);
  });
});

describe('isCapacityRefusal', () => {
  test('capacity is 429, 5xx and no response; every other status is a verdict', () => {
    expect([429, 500, 502, 503].map(isCapacityRefusal)).toEqual([true, true, true, true]);
    expect([undefined, null].map(isCapacityRefusal)).toEqual([true, true]);
    expect([400, 401, 403, 404, 409, 422].map(isCapacityRefusal)).toEqual([false, false, false, false, false, false]);
  });
});

describe('readSpawnPolicy', () => {
  test('reads the published bounds', async () => {
    const client = fakeClient();
    await expect(readSpawnPolicy({ client })).resolves.toEqual(POLICY);
    expect(client.get).toHaveBeenCalledWith(`${SPAWN_CREDENTIAL_BASE}/policy`);
  });

  test('a missing route or an unreachable server degrades to null rather than blocking a spawn', async () => {
    const lines = [];
    const client = fakeClient({ get: jest.fn(async () => { throw httpError(404); }) });
    await expect(readSpawnPolicy({ client, log: (l) => lines.push(l) })).resolves.toBeNull();
    expect(lines.join('\n')).toContain('policy unavailable');
  });
});

describe('openSpawnCredential', () => {
  test('mints a scoped credential and hands the CHILD token, never the seat token', async () => {
    const client = fakeClient();
    const opened = await openSpawnCredential({
      client, seatToken: SEAT, spawnId: 'kai:72120', policy: POLICY,
    });
    expect(opened.token).toBe(CHILD);
    expect(opened.token).not.toBe(SEAT);
    expect(opened.source).toBe('spawn');
    expect(opened.credentialId).toBe('cred-1');
    expect(opened.grantedSeconds).toBeGreaterThan(880);
    expect(client.post).toHaveBeenCalledWith(SPAWN_CREDENTIAL_BASE, { spawnId: 'kai:72120' });
  });

  test('a TTL above the published cap is asked for at the cap, and the clamp is named', async () => {
    const lines = [];
    const client = fakeClient();
    await openSpawnCredential({
      client,
      seatToken: SEAT,
      spawnId: 'kai:72120',
      desiredTtlSeconds: 3600,
      policy: POLICY,
      log: (l) => lines.push(l),
    });
    expect(client.post).toHaveBeenCalledWith(
      SPAWN_CREDENTIAL_BASE,
      { spawnId: 'kai:72120', ttlSeconds: 900 },
    );
    // The whole point of publishing the bound: the caller can find out.
    expect(lines.join('\n')).toContain('asked for 3600s, the server\'s cap is 900s');
  });

  test.each([429, 500, 503])('capacity (%s) falls back to the seat token and says so', async (status) => {
    const lines = [];
    const client = fakeClient({ post: jest.fn(async () => { throw httpError(status); }) });
    const opened = await openSpawnCredential({
      client, seatToken: SEAT, spawnId: 'kai:72120', policy: POLICY, log: (l) => lines.push(l),
    });
    expect(opened.token).toBe(SEAT);
    expect(opened.source).toBe('seat-fallback');
    expect(opened.credentialId).toBeNull();
    expect(lines.join('\n')).toContain(`spawn credential unavailable (HTTP ${status})`);
  });

  test('no HTTP response at all counts as capacity, because no verdict was reached', async () => {
    const client = fakeClient({ post: jest.fn(async () => { throw new Error('fetch failed'); }) });
    const opened = await openSpawnCredential({ client, seatToken: SEAT, spawnId: 'kai:72120', policy: POLICY });
    expect(opened.source).toBe('seat-fallback');
    expect(opened.token).toBe(SEAT);
  });

  test.each([400, 401, 403, 409])('a verdict (%s) fails closed instead of falling back', async (status) => {
    const client = fakeClient({ post: jest.fn(async () => { throw httpError(status, { code: 'spawn_not_permitted' }); }) });
    await expect(openSpawnCredential({
      client, seatToken: SEAT, spawnId: 'kai:72120', policy: POLICY,
    })).rejects.toMatchObject({ spawnCredentialRefused: true, status });
  });

  test('a TYPED 404 is this seat being refused and fails closed', async () => {
    const client = fakeClient({ post: jest.fn(async () => { throw httpError(404, { code: 'not_found', message: 'spawn not found' }); }) });
    await expect(openSpawnCredential({
      client, seatToken: SEAT, spawnId: 'kai:72120', policy: POLICY,
    })).rejects.toMatchObject({ spawnCredentialRefused: true, status: 404 });
  });

  test('an UNTYPED 404 is a backend without the route, and it falls back (wren 72152)', async () => {
    // Express's default page, not a verdict: the mint contract never emits an
    // untyped 404. Failing this closed would stop every spawn on a fleet
    // deployed before the route existed and re-deliver forever — worse than the
    // seat token every seat used before this module existed.
    const lines = [];
    const client = fakeClient({ post: jest.fn(async () => { throw httpError(404, { message: 'Cannot POST /api/agents/runtime/spawn-credentials' }); }) });
    const opened = await openSpawnCredential({
      client, seatToken: SEAT, spawnId: 'kai:72120', policy: POLICY, log: (l) => lines.push(l),
    });
    expect(opened).toMatchObject({ token: SEAT, source: 'seat-fallback', reason: 'route-absent' });
    expect(lines.join('\n')).toContain('route absent on this backend');
  });

  test('a 201 with no token is treated as un-mintable, not as a credential', async () => {
    const client = fakeClient({ post: jest.fn(async () => ({})) });
    const opened = await openSpawnCredential({ client, seatToken: SEAT, spawnId: 'kai:72120', policy: POLICY });
    expect(opened).toMatchObject({ token: SEAT, source: 'seat-fallback', reason: 'no-token' });
  });
});

describe('renewIntervalMs', () => {
  test('half the granted lifetime, with a floor for an unexpectedly short grant', () => {
    expect(renewIntervalMs(900)).toBe(450000);
    expect(renewIntervalMs(60)).toBe(MIN_RENEW_INTERVAL_MS);
    expect(renewIntervalMs(undefined)).toBe(MIN_RENEW_INTERVAL_MS);
  });
});

describe('createSpawnCredentialLease', () => {
  const leaseFor = (client, overrides = {}) => {
    const timers = [];
    const cleared = [];
    const lease = createSpawnCredentialLease({
      client,
      seatToken: SEAT,
      spawnId: 'kai:72120',
      policy: POLICY,
      setIntervalImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearIntervalImpl: (id) => cleared.push(id),
      ...overrides,
    });
    return { lease, timers, cleared };
  };

  test('renews the SAME credential at half-life, asking for the granted TTL rather than the original ask', async () => {
    const client = fakeClient();
    const { lease, timers } = leaseFor(client, { desiredTtlSeconds: 3600 });
    await lease.open();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(450000);

    client.post.mockClear();
    await timers[0].fn();
    expect(client.post).toHaveBeenCalledWith(`${SPAWN_CREDENTIAL_BASE}/cred-1/renew`, { ttlSeconds: 900 });
  });

  test('a refused renewal stops the loop; a capacity failure keeps it', async () => {
    const lines = [];
    const refusal = fakeClient();
    refusal.post
      .mockResolvedValueOnce({ token: CHILD, credentialId: 'cred-1', expiresAt: mintedAt() })
      .mockRejectedValueOnce(httpError(409, { code: 'spawn_credential_revoked' }));
    const a = leaseFor(refusal, { log: (l) => lines.push(l) });
    await a.lease.open();
    await a.timers[0].fn();
    expect(a.cleared).toHaveLength(1);
    expect(lines.join('\n')).toContain('renewal refused (HTTP 409)');

    const capacity = fakeClient();
    capacity.post
      .mockResolvedValueOnce({ token: CHILD, credentialId: 'cred-1', expiresAt: mintedAt() })
      .mockRejectedValueOnce(httpError(503));
    const b = leaseFor(capacity);
    await b.lease.open();
    await b.timers[0].fn();
    expect(b.cleared).toHaveLength(0);

    // A renewal 404 with no code is read the SAME way the mint reads an untyped
    // 404 — route absent, not a verdict about this credential — so the loop keeps
    // its timer. The credential keeps its remaining lifetime either way, so the
    // choice only decides whether a route that comes back is picked up.
    const routeAbsent = fakeClient();
    routeAbsent.post
      .mockResolvedValueOnce({ token: CHILD, credentialId: 'cred-1', expiresAt: mintedAt() })
      .mockRejectedValueOnce(httpError(404, { message: 'Cannot POST /renew' }));
    const c = leaseFor(routeAbsent, { log: (l) => lines.push(l) });
    await c.lease.open();
    await c.timers[0].fn();
    expect(c.cleared).toHaveLength(0);
    expect(lines.join('\n')).toContain('renewal deferred (route absent');
  });

  test('close revokes once, clears the timer, and is idempotent', async () => {
    const client = fakeClient();
    const { lease, cleared } = leaseFor(client);
    await lease.open();
    await expect(lease.close()).resolves.toEqual({ revoked: true });
    expect(client.del).toHaveBeenCalledWith(`${SPAWN_CREDENTIAL_BASE}/cred-1`);
    expect(cleared).toHaveLength(1);
    client.del.mockClear();
    await expect(lease.close()).resolves.toEqual({ revoked: false, reason: 'no-credential' });
    expect(client.del).not.toHaveBeenCalled();
  });

  test('a failed revoke is reported, not thrown — cleanup must not fail a finished turn', async () => {
    const lines = [];
    const client = fakeClient({ del: jest.fn(async () => { throw httpError(500); }) });
    const { lease } = leaseFor(client, { log: (l) => lines.push(l) });
    await lease.open();
    await expect(lease.close()).resolves.toEqual({ revoked: false, reason: 'revoke-failed' });
    expect(lines.join('\n')).toContain('boot sweep will collect it');
  });

  test('a fallback lease opens nothing, renews nothing and revokes nothing', async () => {
    const client = fakeClient({ post: jest.fn(async () => { throw httpError(503); }) });
    const { lease, timers } = leaseFor(client);
    const opened = await lease.open();
    expect(opened.source).toBe('seat-fallback');
    expect(timers).toHaveLength(0);
    await lease.close();
    expect(client.del).not.toHaveBeenCalled();
  });
});

describe('revokeOrphanedSpawnCredentials', () => {
  // The second net behind `close()`. It is only a net if it is actually called,
  // which is the point wren's read made: `close()`'s comment claimed a boot
  // sweep that nothing invoked.
  test('sweeps at boot and reports what it collected', async () => {
    const lines = [];
    const client = fakeClient({ post: jest.fn(async () => ({ revoked: 3 })) });
    const result = await revokeOrphanedSpawnCredentials({ client, log: (l) => lines.push(l) });
    expect(client.post).toHaveBeenCalledWith(`${SPAWN_CREDENTIAL_BASE}/revoke-orphans`, {});
    expect(result).toEqual({ ok: true, revoked: 3 });
    expect(lines.join('\n')).toContain('boot sweep revoked 3 orphan(s)');
  });

  test('an empty sweep is not an error and says nothing happened', async () => {
    const lines = [];
    const client = fakeClient({ post: jest.fn(async () => ({})) });
    const result = await revokeOrphanedSpawnCredentials({ client, log: (l) => lines.push(l) });
    expect(result).toEqual({ ok: true, revoked: null });
    expect(lines.join('\n')).toContain('boot sweep found no orphans');
  });

  test('a failed sweep is reported, never thrown — a boot must not depend on it', async () => {
    const lines = [];
    const absent = fakeClient({ post: jest.fn(async () => { throw httpError(404, { message: 'Cannot POST /revoke-orphans' }); }) });
    await expect(revokeOrphanedSpawnCredentials({ client: absent, log: (l) => lines.push(l) }))
      .resolves.toEqual({ ok: false, reason: 'sweep-failed' });

    const unreachable = fakeClient({ post: jest.fn(async () => { throw new Error('fetch failed'); }) });
    await expect(revokeOrphanedSpawnCredentials({ client: unreachable, log: (l) => lines.push(l) }))
      .resolves.toEqual({ ok: false, reason: 'sweep-failed' });
    expect(lines.join('\n')).toContain('boot sweep skipped (404)');
    expect(lines.join('\n')).toContain('boot sweep skipped (no response)');
  });
});
