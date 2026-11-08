/**
 * F307: a person closes the direct message pod they hold with an agent
 * (Pod.type 'agent-room'). Real Pod and User models on an in-memory Mongo, so
 * the gate, the write and the reopen filter are under test, not mocks of them.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let Pod;
let User;
let svc;

const make = async () => {
  const human = await User.create({ username: `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`, email: `${Math.random().toString(36).slice(2)}@x.test`, password: 'x'.repeat(12) });
  const agent = await User.create({ username: `a${Date.now()}${Math.random().toString(36).slice(2, 6)}`, email: `${Math.random().toString(36).slice(2)}@x.test`, password: 'x'.repeat(12), isBot: true });
  const room = await Pod.create({ name: 'otter', type: 'agent-room', createdBy: agent._id, members: [agent._id, human._id] });
  return { human, agent, room };
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Pod = require('../../../models/Pod');
  User = require('../../../models/User');
  svc = require('../../../services/agentRoomCloseService');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('closeAgentRoom / reopenAgentRoom', () => {
  test('the human member closes the room, and reopen clears it', async () => {
    const { human, room } = await make();
    const closed = await svc.closeAgentRoom(String(room._id), String(human._id));
    expect(closed.refusal).toBeUndefined();
    expect((await Pod.findById(room._id).lean()).closedAt).toBeInstanceOf(Date);

    expect((await svc.reopenAgentRoom(String(room._id), String(human._id))).refusal).toBeUndefined();
    expect((await Pod.findById(room._id).lean()).closedAt).toBeUndefined();
  });

  test('closing twice keeps the first closedAt', async () => {
    const { human, room } = await make();
    const first = await svc.closeAgentRoom(String(room._id), String(human._id));
    const second = await svc.closeAgentRoom(String(room._id), String(human._id));
    expect(second.closedAt.getTime()).toBe(first.closedAt.getTime());
  });

  test('the agent member cannot close it', async () => {
    const { agent, room } = await make();
    expect((await svc.closeAgentRoom(String(room._id), String(agent._id))).refusal).toBe('not_room_member');
    expect((await Pod.findById(room._id).lean()).closedAt).toBeUndefined();
  });

  test('a non-member gets the same answer as a missing pod', async () => {
    const { room } = await make();
    const { human: stranger } = await make();
    expect((await svc.closeAgentRoom(String(room._id), String(stranger._id))).refusal).toBe('pod_not_found');
    const chat = await Pod.create({ name: 'team', type: 'chat', createdBy: stranger._id, members: [stranger._id] });
    const { human: outsider } = await make();
    expect((await svc.closeAgentRoom(String(chat._id), String(outsider._id))).refusal).toBe('pod_not_found');
    expect((await svc.closeAgentRoom(String(new mongoose.Types.ObjectId()), String(outsider._id))).refusal).toBe('pod_not_found');
  });

  test('only agent-room: a member of a team pod or an agent-dm is refused', async () => {
    const { human } = await make();
    const chat = await Pod.create({ name: 'team', type: 'chat', createdBy: human._id, members: [human._id] });
    expect((await svc.closeAgentRoom(String(chat._id), String(human._id))).refusal).toBe('not_agent_room');
    expect((await Pod.findById(chat._id).lean()).closedAt).toBeUndefined();
  });
});

describe('reopenIfClosed', () => {
  test('a write reopens a closed room', async () => {
    const { human, room } = await make();
    await svc.closeAgentRoom(String(room._id), String(human._id));
    await svc.reopenIfClosed(room._id);
    expect((await Pod.findById(room._id).lean()).closedAt).toBeUndefined();
  });

  test('never touches another pod type, and never throws', async () => {
    const { human } = await make();
    const chat = await Pod.create({ name: 'team', type: 'chat', createdBy: human._id, members: [human._id], closedAt: new Date() });
    await svc.reopenIfClosed(chat._id);
    expect((await Pod.findById(chat._id).lean()).closedAt).toBeInstanceOf(Date);
    await expect(svc.reopenIfClosed('not-an-id')).resolves.toBeUndefined();
    await expect(svc.reopenIfClosed(null)).resolves.toBeUndefined();
  });
});

describe('dropClosedAgentRooms', () => {
  test('drops only closed agent-rooms', () => {
    const pods = [
      { _id: 1, type: 'agent-room', closedAt: new Date() },
      { _id: 2, type: 'agent-room' },
      { _id: 3, type: 'chat', closedAt: new Date() },
    ];
    expect(svc.dropClosedAgentRooms(pods).map((p) => p._id)).toEqual([2, 3]);
  });
});
