// TASK-172 slice 3b: the refresh fence's LEASE, witnessed against the real
// `Integration` schema on a real mongod.
//
// The sibling suite (`hostedMcpCredential.test.js`) injects `deps.row`, so a
// lease modelled in its fake would only ever witness the fake's idea of a
// conditional update. This file injects everything EXCEPT the row: the real
// `findOneAndUpdate` filter runs, so the three takeable states of the lease
// (absent, released-as-null, elapsed), the `$set` that takes it, and the strict
// subdocument's declaration of the path are MEASURED rather than assumed.
//
// The defect it exists for: `refreshGeneration` stops a caller holding a STALE
// pre-image, not one holding a FRESH one. A call that reads the row after the
// winner's bump and before its commit sees a generation nobody has consumed yet,
// bumps from it, wins its OWN fence, and spends the same single-use refresh
// token twice — while its error mark, which genuinely holds the current
// generation, lands and bricks a Connection no member caused.

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const {
  credentialFor,
  defaultRowDeps,
  HostedMcpCredentialError,
  REFRESH_LEASE_MS,
  WINNER_WAIT_MS,
} = require('../../../services/hostedMcpCredentialService');
const {
  HOSTED_MCP_ACCESS_TOKEN,
  HOSTED_MCP_REFRESH_TOKEN,
} = require('../../../services/connectorSecretKinds');
const connectorSecrets = require('../../../services/connectorSecrets');
const ConnectorSecret = require('../../../models/ConnectorSecret');
const { secretWriteGeneration } = require('../../../services/hostedMcpSecretGeneration');

const ENTRY = { id: 'linear', issuer: 'https://mcp.linear.app', clientId: 'client-id' };
const ACCESS_REF = 'ref-access';
const REFRESH_REF = 'ref-refresh';
const T0 = new Date('2026-09-29T12:00:00.000Z').getTime();

let mongod;
let Integration;
/** A virtual clock: `sleep` advances it, so a deadline is reachable instantly. */
let clock;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Integration = require('../../../models/Integration').default;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(() => { clock = T0; });

/** A connected hosted row whose access token expired an hour ago. */
const seedRow = async (config = {}) => {
  const row = await Integration.create({
    type: 'hosted-mcp',
    podId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    status: 'connected',
    config: {
      entryId: 'linear',
      credentialRef: ACCESS_REF,
      refreshTokenRef: REFRESH_REF,
      refreshGeneration: 3,
      expiresAt: new Date(T0 - 3600 * 1000),
      ...config,
    },
  });
  return String(row._id);
};

/** The row as a caller holds it: the pre-image it read, never a live handle. */
const preImage = async (id) => Integration.findById(id).lean();

const live = async (id) => Integration.findById(id).lean();

const secretStore = () => {
  const secrets = new Map([[ACCESS_REF, 'old-access'], [REFRESH_REF, 'old-refresh']]);
  return {
    secrets,
    deps: {
      now: () => new Date(clock),
      sleep: async (ms) => { clock += ms; },
      entryFor: () => ENTRY,
      clientIdFor: () => 'client-id',
      secrets: {
        get: async (ref) => secrets.get(ref),
        put: async (_id, spec, material) => {
          if (!material) throw new Error('empty material');
          // Upsert on (integrationId, kind): the ref is STABLE across puts,
          // which is why the loser cannot detect the winner by a changed ref.
          const ref = spec.kind === HOSTED_MCP_REFRESH_TOKEN.kind ? REFRESH_REF : ACCESS_REF;
          secrets.set(ref, material);
          return ref;
        },
        revoke: async (ref) => { if (ref) secrets.delete(ref); },
      },
    },
  };
};

/**
 * The secret store is a STORE: both callers in a race read and write the same
 * one, which is why the arms below build it once per test and derive both dep
 * sets from it. A per-caller store would let a loser "serve the winner's token"
 * out of a map the winner never wrote to, and look green while proving nothing.
 */
const depsWith = (store, over = {}) => ({ ...store.deps, ...over });

/** A gate whose release is controlled by the test, to hold the winner mid-flight. */
const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
};

