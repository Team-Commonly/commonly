// @ts-nocheck
/**
 * DMService.getOrCreateAgentRoom — unit tests.
 *
 * Verifies:
 * - Creates a new agent-room pod on first call
 * - Returns the existing room on second call (idempotent)
 * - Sets correct pod type, joinPolicy, createdBy, members
 * - Different users get separate rooms with the same agent
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Stub PG — no real PostgreSQL in unit tests
jest.mock('../../models/pg/Pod', () => null);

const DMService = require('../../services/dmService');
const Pod = require('../../models/Pod');
const User = require('../../models/User');

describe('DMService — agent rooms', () => {
  let mongoServer;
  let agentUser;
  let humanUser;
  let humanUser2;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({
      binary: { version: '7.0.11', skipMD5: true },
      instance: { dbName: 'dm-service-agent-room-test' },
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
    await Promise.all([Pod.deleteMany({}), User.deleteMany({})]);

    agentUser = await User.create({
      username: 'task-clerk-default',
      email: 'task-clerk@agent.local',
      password: 'placeholder',
      isBot: true,
      // displayName is the canonical room-label source per
      // f9ff990c23 (dmService no longer constructs "<runtime> (<instance>)").
      botMetadata: { agentName: 'task-clerk', instanceId: 'default', displayName: 'task-clerk' },
    });
    humanUser = await User.create({
      username: 'alice',
      email: 'alice@example.com',
      password: 'placeholder',
    });
    humanUser2 = await User.create({
      username: 'bob',
      email: 'bob@example.com',
      password: 'placeholder',
    });
  });

  it('creates a new agent-room pod on first call', async () => {
    const room = await DMService.getOrCreateAgentRoom(
      agentUser._id,
      humanUser._id,
      { agentName: 'task-clerk', instanceId: 'default' },
    );

    expect(room).toBeDefined();
    expect(room.type).toBe('agent-room');
    expect(room.joinPolicy).toBe('invite-only');
    expect(room.name).toBe('task-clerk');
    expect(room.description).toContain('Agent room');
    // Agent is the host (createdBy)
    expect(room.createdBy.toString()).toBe(agentUser._id.toString());
    // Both agent and human are members
    const memberIds = room.members.map((m) => m.toString());
    expect(memberIds).toContain(agentUser._id.toString());
    expect(memberIds).toContain(humanUser._id.toString());
    expect(memberIds).toHaveLength(2);
  });

  it('returns the same room on second call (idempotent)', async () => {
    const opts = { agentName: 'task-clerk', instanceId: 'default' };
    const room1 = await DMService.getOrCreateAgentRoom(agentUser._id, humanUser._id, opts);
    const room2 = await DMService.getOrCreateAgentRoom(agentUser._id, humanUser._id, opts);

    expect(room1._id.toString()).toBe(room2._id.toString());

    // Only one pod should exist
    const allRooms = await Pod.find({ type: 'agent-room' });
    expect(allRooms).toHaveLength(1);
  });

  it('creates separate rooms for different human users', async () => {
    const opts = { agentName: 'task-clerk', instanceId: 'default' };
    const roomAlice = await DMService.getOrCreateAgentRoom(agentUser._id, humanUser._id, opts);
    const roomBob = await DMService.getOrCreateAgentRoom(agentUser._id, humanUser2._id, opts);

    expect(roomAlice._id.toString()).not.toBe(roomBob._id.toString());

    const allRooms = await Pod.find({ type: 'agent-room' });
    expect(allRooms).toHaveLength(2);
  });

  it('uses the agent user displayName for the room label, not function args', async () => {
    // f9ff990c23 made room labels read from User.botMetadata.displayName so an
    // agent's heartbeat doesn't render confusing "openclaw (aria)"-style names
    // back into chat. The function-arg agentName is only the last-resort
    // fallback when the agent user has no botMetadata at all.
    const liz = await User.create({
      username: 'liz-research',
      email: 'liz@agent.local',
      password: 'placeholder',
      isBot: true,
      botMetadata: { agentName: 'openclaw', instanceId: 'research', displayName: 'Liz' },
    });

    const room = await DMService.getOrCreateAgentRoom(
      liz._id,
      humanUser._id,
      { agentName: 'liz', instanceId: 'research' },
    );

    // displayName wins over agentName/instanceId function args.
    expect(room.name).toBe('Liz');
  });

  it('falls back to instanceId when displayName missing and instanceId is non-default', async () => {
    const tarik = await User.create({
      username: 'tarik-prod',
      email: 'tarik@agent.local',
      password: 'placeholder',
      isBot: true,
      // No displayName — resolution falls through to instanceId since it's not 'default'.
      botMetadata: { agentName: 'openclaw', instanceId: 'tarik' },
    });

    const room = await DMService.getOrCreateAgentRoom(
      tarik._id,
      humanUser._id,
      { agentName: 'openclaw', instanceId: 'tarik' },
    );

    expect(room.name).toBe('tarik');
  });
});
