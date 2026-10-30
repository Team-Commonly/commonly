// TASK-624 — service tier. The grant panel names a per-user bot member from the
// pod list, so `getAllPods` projects the bot's label fields and nothing else.
// `scope=discover` serves pods the caller does not belong to, so the projection
// is also what keeps a bot's owner, machine and runtime off that surface. The
// unit tests cannot see either property, so this pins the populated shape.
process.env.PG_HOST = '';
const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const podController = require('../../controllers/podController');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const callGetAllPods = async (userId) => {
  const req = { query: {}, userId: String(userId), user: {} };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await podController.getAllPods(req, res);
  return res.json.mock.calls[0][0];
};

describe('getAllPods projects a bot member to its label fields only (TASK-624)', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  it('returns exactly displayName and instanceId for a per-user bot, never its owner, machine or runtime', async () => {
    const me = new mongoose.Types.ObjectId();
    const bot = new mongoose.Types.ObjectId();
    const owner = new mongoose.Types.ObjectId();
    await User.create([
      { _id: me, username: 'bot-projection-me', email: 'bot-projection-me@example.com', password: 'x' },
      {
        _id: bot,
        username: 'scout-uf2554d19c9',
        email: 'scout-uf2554d19c9@example.com',
        password: 'x',
        isBot: true,
        botType: 'agent',
        botMetadata: {
          displayName: 'Scout',
          instanceId: 'uf2554d19c9',
          agentName: 'scout',
          ownerUserId: String(owner),
          machineId: 'machine-1',
          runtimeId: 'runtime-1',
        },
      },
    ]);
    await Pod.create({ name: 'Mine', type: 'team', createdBy: me, members: [me, bot] });

    const body = await callGetAllPods(me);
    const member = body[0].members.find((m) => String(m._id) === String(bot));

    // Exact equality: a widened projection adds owner/machine/runtime and fails here.
    expect(member.botMetadata).toEqual({ displayName: 'Scout', instanceId: 'uf2554d19c9' });
    expect(member.username).toBe('scout-uf2554d19c9');
    expect(member.isBot).toBe(true);
  });
});
