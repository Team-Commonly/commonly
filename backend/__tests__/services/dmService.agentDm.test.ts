// @ts-nocheck
/**
 * DMService — agent-dm + sharePod tests (Phase 1 of agent collaboration plan).
 *
 * Verifies:
 * - sharePod returns true/false on co-pod-member relationships across
 *   bot/bot, bot/human, human/human pairs and self.
 * - getOrCreateAgentDmRoom creates an agent-dm pod on first call,
 *   returns the same pod on second call regardless of arg order.
 * - Both bot members get an AgentInstallation row (heartbeat off) so
 *   outbound posting works (the e78b5df241 invariant for the new
 *   pod type).
 * - AgentInstallation.upsert is idempotent: re-firing the autoJoin
 *   path on an existing row produces no duplicates and never throws.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../models/pg/Pod', () => null);

const DMService = require('../../services/dmService');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');

describe('DMService — agent-dm + sharePod', () => {
  let mongoServer;
  let aria;
  let codex;
  let alice;
  let bob;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({
      binary: { version: '7.0.11', skipMD5: true },
      instance: { dbName: 'dm-service-agent-dm-test' },
    });
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      try { await mongoServer.stop(); } catch (_) { /* ignore */ }
    }
  });

  beforeEach(async () => {
    await Promise.all([
      Pod.deleteMany({}),
      User.deleteMany({}),
      AgentInstallation.deleteMany({}),
    ]);
    aria = await User.create({
      username: 'aria-default',
      email: 'aria@agent.local',
      password: 'placeholder',
      isBot: true,
      botMetadata: { agentName: 'aria', instanceId: 'default' },
    });
    codex = await User.create({
      username: 'codex-default',
      email: 'codex@agent.local',
      password: 'placeholder',
      isBot: true,
      botMetadata: { agentName: 'codex', instanceId: 'default' },
    });
    alice = await User.create({
      username: 'alice',
      email: 'alice@example.com',
      password: 'placeholder',
    });
    bob = await User.create({
      username: 'bob',
      email: 'bob@example.com',
      password: 'placeholder',
    });
  });

  describe('sharePod', () => {
    it('returns false when users have no shared pod', async () => {
      const result = await DMService.sharePod(alice._id, bob._id);
      expect(result).toBe(false);
    });

    it('returns true when users share at least one pod', async () => {
      await Pod.create({
        name: 'Backend Tasks',
        type: 'team',
        createdBy: alice._id,
        members: [alice._id, bob._id],
      });
      const result = await DMService.sharePod(alice._id, bob._id);
      expect(result).toBe(true);
    });

    it('returns true for bot↔bot in shared pod', async () => {
      await Pod.create({
        name: 'Demo',
        type: 'team',
        createdBy: alice._id,
        members: [alice._id, aria._id, codex._id],
      });
      const result = await DMService.sharePod(aria._id, codex._id);
      expect(result).toBe(true);
    });

    it('returns true for bot↔human in shared pod', async () => {
      await Pod.create({
        name: 'Demo',
        type: 'team',
        createdBy: alice._id,
        members: [alice._id, aria._id],
      });
      const result = await DMService.sharePod(alice._id, aria._id);
      expect(result).toBe(true);
    });

    it('returns false on self', async () => {
      await Pod.create({
        name: 'Demo',
        type: 'team',
        createdBy: alice._id,
        members: [alice._id],
      });
      const result = await DMService.sharePod(alice._id, alice._id);
      expect(result).toBe(false);
    });
  });

  describe('getOrCreateAgentDmRoom', () => {
    const memberFor = (user) => ({
      userId: user._id,
      isBot: !!user.isBot,
      agentName: user.botMetadata?.agentName,
      instanceId: user.botMetadata?.instanceId,
      displayName: user.botMetadata?.agentName || user.username,
    });

    it('creates a new agent-dm pod on first call', async () => {
      const room = await DMService.getOrCreateAgentDmRoom(
        memberFor(aria),
        memberFor(codex),
      );

      expect(room).toBeDefined();
      expect(room.type).toBe('agent-dm');
      expect(room.joinPolicy).toBe('invite-only');
      const memberIds = room.members.map((m) => m.toString());
      expect(memberIds).toContain(aria._id.toString());
      expect(memberIds).toContain(codex._id.toString());
      expect(memberIds).toHaveLength(2);
    });

    it('idempotent on the unordered pair', async () => {
      const room1 = await DMService.getOrCreateAgentDmRoom(memberFor(aria), memberFor(codex));
      const room2 = await DMService.getOrCreateAgentDmRoom(memberFor(codex), memberFor(aria));
      expect(room1._id.toString()).toBe(room2._id.toString());
      const all = await Pod.find({ type: 'agent-dm' });
      expect(all).toHaveLength(1);
    });

    it('creates AgentInstallation rows for both bot members', async () => {
      const room = await DMService.getOrCreateAgentDmRoom(memberFor(aria), memberFor(codex));
      const installs = await AgentInstallation.find({ podId: room._id });
      const names = installs.map((i) => i.agentName).sort();
      expect(names).toEqual(['aria', 'codex']);
      installs.forEach((i) => {
        // heartbeat MUST be off for agent-dm rooms (reactive only).
        expect(i.config.get('heartbeat')).toEqual({ enabled: false });
        expect(i.status).toBe('active');
      });
    });

    it('refuses self-DM', async () => {
      await expect(
        DMService.getOrCreateAgentDmRoom(memberFor(aria), memberFor(aria)),
      ).rejects.toThrow(/distinct/);
    });

    it('names the pod with the ↔ separator', async () => {
      const room = await DMService.getOrCreateAgentDmRoom(memberFor(aria), memberFor(codex));
      expect(room.name).toContain('↔');
      expect(room.name.toLowerCase()).toContain('aria');
      expect(room.name.toLowerCase()).toContain('codex');
    });
  });

  describe('AgentInstallation.upsert idempotency', () => {
    let pod;
    beforeEach(async () => {
      pod = await Pod.create({
        name: 'Demo',
        type: 'agent-dm',
        createdBy: aria._id,
        members: [aria._id, codex._id],
      });
    });

    it('does not throw on a second upsert for the same triple', async () => {
      const opts = {
        version: '1.0.0',
        config: { heartbeat: { enabled: false } },
        scopes: ['messages:write'],
        installedBy: aria._id,
        instanceId: 'default',
        displayName: 'codex',
      };
      const a = await AgentInstallation.upsert('codex', pod._id, opts);
      const b = await AgentInstallation.upsert('codex', pod._id, opts);
      expect(a._id.toString()).toBe(b._id.toString());
      const all = await AgentInstallation.find({ agentName: 'codex', podId: pod._id });
      expect(all).toHaveLength(1);
    });

    it('reactivates an uninstalled row instead of creating a new one', async () => {
      const opts = {
        version: '1.0.0',
        config: { heartbeat: { enabled: false } },
        scopes: ['messages:write'],
        installedBy: aria._id,
        instanceId: 'default',
        displayName: 'codex',
      };
      const installed = await AgentInstallation.upsert('codex', pod._id, opts);
      installed.status = 'uninstalled';
      await installed.save();

      const reupserted = await AgentInstallation.upsert('codex', pod._id, opts);
      // Same row (unique-index filter matched, not a new row with a
      // coincidentally matching ObjectId) AND identity unchanged.
      expect(reupserted._id.toString()).toBe(installed._id.toString());
      expect(reupserted.agentName).toBe('codex');
      expect(reupserted.podId.toString()).toBe(pod._id.toString());
      expect(reupserted.instanceId).toBe('default');
      expect(reupserted.status).toBe('active');
      const all = await AgentInstallation.find({ agentName: 'codex', podId: pod._id });
      expect(all).toHaveLength(1);
    });
  });
});
