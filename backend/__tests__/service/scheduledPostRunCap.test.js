// A daily job in a quiet pod is the same author every day, so the run cap would
// refuse it from the fourth day. Real Mongo and the real postMessage.
process.env.PG_HOST = '';
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentMessageService = require('../../services/agentMessageService');

const DAY = 24 * 60 * 60 * 1000;
const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });

describe('a scheduled post and the run cap', () => {
  let pod;
  let bot;
  const firedAt = (when) => AgentInstallation.updateOne(
    { agentName: 'daily' }, { $set: { 'config.schedule.lastFiredAt': when } },
  );
  const post = (content) => AgentMessageService.postMessage({
    agentName: 'daily', instanceId: 'default', podId: pod._id, content,
  });

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    const owner = await User.create({ username: 'cap-owner', email: 'o@test.com', password: 'password123' });
    bot = await User.create({
      username: 'daily-bot', email: 'b@test.com', password: 'password123', isBot: true,
      botMetadata: { agentName: 'daily', instanceId: 'default' },
    });
    pod = await Pod.create({ name: 'Ops', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
    await AgentInstallation.create({
      agentName: 'daily', instanceId: 'default', podId: pod._id, version: '1', installedBy: owner._id, status: 'active',
      config: new Map([['runtime', { runtimeType: 'local-cli', host: 'byo' }]]),
    });
    for (const day of ['Monday', 'Tuesday', 'Wednesday']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await post(`The count for ${day}.`)).success).toBe(true);
    }
  });

  it('refuses the fourth post with no wake behind it', async () => {
    const result = await post('Another line.');
    expect(result.reason).toBe('consecutive_run_cap');
  });

  it('refuses it when the wake is older than the last post', async () => {
    await firedAt(new Date(Date.now() - DAY));
    expect((await post('Another line.')).reason).toBe('consecutive_run_cap');
  });

  it('fails toward posting when the schedule can\'t be read', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const real = AgentInstallation.findOne.bind(AgentInstallation);
    const findOne = jest.spyOn(AgentInstallation, 'findOne').mockImplementation((query, ...rest) => {
      if (query?.podId?.$eq && query?.status === 'active') throw new Error('read failed');
      return real(query, ...rest);
    });
    expect((await post('The count for today.')).success).toBe(true);
    findOne.mockRestore();
    console.warn.mockRestore();
  });

  it('lets one post through for a wake since the last post, and only one', async () => {
    await tick();
    await firedAt(new Date());
    await tick();
    expect((await post('Count for today.')).success).toBe(true);
    expect((await post('And one more thing.')).reason).toBe('consecutive_run_cap');
  });

  it('finds the wake on a row from before instance ids were stored', async () => {
    await AgentInstallation.collection.updateOne({ agentName: 'daily' }, { $unset: { instanceId: '' } });
    await tick();
    await firedAt(new Date());
    await tick();
    expect((await post('Count for today.')).success).toBe(true);
  });

  it('finds the wake on a row whose stored id is mixed-case', async () => {
    await AgentInstallation.collection.updateOne({ agentName: 'daily' }, { $set: { instanceId: 'Morning' } });
    await tick();
    await firedAt(new Date());
    await tick();
    expect(await AgentMessageService.owedScheduledPost(pod._id, 'daily', 'morning', bot._id)).toBe(true);
  });
});
