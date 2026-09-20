// TASK-094 / ADR-026: the per-spawn scoped credential.
//
// These assert the logic that has to be right for a leaked per-spawn file to
// stop being a live seat credential: the scope check that stops a child from
// minting, the clamped lifetime that makes the TTL the authority, the lineage
// that makes revocation reach children, and the boot sweep's filter.
jest.mock('../../../models/AgentCredential', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
    updateMany: jest.fn(),
  },
}));

jest.mock('../../../utils/secret', () => ({
  hash: (value) => `hash:${value}`,
  randomSecret: (bytes) => 'r'.repeat(bytes),
}));

const AgentCredential = require('../../../models/AgentCredential').default;
const {
  SPAWN_SCOPE,
  SPAWN_TTL_DEFAULT_SECONDS,
  SPAWN_TTL_MAX_SECONDS,
  SPAWN_TTL_MIN_SECONDS,
  MAX_SPAWN_ID_LENGTH,
  clampSpawnTtlSeconds,
  isSpawnCredential,
  resolveSeatCredential,
  mintSpawnCredential,
  revokeSpawnCredential,
  revokeOrphanSpawnCredentials,
} = require('../../../services/spawnCredentialService');

const SEAT_ID = 'seat-credential-id';

// The service reads with `.lean()` / `.select().lean()`, so `findOne` has to
// RETURN a chainable object rather than a promise — `mockReturnValue`, not
// `mockResolvedValue`, or `.lean` is called on a promise and the test fails on
// the mock's shape instead of the code's.
const leanRow = (value) => ({ lean: async () => value });
const selectedLean = (value) => ({ select: () => leanRow(value) });

const seatRow = (overrides = {}) => ({
  _id: SEAT_ID,
  ownerUserId: 'owner-user-id',
  agentUserId: 'agent-user-id',
  machineId: 'machine-1',
  scopes: [],
  ...overrides,
});

const createdChild = (overrides = {}) => ({
  _id: 'child-id',
  ...overrides,
});

describe('clampSpawnTtlSeconds', () => {
  test('an omitted lifetime takes the default', () => {
    expect(clampSpawnTtlSeconds(undefined)).toBe(SPAWN_TTL_DEFAULT_SECONDS);
    expect(clampSpawnTtlSeconds(null)).toBe(SPAWN_TTL_DEFAULT_SECONDS);
  });

  test('a lifetime above the cap is clamped down to it', () => {
    expect(clampSpawnTtlSeconds(30 * 24 * 60 * 60)).toBe(SPAWN_TTL_MAX_SECONDS);
  });

  test('a lifetime below the floor is clamped up to it, so a spawn cannot be given a token that dies mid-turn', () => {
    expect(clampSpawnTtlSeconds(5)).toBe(SPAWN_TTL_MIN_SECONDS);
  });

  test('a parseable lifetime is honoured', () => {
    expect(clampSpawnTtlSeconds(3600)).toBe(3600);
    expect(clampSpawnTtlSeconds('3600')).toBe(3600);
  });

  test('unparseable or non-positive input is refused rather than defaulted, because a silent default hides the caller bug', () => {
    expect(clampSpawnTtlSeconds('soon')).toBeNull();
    expect(clampSpawnTtlSeconds(0)).toBeNull();
    expect(clampSpawnTtlSeconds(-60)).toBeNull();
  });
});

describe('isSpawnCredential', () => {
  test('the spawn scope is what marks a row as a child', () => {
    expect(isSpawnCredential({ scopes: [SPAWN_SCOPE] })).toBe(true);
  });

  test('a seat row (no spawn scope) is not a child', () => {
    expect(isSpawnCredential({ scopes: [] })).toBe(false);
    expect(isSpawnCredential({ scopes: ['agent:messages:write'] })).toBe(false);
  });

  test('a row without scopes is not a child', () => {
    expect(isSpawnCredential({})).toBe(false);
    expect(isSpawnCredential(null)).toBe(false);
  });
});

