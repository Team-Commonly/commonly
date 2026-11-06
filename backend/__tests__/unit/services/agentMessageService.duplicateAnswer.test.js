/**
 * F253: the logic of "a person asked this agent and that ask is still open".
 * What the event query actually matches is proved against real Mongo in
 * __tests__/service/duplicateAnswer.test.js; here the rows are stubbed so each
 * ordering and failure rule can be named on its own.
 */
jest.mock('../../../models/AgentEvent', () => ({ find: jest.fn() }));
jest.mock('../../../models/User', () => ({ exists: jest.fn() }));

const AgentEvent = require('../../../models/AgentEvent');
const User = require('../../../models/User');
const AgentMessageService = require('../../../services/agentMessageService');

const SEAT = 'seat-user';
const PERSON = 'person-user';
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
const row = (id, author, content, minutesAgo) => ({
  id, content, createdAt: at(minutesAgo), userId: { _id: author },
});
const eventRows = (rows) => AgentEvent.find.mockReturnValue({
  select: () => ({ lean: () => Promise.resolve(rows) }),
});

const check = (rows) => {
  AgentMessageService.getRecentMessages = jest.fn().mockResolvedValue(rows);
  return AgentMessageService.findRecentDuplicate({
    podId: 'pod-1', userId: SEAT, content: 'Blue', agentName: 'Claude-Code', instanceId: 'seat-1',
  });
};

