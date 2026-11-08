// A daily job in a quiet pod is the same author every day, so the run cap would
// refuse it from the fourth day. Real Mongo and the real postMessage.
process.env.PG_HOST = '';
const mongoose = require('mongoose');
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

  it('lets a wake\'s turn through, up to its post limit', async () => {
    await tick();
    await firedAt(new Date());
    await tick();
    expect((await post('Count for today.')).success).toBe(true);
    expect((await post('The detail behind it.')).success).toBe(true);
    for (let n = 3; n <= AgentMessageService.OWED_POSTS_PER_WAKE; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await post(`Detail ${n}.`)).success).toBe(true);
    }
    expect((await post('One past the limit.')).reason).toBe('consecutive_run_cap');
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

  it('reads the row that carries the wake when a legacy row sits beside it', async () => {
    const legacy = await AgentInstallation.findOne({ agentName: 'daily' }).lean();
    await AgentInstallation.collection.insertOne({
      ...legacy, _id: new mongoose.Types.ObjectId(), instanceId: 'Default',
    });
    await tick();
    await AgentInstallation.collection.updateOne(
      { agentName: 'daily', instanceId: 'Default' },
      { $set: { 'config.schedule.lastFiredAt': new Date() } },
    );
    await tick();
    expect(await AgentMessageService.owedScheduledPost(pod._id, 'daily', 'default', bot._id)).toBe(true);
  });

  it('gives no exemption for a wake on another instance', async () => {
    await AgentInstallation.collection.updateOne({ agentName: 'daily' }, { $set: { instanceId: 'evening' } });
    await tick();
    await firedAt(new Date());
    await tick();
    expect(await AgentMessageService.owedScheduledPost(pod._id, 'daily', 'default', bot._id)).toBe(false);
  });
});

