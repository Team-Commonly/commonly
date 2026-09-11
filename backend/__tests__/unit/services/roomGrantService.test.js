const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let RoomGrant;
let service;

const baseGrant = (overrides = {}) => ({
  connectionId: 'connection-1',
  installationId: 'install-1',
  target: { kind: 'pod', id: 'pod-1' },
  tools: ['issues.read', 'issues.comment'],
  writeMode: 'write-with-confirm',
  budget: { calls: 10, windowMs: 60000 },
  audience: ['agent-a', 'agent-b'],
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  brokerId: 'broker-1',
  ...overrides,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RoomGrant = require('../../../models/RoomGrant');
  service = require('../../../services/roomGrantService');
});

afterEach(async () => {
  await RoomGrant.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('RoomGrant', () => {
  it('mints a child only with tools ⊆ parent', async () => {
    const parent = await service.mintGrant(baseGrant({ grantId: 'root-tools' }));
    await expect(service.attenuateGrant({ parentGrantId: parent.grantId, tools: ['issues.delete'] }))
      .rejects.toMatchObject({ code: 'grant_not_attenuated' });
    const child = await service.attenuateGrant({ parentGrantId: parent.grantId, tools: ['issues.read'] });
    expect(child.tools).toEqual(['issues.read']);
  });

  it('mints a child only with writeMode no stronger than parent', async () => {
    const parent = await service.mintGrant(baseGrant({ grantId: 'root-mode', writeMode: 'write-with-confirm' }));
    await expect(service.attenuateGrant({ parentGrantId: parent.grantId, writeMode: 'write' }))
      .rejects.toMatchObject({ code: 'grant_not_attenuated' });
    const child = await service.attenuateGrant({ parentGrantId: parent.grantId, writeMode: 'read' });
    expect(child.writeMode).toBe('read');
  });

  it('attenuates budget by call rate, not by window length alone', async () => {
    const parent = await service.mintGrant(baseGrant({ grantId: 'root-budget' }));
    await expect(service.attenuateGrant({
      parentGrantId: parent.grantId,
      budget: { calls: 10, windowMs: 1 },
    })).rejects.toMatchObject({ code: 'grant_not_attenuated' });
    const child = await service.attenuateGrant({
      parentGrantId: parent.grantId,
      budget: { calls: 10, windowMs: 600000 },
    });
    expect(child.budget).toMatchObject({ calls: 10, windowMs: 600000 });
  });

  it('does not turn a lifetime calls cap into a repeating windowed cap', async () => {
    const parent = await service.mintGrant(baseGrant({
      grantId: 'lifetime-budget',
      budget: { calls: 10 },
    }));
    await expect(service.attenuateGrant({
      parentGrantId: parent.grantId,
      budget: { windowMs: 1 },
    })).rejects.toMatchObject({ code: 'grant_not_attenuated' });
  });

  it('caps child expiry at parent expiry', async () => {
    const expiry = new Date(Date.now() + 5 * 60 * 1000);
    const parent = await service.mintGrant(baseGrant({ grantId: 'root-expiry', expiresAt: expiry }));
    const child = await service.attenuateGrant({
      parentGrantId: parent.grantId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    expect(child.expiresAt.getTime()).toBe(expiry.getTime());
  });

  it("refuses a grant without expiresAt", async () => {
    const input = baseGrant({ grantId: 'no-expiry' });
    delete input.expiresAt;
    await expect(service.mintGrant(input)).rejects.toThrow(/expiresAt/);
  });

  it('audience is snapshot ∩ current members', () => {
    expect(service.effectiveAudience({ audience: ['agent-a', 'agent-b'] }, ['agent-b', 'agent-c']))
      .toEqual(['agent-b']);
  });

  it('refuses an audience check without current membership context', async () => {
    const grant = await service.mintGrant(baseGrant({ grantId: 'audience-context' }));
    await expect(service.assertGrantUsable({ grant, agentUserId: 'agent-a' }))
      .rejects.toMatchObject({ code: 'audience_context_required' });
  });

  it('refuses grant use without an agent identity', async () => {
    const grant = await service.mintGrant(baseGrant({ grantId: 'agent-context' }));
    await expect(service.assertGrantUsable({ grant, currentMemberIds: ['agent-a'] }))
      .rejects.toMatchObject({ code: 'agent_identity_required' });
  });

  it('does not mint or use descendants after an ancestor is revoked', async () => {
    const root = await service.mintGrant(baseGrant({ grantId: 'lineage-root' }));
    const child = await service.attenuateGrant({ parentGrantId: root.grantId });
    await RoomGrant.updateOne({ grantId: root.grantId }, { $set: { revokedAt: new Date() } });
    await expect(service.mintGrant({
      ...baseGrant({ target: root.target }),
      parentGrantId: root.grantId,
    })).rejects.toMatchObject({ code: 'grant_revoked' });
    await expect(service.assertGrantUsable({ grant: child, agentUserId: 'agent-a', currentMemberIds: ['agent-a'] }))
      .rejects.toMatchObject({ code: 'grant_revoked' });
    await expect(service.attenuateGrant({ parentGrantId: child.grantId }))
      .rejects.toMatchObject({ code: 'grant_revoked' });
  });

  it('revoking the root revokes every descendant', async () => {
    const root = await service.mintGrant(baseGrant({ grantId: 'root-revoke' }));
    const child = await service.attenuateGrant({ parentGrantId: root.grantId, grantId: 'ignored-child' });
    const grandchild = await service.attenuateGrant({ parentGrantId: child.grantId });
    await service.revokeGrant(root.grantId);
    for (const grant of [root, child, grandchild]) {
      await expect(service.assertGrantUsable({ grantId: grant.grantId }))
        .rejects.toMatchObject({ code: 'grant_revoked' });
    }
  });
});
