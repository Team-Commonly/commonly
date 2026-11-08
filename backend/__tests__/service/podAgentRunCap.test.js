// A progress pod where builders post a line per land, with nobody speaking:
// its creator raises the run cap for that pod alone. Real Mongo and the real
// postMessage.
process.env.PG_HOST = '';
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentMessageService = require('../../services/agentMessageService');

describe('a pod\'s own run cap', () => {
  let owner;
  let bot;
  const makePod = async (name, agentRunCap) => {
    const pod = await Pod.create({
      name, type: 'chat', createdBy: owner._id, members: [owner._id, bot._id],
      ...(agentRunCap === undefined ? {} : { agentRunCap }),
    });
    await AgentInstallation.create({
      agentName: 'builder', instanceId: 'default', podId: pod._id, version: '1', installedBy: owner._id, status: 'active',
      config: new Map([['runtime', { runtimeType: 'local-cli', host: 'byo' }]]),
    });
    return pod;
  };
  const post = (pod, content) => AgentMessageService.postMessage({
    agentName: 'builder', instanceId: 'default', podId: pod._id, content,
  });
  const postLines = async (pod, n) => {
    const results = [];
    for (let i = 1; i <= n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await post(pod, `Landed change ${i}.`));
    }
    return results;
  };

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    owner = await User.create({ username: 'cap-owner', email: 'o@test.com', password: 'password123' });
    bot = await User.create({
      username: 'builder-bot', email: 'b@test.com', password: 'password123', isBot: true,
      botMetadata: { agentName: 'builder', instanceId: 'default' },
    });
  });

  it('lets a fourth land line through in an opted-in pod, and refuses it in a default one', async () => {
    const progress = await makePod('Progress', 20);
    const ops = await makePod('Ops');
    expect((await postLines(progress, 4)).every((r) => r.success)).toBe(true);
    const plain = await postLines(ops, 4);
    expect(plain.slice(0, 3).every((r) => r.success)).toBe(true);
    expect(plain[3].reason).toBe('consecutive_run_cap');
  });

  it('still stops a run at the pod\'s cap, past the 20 messages a count used to read', async () => {
    const progress = await makePod('Progress', 25);
    const results = await postLines(progress, 26);
    expect(results.slice(0, 25).every((r) => r.success)).toBe(true);
    expect(results[25].reason).toBe('consecutive_run_cap');
  });

  it('holds the floor at the pod\'s cap, not the default', async () => {
    const progress = await makePod('Progress', 5);
    await postLines(progress, 4);
    // postMessage posts under the agent identity it resolves; read it back.
    const [last] = (await AgentMessageService.getRecentMessages(progress._id, 1));
    const author = last.userId?._id || last.userId;
    expect(await AgentMessageService.holdsFloor(progress._id, author, 'chat', 5)).toBe(false);
    expect(await AgentMessageService.holdsFloor(progress._id, author, 'chat')).toBe(true);
  });

  it('ignores an out-of-range stored value and uses the default', () => {
    expect(AgentMessageService.resolveConsecutiveRunCap(0)).toBe(3);
    expect(AgentMessageService.resolveConsecutiveRunCap(99)).toBe(3);
    expect(AgentMessageService.resolveConsecutiveRunCap(20)).toBe(20);
  });

  it('clears to the default in the stored document', async () => {
    const progress = await makePod('Progress', 20);
    const doc = await Pod.findById(progress._id);
    doc.agentRunCap = undefined;
    await doc.save();
    const raw = await Pod.collection.findOne({ _id: progress._id });
    expect(Object.prototype.hasOwnProperty.call(raw, 'agentRunCap')).toBe(false);
  });

  it('keeps an operator\'s instance-wide off switch, whatever the pod says', () => {
    const before = process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP;
    process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP = '0';
    try {
      expect(AgentMessageService.resolveConsecutiveRunCap(20)).toBe(0);
    } finally {
      if (before === undefined) delete process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP;
      else process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP = before;
    }
  });

  it('reads no pod for a pod id that is an object, not an id', async () => {
    await expect(AgentMessageService.postMessage({
      agentName: 'builder', instanceId: 'default', podId: { $ne: null }, content: 'Hello.',
    })).rejects.toMatchObject({ code: 'pod_not_found' });
  });

  it('refuses a stored cap outside 3..50 at the model', async () => {
    await expect(Pod.create({ name: 'Off', type: 'chat', createdBy: owner._id, agentRunCap: 0 })).rejects.toThrow();
  });
});
