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
  HostedMcpCredentialError,
  REFRESH_LEASE_MS,
  WINNER_WAIT_MS,
} = require('../../../services/hostedMcpCredentialService');
const {
  HOSTED_MCP_REFRESH_TOKEN,
} = require('../../../services/connectorSecretKinds');

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
 * The winner's bump is visible on the row only after its awaits have run, so the
 * mid-flight pre-image is taken by polling the store rather than by guessing a
 * tick count.
 */
const waitForGeneration = async (id, generation) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await live(id);
    if (row.config.refreshGeneration === generation) return row;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`row never reached refreshGeneration ${generation}`);
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
  const first = credentialFor(await preImage(id), depsWith(store, { refreshAtVendor }));
  const midFlight = await waitForGeneration(id, 4);
  // The lease is ON THE ROW: this is the strict subdocument write landing, and
  // the value a second caller's filter has to see.
  expect(midFlight.config.refreshingUntil).toBeInstanceOf(Date);

  let opened = false;
  const second = credentialFor(midFlight, depsWith(store, {
    refreshAtVendor,
    // The loser's first poll is the moment the winner is allowed to finish.
    sleep: async (ms) => {
      clock += ms;
      if (!opened) { opened = true; winner.open(); }
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
  const lateWinner = credentialFor(await preImage(id), depsWith(store, { refreshAtVendor: slowVendor }));
  await waitForGeneration(id, 4);

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