/**
 * The winner's TWO seams — its won bump and its commit — observed AT the seam
 * instead of polled from outside them.
 *
 * `deps.row` is replaced wholesale when it is overridden — the deps merge is one
 * level deep — and this suite's store injects no row at all, so the base has to
 * be the service's own `defaultRowDeps()`. The wrappers then delegate to the REAL
 * conditional updates, so the fence under test is unchanged.
 *
 * Resolving on a WON bump is what makes the mid-flight pre-image deterministic:
 * the winner cannot reach its vendor call until the update has returned, and it
 * cannot commit until the arm opens its own gate.
 *
 * The COMMIT seam exists because the loser's budget is virtual while the
 * winner's progress is not. `sleep` advances this file's `clock`, so a poll loop
 * can spend the whole `WINNER_WAIT_MS` in microseconds of real time and refuse
 * `credential_refreshing` while the winner is still writing the row — measured:
 * 4 failures in 8 isolated runs of this arm before the loser's first poll was
 * made to wait here instead. A budget that expires faster than the work it waits
 * for is not a budget.
 *
 * If the winner never wins its bump this promise never resolves, and the arm
 * fails on jest's `testTimeout` instead of asserting something false.
 */
const fenceSignal = (store, over = {}) => {
  const bumped = gate();
  const committed = gate();
  const real = defaultRowDeps();
  const deps = depsWith(store, {
    ...over,
    row: {
      ...real,
      bumpGeneration: async (id, from, now, authority, publishedAuthority) => {
        const won = await real.bumpGeneration(id, from, now, authority, publishedAuthority);
        if (won) bumped.open();
        return won;
      },
      commit: async (id, generation, fields) => {
        const result = await real.commit(id, generation, fields);
        committed.open();
        return result;
      },
    },
  });
  return { deps, bumped, committed };
};

test('a caller that reads the row mid-flight loses the fence instead of winning its own', async () => {
  const id = await seedRow();
  const winner = gate();
  let vendorCalls = 0;
  const refreshAtVendor = async () => {
    vendorCalls += 1;
    if (vendorCalls === 1) await winner.promise;
    return { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 };
  };

  const store = secretStore();
  const { deps, bumped, committed } = fenceSignal(store, { refreshAtVendor });
  const first = credentialFor(await preImage(id), deps);
  await bumped.promise;
  const midFlight = await preImage(id);
  // The lease is ON THE ROW: this is the strict subdocument write landing, and
  // the value a second caller's filter has to see.
  expect(midFlight.config.refreshingUntil).toBeInstanceOf(Date);

  let opened = false;
  const second = credentialFor(midFlight, depsWith(store, {
    refreshAtVendor,
    // The loser's first poll is the moment the winner is allowed to finish, and
    // then it WAITS for that finish instead of spending its budget: this sleep
    // advances the virtual clock, so polling on it refuses `credential_refreshing`
    // in microseconds of real time while the winner is still writing the row.
    // Waiting at the commit seam makes the outcome turn on the store's state, which
    // is what this arm is about; the deadline keeps its deterministic witness in
    // `a live lease is not takeable` below.
    sleep: async (ms) => {
      if (!opened) {
        opened = true;
        winner.open();
        await committed.promise;
        return;
      }
      clock += ms;
    },
  }));

  const [winnerResult, loserResult] = await Promise.all([first, second]);

  // The whole point: the single-use refresh token is spent ONCE.
  expect(vendorCalls).toBe(1);
  expect(winnerResult.token).toBe('new-access');
  expect(loserResult.token).toBe('new-access');

  const after = await live(id);
  expect(after.status).toBe('connected');
  expect(after.config.refreshGeneration).toBe(4);
  expect(after.config.refreshingUntil).toBeNull();
  expect(after.config.expiresAt.getTime()).toBeGreaterThan(clock);
});

