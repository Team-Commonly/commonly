// @ts-nocheck

// The migration suite needs testUtils' Mongo harness, not JWT behavior.
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');

const Integration = require('../../../models/Integration');
const { migrateConnectorGates } = require('../../../scripts/migrate-connector-gates');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

const id = () => new mongoose.Types.ObjectId().toString();

describe('migrate-connector-gates', () => {
  beforeAll(async () => setupMongoDb());
  afterAll(async () => closeMongoDb());
  beforeEach(async () => clearMongoDb());

  it('moves only installable projections to user scope with their initial gate', async () => {
    const ownerId = id();
    const podId = id();
    const createdAt = new Date('2026-09-01T00:00:00.000Z');
    const projection = await Integration.create({
      installationId: id(),
      podId,
      type: 'telegram',
      status: 'pending',
      createdBy: ownerId,
      isActive: true,
      config: { liveRelay: true, linkedUserId: ownerId },
      createdAt,
      updatedAt: createdAt,
    });
    const legacy = await Integration.create({
      podId: id(),
      type: 'telegram',
      status: 'pending',
      createdBy: ownerId,
      isActive: true,
      config: { liveRelay: true },
    });

    await expect(migrateConnectorGates()).resolves.toEqual({ scanned: 1, migrated: 1, skipped: 0 });
    const migrated = await Integration.findById(projection._id);
    const unchangedLegacy = await Integration.findById(legacy._id);
    expect(migrated.scope).toBe('user');
    expect(migrated.config.gates.get(podId)).toMatchObject({ enabled: true, since: createdAt });
    expect(unchangedLegacy.scope).toBe('pod');
    expect(unchangedLegacy.config.gates).toBeUndefined();
  });

  it('is idempotent and dry-run writes nothing', async () => {
    const ownerId = id();
    const podId = id();
    const projection = await Integration.create({
      installationId: id(), podId, type: 'slack', status: 'pending', createdBy: ownerId,
      isActive: true, config: { liveRelay: true, linkedUserId: ownerId },
    });

    await expect(migrateConnectorGates({ dryRun: true }))
      .resolves.toEqual({ scanned: 1, migrated: 1, skipped: 0 });
    expect((await Integration.findById(projection._id)).scope).toBe('pod');
    expect((await Integration.findById(projection._id)).config.gates).toBeUndefined();

    await expect(migrateConnectorGates()).resolves.toEqual({ scanned: 1, migrated: 1, skipped: 0 });
    await expect(migrateConnectorGates()).resolves.toEqual({ scanned: 0, migrated: 0, skipped: 0 });
    expect((await Integration.findById(projection._id)).config.gates.get(podId)).toMatchObject({ enabled: true });
  });
});
