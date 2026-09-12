const mongoose = require('mongoose');
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn(),
}));
const AgentCredential = require('../../../models/AgentCredential');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const User = require('../../../models/User');
const { sweepLeftoverRuntimeTokens } = require('../../../scripts/sweep-leftover-runtime-tokens');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('sweep-leftover-runtime-tokens', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  const seed = async () => {
    const owner = await User.create({
      username: 'owner',
      email: 'owner@example.com',
      password: 'hashed',
      verified: true,
    });
    const bot = await User.create({
      username: 'openclaw-nova',
      email: 'openclaw-nova@agents.commonly.local',
      password: 'hashed',
      verified: true,
      isBot: true,
      botMetadata: { agentName: 'openclaw', instanceId: 'nova' },
      agentRuntimeTokens: [{ tokenHash: 'user-live', createdAt: new Date() }],
    });
    const podA = new mongoose.Types.ObjectId();
    const podB = new mongoose.Types.ObjectId();
    const staleAt = new Date(Date.now() - 8 * DAY_MS);
    const recentAt = new Date(Date.now() - 2 * DAY_MS);
    const makeInstallation = (podId, agentName, instanceId, runtimeTokens) => AgentInstallation.create({
      agentName,
      podId,
      instanceId,
      version: '1.0.0',
      installedBy: owner._id,
      runtimeTokens,
    });

    const first = await makeInstallation(podA, 'openclaw', 'nova', [
      { tokenHash: 'stale', createdAt: staleAt, lastUsedAt: staleAt },
      { tokenHash: 'recent', createdAt: recentAt, lastUsedAt: recentAt },
      { tokenHash: 'user-live', createdAt: staleAt, lastUsedAt: staleAt },
      { tokenHash: 'revoked', createdAt: staleAt, lastUsedAt: staleAt },
    ]);
    const second = await makeInstallation(podB, 'openclaw', 'nova', [
      { tokenHash: 'stale', createdAt: staleAt },
    ]);
    const other = await makeInstallation(new mongoose.Types.ObjectId(), 'pixel', 'default', [
      { tokenHash: 'no-ledger', createdAt: staleAt },
    ]);
    await AgentCredential.create({
      tokenHash: 'stale',
      kind: 'runtime',
      ownerUserId: owner._id,
      agentUserId: bot._id,
      status: 'active',
      lastUsedAt: staleAt,
    });
    await AgentCredential.create({
      tokenHash: 'recent',
      kind: 'runtime',
      ownerUserId: owner._id,
      agentUserId: bot._id,
      status: 'active',
      lastUsedAt: recentAt,
    });
    await AgentCredential.create({
      tokenHash: 'revoked',
      kind: 'runtime',
      ownerUserId: owner._id,
      agentUserId: bot._id,
      status: 'revoked',
      revokedAt: staleAt,
      lastUsedAt: staleAt,
    });
    return { first, second, other, bot };
  };

  it('defaults to dry-run and reports per-identity candidates without mutating', async () => {
    const { first, second, other } = await seed();

    const result = await sweepLeftoverRuntimeTokens();

    expect(result.apply).toBe(false);
    expect(result.copiesToPull).toBe(2);
    expect(result.copiesSkippedRecent).toBe(1);
    expect(result.candidateHashes).toBe(1);
    expect(result.identities).toEqual([
      expect.objectContaining({ agentName: 'openclaw', instanceId: 'nova', count: 2, skippedRecent: 1 }),
      expect.objectContaining({ agentName: 'pixel', instanceId: 'default', count: 0, skippedRecent: 0, legacyOnly: 1 }),
    ]);

    await expect(AgentInstallation.findById(first._id).lean()).resolves.toEqual(
      expect.objectContaining({ runtimeTokens: expect.arrayContaining([
        expect.objectContaining({ tokenHash: 'stale' }),
        expect.objectContaining({ tokenHash: 'recent' }),
      ]) }),
    );
    await expect(AgentInstallation.findById(second._id).lean()).resolves.toEqual(
      expect.objectContaining({ runtimeTokens: [expect.objectContaining({ tokenHash: 'stale' })] }),
    );
    await expect(AgentInstallation.findById(other._id).lean()).resolves.toEqual(
      expect.objectContaining({ runtimeTokens: [expect.objectContaining({ tokenHash: 'no-ledger' })] }),
    );
    await expect(AgentCredential.findOne({ tokenHash: 'stale' }).lean()).resolves.toEqual(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('apply removes stale installation copies and revokes their active ledger rows', async () => {
    const { first, second, other, bot } = await seed();

    const result = await sweepLeftoverRuntimeTokens({ apply: true });

    expect(result.apply).toBe(true);
    expect(result.copiesToPull).toBe(2);
    expect(result.installationRowsChanged).toBe(2);
    expect(result.credentialsRevoked).toBe(1);

    const firstTokens = (await AgentInstallation.findById(first._id).lean()).runtimeTokens;
    const secondTokens = (await AgentInstallation.findById(second._id).lean()).runtimeTokens;
    const otherTokens = (await AgentInstallation.findById(other._id).lean()).runtimeTokens;
    expect(firstTokens.map((token) => token.tokenHash)).toEqual(['recent', 'user-live', 'revoked']);
    expect(secondTokens).toEqual([]);
    expect(otherTokens).toEqual([expect.objectContaining({ tokenHash: 'no-ledger' })]);
    expect((await AgentCredential.findOne({ tokenHash: 'stale' }).lean()).status).toBe('revoked');
    expect((await AgentCredential.findOne({ tokenHash: 'recent' }).lean()).status).toBe('active');
    expect((await AgentCredential.findOne({ tokenHash: 'revoked' }).lean()).status).toBe('revoked');
    expect((await User.findById(bot._id).lean()).agentRuntimeTokens.map((token) => token.tokenHash))
      .toEqual(['user-live']);
  });
});