test('an elapsed lease is takeable, and the late winner\'s commit is refused', async () => {
  const id = await seedRow();
  const slow = gate();
  let vendorCalls = 0;
  const slowVendor = async () => {
    vendorCalls += 1;
    await slow.promise;
    return { accessToken: 'a-access', refreshToken: 'a-refresh', expiresIn: 3600 };
  };

  const store = secretStore();
  const { deps, bumped } = fenceSignal(store, { refreshAtVendor: slowVendor });
  const lateWinner = credentialFor(await preImage(id), deps);
  // The same instrument as the arm above, for the same reason: the landing is a
  // signal, so this arm has no wall-clock wait and nothing that can expire.
  await bumped.promise;

  // Only the lease bounds a winner that never returns; past it the fence is
  // takeable, which is what stops the fix trading a double-spend for a
  // permanently stranded row. The offset is a LITERAL, and the constant is
  // asserted as a value: an arm that computed its boundary from the constant
  // under test would move with any mutant of it, and a lease of a billion
  // milliseconds would then pass an arm written to witness its expiry.
  expect(REFRESH_LEASE_MS).toBe(30 * 1000);
  clock = T0 + 30 * 1000 + 1;
  const secondCall = await credentialFor(await preImage(id), depsWith(store, {
    refreshAtVendor: async () => {
      vendorCalls += 1;
      return { accessToken: 'b-access', refreshToken: 'b-refresh', expiresIn: 7200 };
    },
  }));
  expect(secondCall.token).toBe('b-access');
  expect(vendorCalls).toBe(2);
  const during = await live(id);
  expect(during.config.refreshGeneration).toBe(5);

  slow.open();
  await lateWinner;

  const after = await live(id);
  // The late commit matched nothing, so the winning pair is not overwritten.
  expect(after.config.refreshGeneration).toBe(5);
  expect(after.config.refreshingUntil).toBeNull();
  expect(after.config.expiresAt.getTime()).toBe(new Date(clock).getTime() + 7200 * 1000);
});

test('a live lease is not takeable: the caller refuses retryably and touches nothing', async () => {
  // A literal lease, for the same reason as the boundary above: a fixture built
  // from the constant under test moves with its mutant.
  const id = await seedRow({ refreshingUntil: new Date(T0 + 30 * 1000) });
  const refreshAtVendor = jest.fn(async () => ({ accessToken: 'x', expiresIn: 3600 }));
  let sleeps = 0;

  await expect(credentialFor(await preImage(id), depsWith(secretStore(), {
    refreshAtVendor,
    sleep: async (ms) => { sleeps += 1; clock += ms; },
  }))).rejects.toMatchObject({ code: 'credential_refreshing', retryable: true });

  expect(refreshAtVendor).not.toHaveBeenCalled();
  expect(sleeps).toBeGreaterThan(0);
  expect(clock - T0).toBeGreaterThanOrEqual(WINNER_WAIT_MS);

  // A loser does no harm: no refresh, no mark, no revoke, no bump.
  const after = await live(id);
  expect(after.status).toBe('connected');
  expect(after.config.refreshGeneration).toBe(3);
  expect(after.errorMessage ?? null).toBeNull();
});

test('a lease released by its winner is takeable by the next refresh', async () => {
  const id = await seedRow();
  const store = secretStore();
  let vendorCalls = 0;
  const refreshAtVendor = async () => {
    vendorCalls += 1;
    // A lifetime exactly on the skew margin: stale at the same instant the row
    // is written, so the second call must enter the fence without the clock
    // moving. That keeps this arm about the RELEASED lease rather than the
    // elapsed one — `an elapsed lease is takeable` is the sibling arm.
    return { accessToken: `access-${vendorCalls}`, refreshToken: 'new-refresh', expiresIn: 60 };
  };

  const first = await credentialFor(await preImage(id), depsWith(store, { refreshAtVendor }));
  expect(first.token).toBe('access-1');
  const released = await live(id);
  expect(released.config.refreshingUntil).toBeNull();

  // No clock movement, deliberately: a live lease would still be live, so the
  // only reason the next bump can match is that the winner released it.
  expect(clock).toBe(T0);
  const second = await credentialFor(await preImage(id), depsWith(store, { refreshAtVendor }));
  expect(second.token).toBe('access-2');
  expect(vendorCalls).toBe(2);

  const after = await live(id);
  expect(after.config.refreshGeneration).toBe(5);
  expect(after.config.refreshingUntil).toBeNull();
  expect(after.status).toBe('connected');
});