describe('findRecentDuplicate and a person\'s open ask', () => {
  const original = AgentMessageService.getRecentMessages;
  beforeEach(() => {
    jest.clearAllMocks();
    eventRows([]);
    User.exists.mockResolvedValue(null);
  });
  afterAll(() => { AgentMessageService.getRecentMessages = original; });

  it('lets the repeat through when a person addressed this agent after its copy', async () => {
    eventRows([{ status: 'delivered', payload: { messageId: '12' } }]);
    User.exists.mockResolvedValue({ _id: PERSON });
    await expect(check([row(11, SEAT, 'Blue', 2), row(12, PERSON, '@seat again?', 1)])).resolves.toBeNull();
    expect(User.exists).toHaveBeenCalledWith({ _id: { $in: [PERSON] }, isBot: { $ne: true } });
  });

  it('reads no event when nobody spoke after the copy: the common skip costs no query', async () => {
    const duplicate = await check([row(11, SEAT, 'Blue', 2)]);
    expect(duplicate).toMatchObject({ id: 11, dedupeWindowMinutes: 30 });
    expect(AgentEvent.find).not.toHaveBeenCalled();
  });

  it('measures from the newest copy, so one ask buys one repeat', async () => {
    const duplicate = await check([
      row(11, SEAT, 'Blue', 3), row(12, PERSON, '@seat again?', 2), row(13, SEAT, 'Blue', 1),
    ]);
    expect(duplicate).toMatchObject({ id: 13 });
    expect(AgentEvent.find).not.toHaveBeenCalled();
  });

  it('asks only about messages after the copy, by other authors, on this agent\'s lowercased identity', async () => {
    await check([
      row(10, PERSON, '@seat first', 4), row(11, SEAT, 'Blue', 3),
      row(12, SEAT, 'Something else', 2), row(13, PERSON, 'hello', 1),
    ]);
    const [filter] = AgentEvent.find.mock.calls[0];
    expect(filter).toMatchObject({ agentName: { $eq: 'claude-code' }, instanceId: { $eq: 'seat-1' }, podId: { $eq: 'pod-1' } });
    expect(JSON.stringify(filter.$or)).toContain('"$in":["13"]');
  });

  it('keeps the guard when the agent is addressed only by another agent', async () => {
    eventRows([{ status: 'delivered', payload: { messageId: '12' } }]);
    User.exists.mockResolvedValue(null);
    await expect(check([row(11, SEAT, 'Blue', 2), row(12, 'other-agent', '@seat again?', 1)]))
      .resolves.toMatchObject({ id: 11 });
    expect(User.exists).toHaveBeenCalledWith({ _id: { $in: ['other-agent'] }, isBot: { $ne: true } });
  });

  it('takes the author of the joined message, not of the row it joined', async () => {
    eventRows([{ status: 'delivered', payload: { messageId: '9', coalesced: [{ messageId: '12' }] } }]);
    User.exists.mockResolvedValue({ _id: PERSON });
    await expect(check([row(11, SEAT, 'Blue', 2), row(12, PERSON, '@seat again?', 1)])).resolves.toBeNull();
    expect(User.exists).toHaveBeenCalledWith({ _id: { $in: [PERSON] }, isBot: { $ne: true } });
  });

  it('reads no event once the agent has posted since the ask: any post of its own closes it', async () => {
    const duplicate = await check([
      row(11, SEAT, 'Blue', 3), row(12, PERSON, '@seat hi', 2), row(13, SEAT, 'Hello!', 1),
    ]);
    expect(duplicate).toMatchObject({ id: 11 });
    expect(AgentEvent.find).not.toHaveBeenCalled();
  });

  it('a system line under the agent\'s name is not a post of its own', async () => {
    eventRows([{ status: 'delivered', payload: { messageId: '12' } }]);
    User.exists.mockResolvedValue({ _id: PERSON });
    await expect(check([
      row(11, SEAT, 'Blue', 3), row(12, PERSON, '@seat again?', 2),
      { ...row(13, SEAT, 'took this', 1), messageType: 'system' },
    ])).resolves.toBeNull();
  });

  it.each([
    ['a welcome wake', { welcomeWake: true }],
    ['a person following the agent with no @', { adjacentReply: true, implicitReply: true }],
    ['a kernel wake', { triggerAuthor: 'kernel' }],
    ['a reply that @s someone else', { implicitReply: true, mentions: ['bob'] }],
  ])('keeps the guard for %s', async (_name, payload) => {
    eventRows([{ status: 'delivered', payload: { messageId: '12', ...payload } }]);
    User.exists.mockResolvedValue({ _id: PERSON });
    await expect(check([row(11, SEAT, 'Blue', 2), row(12, PERSON, 'text', 1)])).resolves.toMatchObject({ id: 11 });
  });

  it('counts a plain reply to the agent, with no @ in it', async () => {
    eventRows([{ status: 'delivered', payload: { messageId: '12', implicitReply: true, mentions: [] } }]);
    User.exists.mockResolvedValue({ _id: PERSON });
    await expect(check([row(11, SEAT, 'Blue', 2), row(12, PERSON, 'and now?', 1)])).resolves.toBeNull();
  });

  it('a joined message marked as no ask does not count', async () => {
    eventRows([{ status: 'delivered', payload: { messageId: '9', coalesced: [{ messageId: '12', notAnAsk: true }] } }]);
    User.exists.mockResolvedValue({ _id: PERSON });
    await expect(check([row(11, SEAT, 'Blue', 2), row(12, PERSON, '@bob look', 1)])).resolves.toMatchObject({ id: 11 });
  });

  it('a person\'s @ joined to a wake that would not count still counts', async () => {
    eventRows([{ status: 'delivered', payload: { messageId: '9', adjacentReply: true, coalesced: [{ messageId: '12' }] } }]);
    User.exists.mockResolvedValue({ _id: PERSON });
    await expect(check([row(11, SEAT, 'Blue', 2), row(12, PERSON, '@seat again?', 1)])).resolves.toBeNull();
  });

  describe('an ask whose row is finished', () => {
    const acked = (delivery, secondsAgo) => ({
      status: 'acked', delivery, deliveredAt: new Date(Date.now() - secondsAgo * 1000), payload: { messageId: '12' },
    });
    const rows = [row(11, SEAT, 'Blue', 2), row(12, PERSON, '@seat again?', 1)];
    beforeEach(() => User.exists.mockResolvedValue({ _id: PERSON }));

    it('stays open just after a checkpoint, which acks mid-turn', async () => {
      eventRows([acked({ outcome: 'acknowledged', reason: 'handled-checkpoint' }, 2)]);
      await expect(check(rows)).resolves.toBeNull();
    });

    it('stays open for an ack that recorded no outcome, which defaults to acknowledged', async () => {
      eventRows([acked(undefined, 2)]);
      await expect(check(rows)).resolves.toBeNull();
    });

    it.each(['no_action', 'skipped', 'error', 'posted'])('closes on a %s ack', async (outcome) => {
      eventRows([acked({ outcome }, 2)]);
      await expect(check(rows)).resolves.toMatchObject({ id: 11 });
    });

    it('closes once a checkpointed turn cannot still be running', async () => {
      eventRows([acked({ outcome: 'acknowledged' }, 11 * 60)]);
      await expect(check(rows)).resolves.toMatchObject({ id: 11 });
    });

    it('stays open for a turn that outlives the window without a checkpoint', async () => {
      eventRows([{ status: 'delivered', deliveredAt: new Date(Date.now() - 20 * 60 * 1000), payload: { messageId: '12' } }]);
      await expect(check(rows)).resolves.toBeNull();
    });

    it('closes on a failed row', async () => {
      eventRows([{ status: 'failed', payload: { messageId: '12' } }]);
      await expect(check(rows)).resolves.toMatchObject({ id: 11 });
    });
  });

  // Review checklist rule 19: a guard that can't tell fails toward a noisier pod.
  it('lets the repeat through when the event read fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AgentEvent.find.mockImplementation(() => { throw new Error('mongo down'); });
    await expect(check([row(11, SEAT, 'Blue', 2), row(12, PERSON, '@seat again?', 1)])).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps the guard on a failed read when only other agents spoke', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AgentEvent.find.mockImplementation(() => { throw new Error('mongo down'); });
    await expect(check([row(11, SEAT, 'Blue', 2), { ...row(12, PERSON, 'Blue', 1), isBot: true }]))
      .resolves.toMatchObject({ id: 11 });
    warn.mockRestore();
  });

  it('lets the repeat through when the author read fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    eventRows([{ status: 'delivered', payload: { messageId: '12' } }]);
    User.exists.mockRejectedValue(new Error('mongo down'));
    await expect(check([row(11, SEAT, 'Blue', 2), row(12, PERSON, '@seat again?', 1)])).resolves.toBeNull();
    warn.mockRestore();
  });

  it('holds the guard on no reason to look: a failed read costs nothing when nobody spoke', async () => {
    AgentEvent.find.mockImplementation(() => { throw new Error('mongo down'); });
    await expect(check([row(11, SEAT, 'Blue', 2)])).resolves.toMatchObject({ id: 11 });
  });

  it('keeps the guard for a caller that names no agent', async () => {
    AgentMessageService.getRecentMessages = jest.fn()
      .mockResolvedValue([row(11, SEAT, 'Blue', 2), row(12, PERSON, '@seat again?', 1)]);
    await expect(AgentMessageService.findRecentDuplicate({ podId: 'pod-1', userId: SEAT, content: 'Blue' }))
      .resolves.toMatchObject({ id: 11 });
    expect(AgentEvent.find).not.toHaveBeenCalled();
  });
});