describe('mintSpawnCredential', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a child cannot mint another child, and the refusal leaves no row behind', async () => {
    const result = await mintSpawnCredential({
      seat: seatRow({ scopes: [SPAWN_SCOPE] }),
      spawnId: 'spawn-1',
    });

    expect(result).toEqual({ ok: false, code: 'child_cannot_mint' });
    expect(AgentCredential.create).not.toHaveBeenCalled();
  });

  test('a missing, blank or over-long spawn id is refused', async () => {
    for (const spawnId of [undefined, '', '   ', 42, 'x'.repeat(MAX_SPAWN_ID_LENGTH + 1)]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await mintSpawnCredential({ seat: seatRow(), spawnId });
      expect(result).toEqual({ ok: false, code: 'invalid_spawn_id' });
    }
    expect(AgentCredential.create).not.toHaveBeenCalled();
  });

  test('an unparseable lifetime is refused', async () => {
    const result = await mintSpawnCredential({ seat: seatRow(), spawnId: 'spawn-1', ttlSeconds: 'soon' });

    expect(result).toEqual({ ok: false, code: 'invalid_ttl' });
    expect(AgentCredential.create).not.toHaveBeenCalled();
  });

  test('the child carries the spawn scope, the parent link and the seat identity', async () => {
    AgentCredential.create.mockResolvedValue(createdChild());

    const result = await mintSpawnCredential({ seat: seatRow(), spawnId: 'spawn-1', ttlSeconds: 3600 });

    expect(AgentCredential.create).toHaveBeenCalledTimes(1);
    const row = AgentCredential.create.mock.calls[0][0];
    expect(row.kind).toBe('runtime');
    expect(row.parentId).toBe(SEAT_ID);
    expect(row.scopes).toEqual([SPAWN_SCOPE]);
    expect(row.label).toBe('spawn:spawn-1');
    expect(row.ownerUserId).toBe('owner-user-id');
    expect(row.agentUserId).toBe('agent-user-id');
    expect(row.machineId).toBe('machine-1');
    expect(row.tokenHash).toBe(`hash:${result.token}`);
    expect(result.ok).toBe(true);
    expect(result.credentialId).toBe('child-id');
    expect(result.spawnId).toBe('spawn-1');
  });

  test('the minted bearer is a runtime token, so the auth prefix check accepts it', async () => {
    AgentCredential.create.mockResolvedValue(createdChild());

    const result = await mintSpawnCredential({ seat: seatRow(), spawnId: 'spawn-1' });

    expect(result.token.startsWith('cm_agent_')).toBe(true);
  });

  test('the expiry uses the clamped lifetime, not the requested one', async () => {
    AgentCredential.create.mockResolvedValue(createdChild());
    const before = Date.now();

    const result = await mintSpawnCredential({
      seat: seatRow(),
      spawnId: 'spawn-1',
      ttlSeconds: 30 * 24 * 60 * 60,
    });

    const ttlMs = result.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(SPAWN_TTL_MAX_SECONDS * 1000 - 5000);
    expect(ttlMs).toBeLessThanOrEqual(SPAWN_TTL_MAX_SECONDS * 1000 + 5000);
  });

  test('the child inherits the agent user from the caller when the seat row has none', async () => {
    AgentCredential.create.mockResolvedValue(createdChild());

    await mintSpawnCredential({
      seat: seatRow({ agentUserId: null, machineId: null }),
      spawnId: 'spawn-1',
      agentUserId: 'agent-from-caller',
    });

    const row = AgentCredential.create.mock.calls[0][0];
    expect(row.agentUserId).toBe('agent-from-caller');
    expect(row.machineId).toBeNull();
  });
});