test('a definitive refusal marks the row and releases the lease in the same write', async () => {
  const id = await seedRow();
  const refreshAtVendor = async () => {
    throw new HostedMcpCredentialError('connection_error', 'refresh refused (400 invalid_grant)', false);
  };

  await expect(credentialFor(await preImage(id), depsWith(secretStore(), { refreshAtVendor })))
    .rejects.toMatchObject({ code: 'connection_error' });

  const after = await live(id);
  expect(after.status).toBe('error');
  expect(after.errorMessage).toMatch(/invalid_grant/);
  expect(after.config.refreshGeneration).toBe(4);
  // Released on every exit, or the row would read as "in flight" to the next call.
  expect(after.config.refreshingUntil).toBeNull();
});

test('a retryable failure keeps the lease, and the expiry is what releases it', async () => {
  const id = await seedRow();
  const store = secretStore();
  let vendorCalls = 0;
  const unreachable = async () => {
    vendorCalls += 1;
    if (vendorCalls === 1) {
      throw new HostedMcpCredentialError('refresh_unreachable', 'refresh refused (500)', true);
    }
    return { accessToken: 'later-access', refreshToken: 'later-refresh', expiresIn: 3600 };
  };

  await expect(credentialFor(await preImage(id), depsWith(store, { refreshAtVendor: unreachable })))
    .rejects.toMatchObject({ code: 'refresh_unreachable', retryable: true });

  // The lease stays held ON PURPOSE — see the comment on the retryable throw. The
  // generation was bumped, nothing was marked, and the Connection is still usable,
  // so the only thing standing between callers and the vendor is this lease.
  const held = await live(id);
  expect(held.status).toBe('connected');
  expect(held.config.refreshGeneration).toBe(4);
  expect(held.config.refreshingUntil).toBeInstanceOf(Date);
  expect(held.config.refreshingUntil.getTime()).toBe(T0 + 30 * 1000);

  // While it is held, a queued caller is told to come back and does NOT touch the
  // vendor. `vendorCalls` is the only witness that can tell this apart from a
  // caller that hammered a vendor which had just answered 500.
  const queued = await preImage(id);
  await expect(credentialFor(queued, depsWith(store, { refreshAtVendor: unreachable })))
    .rejects.toMatchObject({ code: 'credential_refreshing', retryable: true });
  expect(vendorCalls).toBe(1);

  // The expiry is the whole recovery path, so it has to be witnessed: without
  // this half, "keeps the lease" and "strands the Connection" are the same
  // observation, which is exactly what the comment claims they are not.
  clock = T0 + 30 * 1000 + 1;
  const recovered = await credentialFor(await preImage(id), depsWith(store, { refreshAtVendor: unreachable }));
  expect(recovered.token).toBe('later-access');
  expect(vendorCalls).toBe(2);

  const after = await live(id);
  expect(after.status).toBe('connected');
  expect(after.config.refreshGeneration).toBe(5);
  expect(after.config.refreshingUntil).toBeNull();
});

