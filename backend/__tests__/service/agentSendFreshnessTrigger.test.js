/**
 * F490: the send-freshness guard counted the mention that woke an agent as
 * unseen on the CAP post route. An MCP/CAP agent that read only the thread
 * (a thread read never advances the cursor) and then answered in it got a 409
 * naming its own trigger, and the 409 teaches continueAnyway, which defeats
 * the guard. The route now exempts exactly the message a delivered event for
 * this agent named, when the post answers it. Only that id: messages after it,
 * and older unread ones, still hold.
 */
/* eslint-disable import/extensions, import/no-unresolved -- backend TypeScript modules expose CJS exports. */
const mongoose = require('mongoose');
const Message = require('../../models/Message');
require('../../models/User');
const AgentEvent = require('../../models/AgentEvent');
const Cursor = require('../../models/AgentPodReadCursor');
const Freshness = require('../../services/agentSendFreshness');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

describe('F490: the waking mention is not unseen for the reply that answers it', () => {
  const originalPgHost = process.env.PG_HOST;
  const podId = new mongoose.Types.ObjectId();
  const otherPodId = new mongoose.Types.ObjectId();
  const agentId = new mongoose.Types.ObjectId();
  const peerId = new mongoose.Types.ObjectId();
  const agent = { agentName: 'codex', instanceId: 'sre-ops' };

  beforeAll(async () => {
    delete process.env.PG_HOST;
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
    if (originalPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = originalPgHost;
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    await Cursor.deleteMany({});
    await AgentEvent.deleteMany({});
  });

  const say = async (content, at = new Date()) => {
    const { insertedId } = await Message.collection.insertOne({
      podId, userId: peerId, content, messageType: 'text',
      createdAt: at, freshnessCommittedAt: at, freshnessPending: false,
    });
    return String(insertedId);
  };
  const event = (messageId, overrides = {}) => AgentEvent.create({
    ...agent, podId, type: 'chat.mention', status: 'delivered', payload: { messageId }, ...overrides,
  });

  describe('unseenMessages exemptMessageIds', () => {
    it('drops exactly the exempt message from the hold', async () => {
      const trigger = await say('@codex can you check this?');
      expect(await Freshness.unseenMessages(agentId, podId)).toMatchObject({ unseenCount: 1 });
      expect(await Freshness.unseenMessages(agentId, podId, { exemptMessageIds: [trigger] })).toBeNull();
    });

    it('a message after the trigger still holds', async () => {
      const trigger = await say('@codex can you check this?', new Date(Date.now() - 1000));
      await say('actually, never mind');
      const hold = await Freshness.unseenMessages(agentId, podId, { exemptMessageIds: [trigger] });
      expect(hold).toMatchObject({ unseenCount: 1, messages: [{ content: 'actually, never mind' }] });
    });

    it('an older unread message still holds (only the id, never everything up to it)', async () => {
      await say('an older unread line', new Date(Date.now() - 2000));
      const trigger = await say('@codex can you check this?');
      const hold = await Freshness.unseenMessages(agentId, podId, { exemptMessageIds: [trigger] });
      expect(hold).toMatchObject({ unseenCount: 1, messages: [{ content: 'an older unread line' }] });
    });
  });

  describe('deliveredTriggerIds', () => {
    it('names a message a delivered or acked event for this agent carried', async () => {
      const delivered = await say('one');
      const acked = await say('two');
      await event(delivered);
      await event(acked, { status: 'acked' });
      expect((await Freshness.deliveredTriggerIds({ ...agent, podId, candidateIds: [delivered, acked] })).sort())
        .toEqual([delivered, acked].sort());
    });

    it('names a message joined into a folded event', async () => {
      const first = await say('one');
      const joined = await say('two');
      await event(first, { payload: { messageId: first, coalesced: [{ messageId: joined }] } });
      expect(await Freshness.deliveredTriggerIds({ ...agent, podId, candidateIds: [joined] })).toEqual([joined]);
    });

    it('a forged id with no event, a pending event, or another agent\'s event names nothing', async () => {
      const forged = await say('nobody woke codex with this');
      const pending = await say('not delivered yet');
      const someoneElse = await say('for another agent');
      await event(pending, { status: 'pending' });
      await event(someoneElse, { agentName: 'claude' });
      await event(someoneElse, { instanceId: 'other' });
      expect(await Freshness.deliveredTriggerIds({
        ...agent, podId, candidateIds: [forged, pending, someoneElse],
      })).toEqual([]);
    });

    // Opus review on F490: a mention inside a thread is a reply under the root,
    // and the agent answers with threadRootId set to that root.
    it('names the mention a thread wake carried when the post answers its thread', async () => {
      const root = await say('the thread root');
      const mention = await say('@codex check this, in the thread');
      await event(mention, { payload: { messageId: mention, threadRootId: root } });
      expect(await Freshness.deliveredTriggerIds({ ...agent, podId, candidateIds: [root] })).toEqual([mention]);
      // And it is exactly that id: the root itself stays unseen if unread.
      const hold = await Freshness.unseenMessages(agentId, podId, { exemptMessageIds: [mention] });
      expect(hold).toMatchObject({ unseenCount: 1, messages: [{ content: 'the thread root' }] });
    });

    it('matches a numeric thread root stored as a number', async () => {
      const mention = await say('@codex in a PG-numbered thread');
      await event(mention, { payload: { messageId: mention, threadRootId: 133559 } });
      expect(await Freshness.deliveredTriggerIds({ ...agent, podId, candidateIds: ['133559'] })).toEqual([mention]);
    });

    it('a mention in another thread, or a digest row, names nothing', async () => {
      const elsewhere = await say('@codex in another thread');
      const digest = await say('ambient line');
      await event(elsewhere, { payload: { messageId: elsewhere, threadRootId: 'other-root' } });
      await event(digest, { status: 'acked', deliveryMode: 'digest' });
      expect(await Freshness.deliveredTriggerIds({
        ...agent, podId, candidateIds: ['this-root', digest],
      })).toEqual([]);
    });

    it('an event in another pod names nothing here', async () => {
      const trigger = await say('one');
      await event(trigger, { podId: otherPodId });
      expect(await Freshness.deliveredTriggerIds({ ...agent, podId, candidateIds: [trigger] })).toEqual([]);
    });

    it('ignores empty and malformed candidates without a query', async () => {
      const spy = jest.spyOn(AgentEvent, 'find');
      expect(await Freshness.deliveredTriggerIds({ ...agent, podId, candidateIds: [null, '', undefined] })).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