describe('resolveSeatCredential', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an existing row is returned without touching the collection', async () => {
    AgentCredential.findOne.mockReturnValue(leanRow(seatRow()));

    const seat = await resolveSeatCredential({ tokenHash: 'h', agentUserId: 'agent-user-id' });

    expect(seat._id).toBe(SEAT_ID);
    expect(AgentCredential.updateOne).not.toHaveBeenCalled();
  });

  test('a legacy token with no row gets an idempotent backfill whose owner comes from the installation', async () => {
    AgentCredential.findOne
      .mockReturnValueOnce(leanRow(null))
      .mockReturnValueOnce(leanRow(seatRow()));
    AgentCredential.updateOne.mockResolvedValue({ upsertedCount: 1 });

    const seat = await resolveSeatCredential({
      tokenHash: 'h',
      agentUserId: 'agent-user-id',
      installedBy: 'installer-user-id',
      label: 'Runtime token',
    });

    expect(AgentCredential.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = AgentCredential.updateOne.mock.calls[0];
    expect(filter).toEqual({ tokenHash: 'h' });
    expect(options).toEqual({ upsert: true });
    expect(update.$setOnInsert.ownerUserId).toBe('installer-user-id');
    expect(update.$setOnInsert.agentUserId).toBe('agent-user-id');
    expect(update.$setOnInsert.status).toBe('active');
    expect(update.$set).toBeUndefined();
    expect(seat._id).toBe(SEAT_ID);
  });

  test('the backfill falls back to the agent user as owner when nothing installed it', async () => {
    AgentCredential.findOne.mockReturnValueOnce(leanRow(null)).mockReturnValueOnce(leanRow(seatRow()));
    AgentCredential.updateOne.mockResolvedValue({ upsertedCount: 1 });

    await resolveSeatCredential({ tokenHash: 'h', agentUserId: 'agent-user-id' });

    expect(AgentCredential.updateOne.mock.calls[0][1].$setOnInsert.ownerUserId).toBe('agent-user-id');
  });

  test('a row that cannot be resolved after the upsert is an error, not a child with a dangling parent', async () => {
    AgentCredential.findOne.mockReturnValue(leanRow(null));
    AgentCredential.updateOne.mockResolvedValue({ upsertedCount: 0 });

    await expect(resolveSeatCredential({ tokenHash: 'h', agentUserId: 'agent-user-id' }))
      .rejects.toThrow(/credential row/);
  });
});

describe('revokeSpawnCredential', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the parent link is part of the lookup, so a seat cannot revoke another seat\'s child', async () => {
    AgentCredential.findOne.mockReturnValue(selectedLean(null));

    const result = await revokeSpawnCredential({ credentialId: 'child-id', seatCredentialId: SEAT_ID });

    expect(AgentCredential.findOne).toHaveBeenCalledWith({ _id: 'child-id', parentId: SEAT_ID });
    expect(result).toEqual({ revoked: 0, found: false });
    expect(AgentCredential.updateOne).not.toHaveBeenCalled();
  });

  test('an active child of this seat is revoked and the count is returned', async () => {
    AgentCredential.findOne.mockReturnValue(selectedLean({ _id: 'child-id', status: 'active' }));
    AgentCredential.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await revokeSpawnCredential({ credentialId: 'child-id', seatCredentialId: SEAT_ID });

    const [filter, update] = AgentCredential.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'child-id', status: 'active' });
    expect(update.$set.status).toBe('revoked');
    expect(update.$set.revokedAt instanceof Date).toBe(true);
    expect(result).toEqual({ revoked: 1, found: true });
  });

  test('an already-revoked child reports found with nothing modified, so a retry is not an error', async () => {
    AgentCredential.findOne.mockReturnValue(selectedLean({ _id: 'child-id', status: 'revoked' }));
    AgentCredential.updateOne.mockResolvedValue({ modifiedCount: 0 });

    const result = await revokeSpawnCredential({ credentialId: 'child-id', seatCredentialId: SEAT_ID });

    expect(result).toEqual({ revoked: 0, found: true });
  });
});

describe('revokeOrphanSpawnCredentials', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the sweep is filtered by the caller\'s own parent id and by active status, and by nothing else', async () => {
    AgentCredential.updateMany.mockResolvedValue({ modifiedCount: 3 });

    const revoked = await revokeOrphanSpawnCredentials({ seatCredentialId: SEAT_ID });

    expect(AgentCredential.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = AgentCredential.updateMany.mock.calls[0];
    expect(filter).toEqual({ parentId: SEAT_ID, status: 'active' });
    expect(update.$set.status).toBe('revoked');
    expect(revoked).toBe(3);
  });

  test('a seat with no rows sweeps cleanly rather than failing', async () => {
    AgentCredential.updateMany.mockResolvedValue({ modifiedCount: 0 });

    await expect(revokeOrphanSpawnCredentials({ seatCredentialId: SEAT_ID })).resolves.toBe(0);
  });
});