// TASK-405 (rhea, #2534): two refreshes inside ONE authorization share the same
// authGeneration. The store's fence used to order writes by authGeneration alone,
// so a superseded refresh could replace a newer refresh's pair behind the same
// stable refs. The write generation now orders refreshes too, and the real
// connector secret store refuses the stale writer.
test('a superseded refresh cannot overwrite a newer refresh inside the same authorization', async () => {
  const savedKeys = process.env.CONNECTOR_SECRET_KEYS;
  const savedActive = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  process.env.CONNECTOR_SECRET_KEYS = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
  await ConnectorSecret.init();
  try {
    const row = await Integration.create({
      type: 'hosted-mcp',
      podId: new mongoose.Types.ObjectId(),
      createdBy: new mongoose.Types.ObjectId(),
      status: 'connected',
      config: {
        entryId: 'linear',
        authGeneration: 1,
        refreshGeneration: 3,
        expiresAt: new Date(T0 - 3600 * 1000),
      },
    });
    const id = String(row._id);
    // The authorization's own pair, written at its callback's write generation.
    const access0 = await connectorSecrets.put(id, HOSTED_MCP_ACCESS_TOKEN, 'access-0', secretWriteGeneration(1, 0));
    const refresh0 = await connectorSecrets.put(id, HOSTED_MCP_REFRESH_TOKEN, 'refresh-0', secretWriteGeneration(1, 0));
    await Integration.updateOne(
      { _id: row._id },
      { $set: { 'config.credentialRef': access0, 'config.refreshTokenRef': refresh0 } },
    );

    const atPause = gate();
    const releaseA = gate();
    const realSecrets = {
      get: connectorSecrets.get,
      put: connectorSecrets.put,
      revoke: connectorSecrets.revoke,
    };
    // A pauses immediately before its FIRST secret write, the access token.
    const pausedA = {
      ...realSecrets,
      put: async (integrationId, spec, material, writeGeneration) => {
        atPause.open();
        await releaseA.promise;
        return connectorSecrets.put(integrationId, spec, material, writeGeneration);
      },
    };
    const store = {
      deps: {
        now: () => new Date(clock),
        sleep: async (ms) => { clock += ms; },
        entryFor: () => ENTRY,
        clientIdFor: () => 'client-id',
        secrets: realSecrets,
      },
    };

    const { deps: depsA, bumped } = fenceSignal(store, {
      secrets: pausedA,
      refreshAtVendor: async () => ({ accessToken: 'access-A', refreshToken: 'refresh-A', expiresIn: 3600 }),
    });
    const callA = credentialFor(await preImage(id), depsA);
    callA.catch(() => {}); // awaited below, after the release
    await bumped.promise;
    await atPause.promise;

    // Past A's 30s lease: B is a legitimate second refresh of the same authorization.
    clock = T0 + 31 * 1000;
    const b = await credentialFor(await preImage(id), depsWith(store, {
      refreshAtVendor: async () => ({ accessToken: 'access-B', refreshToken: 'refresh-B', expiresIn: 7200 }),
    }));
    expect(b.token).toBe('access-B');
    expect((await live(id)).config.refreshGeneration).toBe(5);

    // Release A. Its writes are generation 4 of this authorization; the store
    // already holds generation 5, so the refresh must be refused, not published.
    releaseA.open();
    await expect(callA).rejects.toThrow(/newer connector authorization/);

    const after = await live(id);
    expect(after.status).toBe('connected');
    expect(after.config.refreshGeneration).toBe(5);
    expect(await connectorSecrets.get(after.config.credentialRef)).toBe('access-B');
    expect(await connectorSecrets.get(after.config.refreshTokenRef)).toBe('refresh-B');
  } finally {
    process.env.CONNECTOR_SECRET_KEYS = savedKeys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = savedActive;
  }
});

// TASK-405 (sable, #2534 c850750c): a NON-rotating refresh B advanced only the
// access secret, so a superseded refresh A could still write its refresh token
// after B committed. Both secrets now advance on every refresh.
test('a superseded refresh cannot write its refresh token after a non-rotating newer refresh', async () => {
  const savedKeys = process.env.CONNECTOR_SECRET_KEYS;
  const savedActive = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  process.env.CONNECTOR_SECRET_KEYS = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
  await ConnectorSecret.init();
  try {
    const row = await Integration.create({
      type: 'hosted-mcp',
      podId: new mongoose.Types.ObjectId(),
      createdBy: new mongoose.Types.ObjectId(),
      status: 'connected',
      config: {
        entryId: 'linear',
        authGeneration: 1,
        refreshGeneration: 3,
        expiresAt: new Date(T0 - 3600 * 1000),
      },
    });
    const id = String(row._id);
    const access0 = await connectorSecrets.put(id, HOSTED_MCP_ACCESS_TOKEN, 'access-0', secretWriteGeneration(1, 0));
    const refresh0 = await connectorSecrets.put(id, HOSTED_MCP_REFRESH_TOKEN, 'refresh-0', secretWriteGeneration(1, 0));
    await Integration.updateOne(
      { _id: row._id },
      { $set: { 'config.credentialRef': access0, 'config.refreshTokenRef': refresh0 } },
    );

    const atPause = gate();
    const releaseA = gate();
    const realSecrets = {
      get: connectorSecrets.get,
      put: connectorSecrets.put,
      revoke: connectorSecrets.revoke,
    };
    // A pauses before its SECOND write, the refresh secret, after its access write landed.
    const pausedA = {
      ...realSecrets,
      put: async (integrationId, spec, material, writeGeneration) => {
        if (spec.kind === HOSTED_MCP_REFRESH_TOKEN.kind) {
          atPause.open();
          await releaseA.promise;
        }
        return connectorSecrets.put(integrationId, spec, material, writeGeneration);
      },
    };
    const store = {
      deps: {
        now: () => new Date(clock),
        sleep: async (ms) => { clock += ms; },
        entryFor: () => ENTRY,
        clientIdFor: () => 'client-id',
        secrets: realSecrets,
      },
    };

    const { deps: depsA, bumped } = fenceSignal(store, {
      secrets: pausedA,
      refreshAtVendor: async () => ({ accessToken: 'access-A', refreshToken: 'refresh-A', expiresIn: 3600 }),
    });
    const callA = credentialFor(await preImage(id), depsA);
    callA.catch(() => {});
    await bumped.promise;
    await atPause.promise;

    // Past A's lease. B does NOT rotate: the vendor returns no refresh token.
    clock = T0 + 31 * 1000;
    const b = await credentialFor(await preImage(id), depsWith(store, {
      refreshAtVendor: async () => ({ accessToken: 'access-B', expiresIn: 7200 }),
    }));
    expect(b.token).toBe('access-B');
    expect((await live(id)).config.refreshGeneration).toBe(5);

    releaseA.open();
    await expect(callA).rejects.toThrow(/newer connector authorization/);

    const after = await live(id);
    expect(after.status).toBe('connected');
    expect(after.config.refreshGeneration).toBe(5);
    expect(await connectorSecrets.get(after.config.credentialRef)).toBe('access-B');
    expect(await connectorSecrets.get(after.config.refreshTokenRef)).toBe('refresh-0');
  } finally {
    process.env.CONNECTOR_SECRET_KEYS = savedKeys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = savedActive;
  }
});

