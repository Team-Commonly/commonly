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
      botMetadata: { agentName: 'task-clerk', instanceId: 'default' },
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

  it('names the room with instanceId suffix for non-default instances', async () => {
    const room = await DMService.getOrCreateAgentRoom(
      agentUser._id,
      humanUser._id,
      { agentName: 'liz', instanceId: 'research' },
    );

    expect(room.name).toBe('liz (research)');
  });
});