// A heartbeat wake is owed the same one post per fire (Triage's sweep line in a
// two-member pod was refused at run 3). Heartbeats are AgentEvent rows; a hosted
// turn runs from the row enqueue creates, born 'delivered'.
describe('a heartbeat post and the run cap', () => {
  const AgentEvent = require('../../models/AgentEvent');
  const MINUTE = 60 * 1000;
  let pod;
  let otherPod;
  let bot;
  const post = (content) => AgentMessageService.postMessage({
    agentName: 'sweeper', instanceId: 'default', podId: pod._id, content,
  });
  // Moves the clock forward by `ms`: every message and heartbeat goes back that
  // far, keeping their order.
  const ageMessages = async (ms) => {
    const back = [{ $set: { createdAt: { $subtract: ['$createdAt', ms] } } }];
    await mongoose.connection.collection('messages').updateMany({}, back);
    await AgentEvent.collection.updateMany({}, back);
  };
  const beat = async ({
    agoMs = 0, agentName = 'sweeper', instanceId = 'default', podId, status = 'acked', trigger = 'interval',
    deliveredAgoMs,
  } = {}) => {
    const event = await AgentEvent.create({
      agentName, instanceId, podId: podId || pod._id, type: 'heartbeat', status, payload: { trigger },
    });
    await AgentEvent.collection.updateOne(
      { _id: event._id }, { $set: {
        createdAt: new Date(Date.now() - agoMs),
        ...(deliveredAgoMs === undefined ? {} : { deliveredAt: new Date(Date.now() - deliveredAgoMs) }),
      } },
    );
  };

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    const owner = await User.create({ username: 'hb-owner', email: 'ho@test.com', password: 'password123' });
    bot = await User.create({
      username: 'sweeper-bot', email: 'sb@test.com', password: 'password123', isBot: true,
      botMetadata: { agentName: 'sweeper', instanceId: 'default' },
    });
    pod = await Pod.create({ name: 'Triage', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
    otherPod = await Pod.create({ name: 'Elsewhere', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
    await AgentInstallation.create({
      agentName: 'sweeper', instanceId: 'default', podId: pod._id, version: '1', installedBy: owner._id, status: 'active',
      config: new Map([
        ['runtime', { runtimeType: 'hosted' }],
        ['heartbeat', { enabled: true, everyMinutes: 240 }],
      ]),
    });
    for (const sweep of ['first', 'second', 'third']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await post(`Sweep ${sweep}: nothing new.`)).success).toBe(true);
    }
    // Hours of quiet since the agent's last line.
    await ageMessages(5 * 60 * MINUTE);
  });

  it('lets a heartbeat fired since the last post through the cap once', async () => {
    expect((await post('Before any heartbeat.')).reason).toBe('consecutive_run_cap');
    await beat({ agoMs: MINUTE, status: 'delivered' });
    expect((await post('Sweep: one new issue.')).success).toBe(true);
  });

  // Triage's 21:28Z sweep: "Swept: 1 new" posted and its finding was refused.
  it('lets a heartbeat\'s line and its detail both through on a quiet pod', async () => {
    await beat({ agoMs: MINUTE, status: 'delivered' });
    expect((await post('Swept: 1 new.')).success).toBe(true);
    expect((await post('New: the finding, for whoever owns it.')).success).toBe(true);
  });

  it('stops a heartbeat\'s turn at its post limit', async () => {
    await beat({ agoMs: MINUTE });
    for (let n = 1; n <= AgentMessageService.OWED_POSTS_PER_WAKE; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await post(`Finding ${n}.`)).success).toBe(true);
    }
    expect((await post('A flood.')).reason).toBe('consecutive_run_cap');
  });

  it('holds a short heartbeat to one turn an hour, however full that turn was', async () => {
    await beat({ agoMs: MINUTE });
    for (let n = 1; n <= AgentMessageService.OWED_POSTS_PER_WAKE; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await post(`Finding ${n}.`)).success).toBe(true);
    }
    // Ten minutes later the next heartbeat fires; the turn's own lines are
    // the last posts before it, inside the floor.
    await ageMessages(10 * MINUTE);
    await beat();
    expect((await post('Ten minutes on.')).reason).toBe('consecutive_run_cap');
    await ageMessages(60 * MINUTE);
    await beat();
    expect((await post('An hour on.')).success).toBe(true);
  });

  it('keeps a turn open when the next heartbeat lands in the middle of it', async () => {
    await beat({ agoMs: 2 * MINUTE });
    expect((await post('Swept: 1 new.')).success).toBe(true);
    await beat();
    expect((await post('The finding.')).success).toBe(true);
  });

  it('times the turn from delivery, so a seat that polls late keeps its detail', async () => {
    await beat({ agoMs: 40 * MINUTE, deliveredAgoMs: MINUTE });
    expect((await post('Swept: 1 new.')).success).toBe(true);
    expect((await post('The finding.')).success).toBe(true);
  });

  it('closes the turn after its window, until the next heartbeat', async () => {
    await beat({ agoMs: MINUTE });
    expect((await post('Sweep: one new issue.')).success).toBe(true);
    // The same wake, past its window: no longer this turn's output.
    await ageMessages(AgentMessageService.OWED_TURN_WINDOW_MS);
    expect((await post('And another thing.')).reason).toBe('consecutive_run_cap');
    // Past the floor, but no heartbeat since that post.
    await ageMessages(5 * 60 * MINUTE);
    expect((await post('Still nothing.')).reason).toBe('consecutive_run_cap');
    await beat({ agoMs: MINUTE });
    expect((await post('Next sweep.')).success).toBe(true);
  });

  it('owes nothing for a heartbeat older than the last post', async () => {
    await beat({ agoMs: 6 * 60 * MINUTE });
    expect((await post('Late line.')).reason).toBe('consecutive_run_cap');
    await beat({ agoMs: MINUTE });
    expect((await post('On the new heartbeat.')).success).toBe(true);
  });

  it('owes nothing for another agent\'s or another pod\'s heartbeat', async () => {
    await beat({ agentName: 'someone-else' });
    await beat({ instanceId: 'evening' });
    await beat({ podId: otherPod._id });
    expect((await post('Borrowed wake.')).reason).toBe('consecutive_run_cap');
    expect(await AgentMessageService.owedScheduledPost(pod._id, 'sweeper', 'default', bot._id)).toBe(false);
    await beat();
    expect(await AgentMessageService.owedScheduledPost(pod._id, 'sweeper', 'default', bot._id)).toBe(true);
  });

  it('owes nothing for a heartbeat still pending', async () => {
    await beat({ status: 'pending' });
    expect((await post('Not woken yet.')).reason).toBe('consecutive_run_cap');
    await beat({ status: 'delivered' });
    expect((await post('Woken.')).success).toBe(true);
  });

  it('holds a 10-minute heartbeat to the floor, so it cannot drip into a quiet pod', async () => {
    await AgentInstallation.updateOne(
      { agentName: 'sweeper' }, { $set: { 'config.heartbeat.everyMinutes': 10 } },
    );
    // The last line is 20 minutes old and a heartbeat fired 5 minutes ago.
    await ageMessages(-(5 * 60 - 20) * MINUTE);
    await beat({ agoMs: 5 * MINUTE });
    expect((await post('Ten-minute sweep.')).reason).toBe('consecutive_run_cap');
    // Once the last line is past the floor (60 minutes), the next heartbeat
    // earns its post.
    await ageMessages(60 * MINUTE);
    await beat({ agoMs: MINUTE });
    expect((await post('An hour on.')).success).toBe(true);
  });

  it('finds the heartbeat of a row whose stored id is mixed-case', async () => {
    await AgentInstallation.collection.updateOne({ agentName: 'sweeper' }, { $set: { instanceId: 'Morning' } });
    await beat({ instanceId: 'Morning' });
    expect(await AgentMessageService.owedScheduledPost(pod._id, 'sweeper', 'morning', bot._id)).toBe(true);
  });

  it('counts an unread-digest heartbeat like any other', async () => {
    await beat({ trigger: 'unread-digest' });
    expect(await AgentMessageService.owedScheduledPost(pod._id, 'sweeper', 'default', bot._id)).toBe(true);
  });
});