// TASK-405 (sable, #2534 28c6a7c1): the non-rotating B must write back the token
// it refreshed WITH, read before its vendor call. A superseded A whose refresh
// write lands while B's vendor call is in flight must not be sealed into B's pair.
test('a non-rotating refresh seals the token it refreshed with, not one a superseded refresh wrote mid-flight', async () => {
  const savedKeys = process.env.CONNECTOR_SECRET_KEYS;
  const savedActive = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  process.env.CONNECTOR_SECRET_KEYS = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
  await ConnectorSecret.init();
  try {
    const row = await Integration.create({
      type: 'hosted-mcp',
      podId: new mongoose.Types.ObjectId(),
      createdBy: new mongoose.Types.ObjectId(),
      status: 'connected',
      config: {
        entryId: 'linear',
        authGeneration: 1,
        refreshGeneration: 3,
        expiresAt: new Date(T0 - 3600 * 1000),
      },
    });
    const id = String(row._id);
    const access0 = await connectorSecrets.put(id, HOSTED_MCP_ACCESS_TOKEN, 'access-0', secretWriteGeneration(1, 0));
    const refresh0 = await connectorSecrets.put(id, HOSTED_MCP_REFRESH_TOKEN, 'refresh-0', secretWriteGeneration(1, 0));
    await Integration.updateOne(
      { _id: row._id },
      { $set: { 'config.credentialRef': access0, 'config.refreshTokenRef': refresh0 } },
    );

    const atPause = gate();
    const releaseA = gate();
    const realSecrets = { get: connectorSecrets.get, put: connectorSecrets.put, revoke: connectorSecrets.revoke };
    const pausedA = {
      ...realSecrets,
      put: async (integrationId, spec, material, writeGeneration) => {
        if (spec.kind === HOSTED_MCP_REFRESH_TOKEN.kind) {
          atPause.open();
          await releaseA.promise;
        }
        return connectorSecrets.put(integrationId, spec, material, writeGeneration);
      },
    };
    const store = {
      deps: {
        now: () => new Date(clock),
        sleep: async (ms) => { clock += ms; },
        entryFor: () => ENTRY,
        clientIdFor: () => 'client-id',
        secrets: realSecrets,
      },
    };

    const { deps: depsA, bumped } = fenceSignal(store, {
      secrets: pausedA,
      refreshAtVendor: async () => ({ accessToken: 'access-A', refreshToken: 'refresh-A', expiresIn: 3600 }),
    });
    const callA = credentialFor(await preImage(id), depsA);
    callA.catch(() => {});
    await bumped.promise;
    await atPause.promise;

    // B wins past A's lease and holds its vendor call open, non-rotating.
    clock = T0 + 31 * 1000;
    const vendorB = gate();
    const vendorBStarted = gate();
    const callB = credentialFor(await preImage(id), depsWith(store, {
      refreshAtVendor: async () => {
        vendorBStarted.open();
        await vendorB.promise;
        return { accessToken: 'access-B', expiresIn: 7200 };
      },
    }));
    // A's refresh write lands INSIDE B's vendor window: B has read its token by
    // the time it reaches the vendor, and A writes before B writes its own pair.
    await vendorBStarted.promise;
    releaseA.open();
    await callA.catch(() => {});
    vendorB.open();
    const b = await callB;
    expect(b.token).toBe('access-B');

    const after = await live(id);
    expect(after.status).toBe('connected');
    expect(after.config.refreshGeneration).toBe(5);
    expect(await connectorSecrets.get(after.config.credentialRef)).toBe('access-B');
    // B sealed the token it refreshed with, so the pair is internally consistent.
    expect(await connectorSecrets.get(after.config.refreshTokenRef)).toBe('refresh-0');
  } finally {
    process.env.CONNECTOR_SECRET_KEYS = savedKeys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = savedActive;
  }
});

// TASK-405 (sable, #2534 3f63c78f): a superseded refresh whose row commit matches
// nothing must not hand back its own token after the newer one won the fence. It
// serves the winner's live pair instead.
test('a refresh that loses its commit serves the newer winner, not its own token', async () => {
  const savedKeys = process.env.CONNECTOR_SECRET_KEYS;
  const savedActive = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  process.env.CONNECTOR_SECRET_KEYS = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
  await ConnectorSecret.init();
  try {
    const row = await Integration.create({
      type: 'hosted-mcp',
      podId: new mongoose.Types.ObjectId(),
      createdBy: new mongoose.Types.ObjectId(),
      status: 'connected',
      config: {
        entryId: 'linear',
        authGeneration: 1,
        refreshGeneration: 3,
        expiresAt: new Date(T0 - 3600 * 1000),
      },
    });
    const id = String(row._id);
    const access0 = await connectorSecrets.put(id, HOSTED_MCP_ACCESS_TOKEN, 'access-0', secretWriteGeneration(1, 0));
    const refresh0 = await connectorSecrets.put(id, HOSTED_MCP_REFRESH_TOKEN, 'refresh-0', secretWriteGeneration(1, 0));
    await Integration.updateOne(
      { _id: row._id },
      { $set: { 'config.credentialRef': access0, 'config.refreshTokenRef': refresh0 } },
    );

    const real = defaultRowDeps();
    const atCommit = gate();
    const releaseCommitA = gate();
    const store = {
      deps: {
        now: () => new Date(clock),
        sleep: async (ms) => { clock += ms; },
        entryFor: () => ENTRY,
        clientIdFor: () => 'client-id',
        secrets: { get: connectorSecrets.get, put: connectorSecrets.put, revoke: connectorSecrets.revoke },
      },
    };
    // A's commit is held until B has committed; B's commit is not held.
    const rowA = {
      ...real,
      commit: async (rowId, generation, fields) => {
        atCommit.open();
        await releaseCommitA.promise;
        return real.commit(rowId, generation, fields);
      },
    };
    const callA = credentialFor(await preImage(id), depsWith(store, {
      row: rowA,
      refreshAtVendor: async () => ({ accessToken: 'access-A', refreshToken: 'refresh-A', expiresIn: 3600 }),
    }));
    await atCommit.promise;

    clock = T0 + 31 * 1000;
    const b = await credentialFor(await preImage(id), depsWith(store, {
      refreshAtVendor: async () => ({ accessToken: 'access-B', refreshToken: 'refresh-B', expiresIn: 7200 }),
    }));
    expect(b.token).toBe('access-B');

    releaseCommitA.open();
    const a = await callA;
    // A lost its commit to B: it serves B's live access token, not its own.
    expect(a.token).toBe('access-B');

    const after = await live(id);
    expect(after.config.refreshGeneration).toBe(5);
    expect(await connectorSecrets.get(after.config.credentialRef)).toBe('access-B');
    expect(await connectorSecrets.get(after.config.refreshTokenRef)).toBe('refresh-B');
  } finally {
    process.env.CONNECTOR_SECRET_KEYS = savedKeys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = savedActive;
  }
});
