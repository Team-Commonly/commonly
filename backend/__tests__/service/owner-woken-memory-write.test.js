/**
 * F145: a public seat writes memory only on a turn its owner woke.
 *
 * Runs the real path: runtime auth, the mint route, the ledger row and the
 * memory routes, over in-memory Mongo. The verification is the whole feature,
 * so nothing it reads is mocked: a mock here would only assert the field names
 * this test guessed. A body field can't set either marker, so each marker case
 * goes through a real event row.
 */
const express = require('express');
const request = require('supertest');
const { Types } = require('mongoose');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent').default || require('../../models/AgentEvent');
const AgentMemory = require('../../models/AgentMemory');
const AgentCredential = require('../../models/AgentCredential').default || require('../../models/AgentCredential');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { hash } = require('../../utils/secret');
const AgentEventService = require('../../services/agentEventService');
const AgentMentionService = require('../../services/agentMentionService');

const agentsRuntimeRoutes = require('../../routes/agentsRuntime');
const spawnCredentialRoutes = require('../../routes/spawnCredentials');

jest.setTimeout(60000);

const AGENT = 'scribe';
const INSTANCE = 'owned';
const BASE = '/api/agents/runtime';
const MINT = `${BASE}/spawn-credentials`;
const SEAT_TOKEN = 'cm_agent_f145seat';

describe('F145 owner-woken memory writes on a public seat', () => {
  let app;
  let owner;
  let stranger;
  let bot;
  let otherBot;
  let pod;

  const install = (installedBy, podId, overrides = {}) => AgentInstallation.create({
    agentName: AGENT, instanceId: INSTANCE, podId, version: '1.0.0', installedBy, status: 'active', ...overrides,
  });

  const wake = (payload, overrides = {}) => AgentEvent.create({
    agentName: AGENT, instanceId: INSTANCE, podId: pod._id, type: 'chat.mention', status: 'delivered', payload, ...overrides,
  });

  const mentionFrom = (user, overrides = {}) => wake({
    messageId: '101', userId: String(user._id), username: user.username, content: 'hi', rawContent: 'hi', ...overrides,
  });

  const mint = (body, token = SEAT_TOKEN) => request(app)
    .post(MINT).set('Authorization', `Bearer ${token}`).send({ spawnId: `${AGENT}:turn`, ...body });

  const scopesOf = async (res) => (await AgentCredential.findById(res.body.credentialId).lean()).scopes;

  const putMemory = (token, content = 'kept') => request(app)
    .put(`${BASE}/memory`).set('Authorization', `Bearer ${token}`).send({ content });

  const syncMemory = (token, sections = { long_term: { content: 'kept', visibility: 'private' } }) => request(app)
    .post(`${BASE}/memory/sync`).set('Authorization', `Bearer ${token}`).send({ mode: 'patch', sections });

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use(MINT, spawnCredentialRoutes);
    app.use(BASE, agentsRuntimeRoutes);
  });

  afterAll(async () => { await closeMongoDb(); });

  beforeEach(async () => {
    await clearMongoDb();
    owner = await User.create({ username: 'f145-owner', email: 'owner@f145.test', password: 'password123' });
    stranger = await User.create({ username: 'f145-stranger', email: 'stranger@f145.test', password: 'password123' });
    bot = await User.create({
      username: `${AGENT}-${INSTANCE}`,
      email: 'bot@f145.test',
      password: 'password123',
      isBot: true,
      botMetadata: { agentName: AGENT, instanceId: INSTANCE, ownerUserId: owner._id },
      agentRuntimeTokens: [{ tokenHash: hash(SEAT_TOKEN), label: 'seat', createdAt: new Date() }],
    });
    otherBot = await User.create({
      username: 'other-bot', email: 'other@f145.test', password: 'password123', isBot: true,
      botMetadata: { agentName: 'other', instanceId: 'default' },
    });
    pod = await Pod.create({ name: 'Public', type: 'chat', createdBy: owner._id, members: [owner._id, stranger._id, bot._id] });
    await install(owner._id, pod._id);
  });

  describe('the mint marks a public child only on a turn its owner woke', () => {
    it('marks an owner mention, and tells the supervisor', async () => {
      const event = await mentionFrom(owner);
      const res = await mint({ publicSeat: true, eventIds: [String(event._id)] });
      expect(res.status).toBe(201);
      expect(res.body.ownerWoken).toBe(true);
      expect(await scopesOf(res)).toEqual(['spawn', 'public-seat', 'owner-woken']);
    });

    it('marks an owner DM, which carries the sender with no senderIsHuman stamp', async () => {
      const event = await mentionFrom(owner, { source: 'dm', dmKind: 'user-agent' });
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(true);
    });

    it('marks an owner comment on a post, which has no messageId', async () => {
      const event = await wake({
        userId: String(owner._id), username: owner.username, content: 'c', rawContent: 'c',
        thread: { postId: String(new Types.ObjectId()) }, source: 'thread',
      });
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(true);
    });

    it('marks an owner message that woke an opted-in seat', async () => {
      const event = await mentionFrom(owner, {});
      await AgentEvent.updateOne({ _id: event._id }, { $set: { type: 'message.posted' } });
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(true);
    });

    it('marks a batch only when every event is the owner\'s', async () => {
      const first = await mentionFrom(owner);
      const second = await mentionFrom(owner, { messageId: '102' });
      const res = await mint({ publicSeat: true, eventIds: [String(first._id), String(second._id)] });
      expect(res.body.ownerWoken).toBe(true);
    });

    it('does not mark one event from a stranger, an agent, or nobody', async () => {
      const cases = [
        await mentionFrom(stranger),
        await mentionFrom(otherBot),
        await wake({ messageId: '103', content: 'no sender' }),
        await wake({ messageId: '104', userId: 'not-an-id', content: 'junk sender' }),
        await wake({ messageId: '105', userId: String(new Types.ObjectId()), content: 'no such user' }),
        await wake({ messageId: '106', userId: { $ne: null }, content: 'object sender' }),
      ];
      for (const event of cases) {
        // eslint-disable-next-line no-await-in-loop
        const res = await mint({ publicSeat: true, eventIds: [String(event._id)] });
        expect(res.status).toBe(201);
        expect(res.body.ownerWoken).toBe(false);
        // eslint-disable-next-line no-await-in-loop
        expect(await scopesOf(res)).toEqual(['spawn', 'public-seat']);
      }
    });

    // An agent can be the sole installer of another agent, so ownership alone
    // would pass here: only the check that the sender is a person stops it.
    it('does not mark an agent that is the sole installer', async () => {
      await AgentInstallation.updateMany({ agentName: AGENT }, { $set: { installedBy: otherBot._id } });
      const event = await mentionFrom(otherBot);
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(false);
    });

    it('does not mark a heartbeat, a first contact or any other typed wake, even naming the owner', async () => {
      for (const type of ['heartbeat', 'first_contact', 'summary.request', 'decision.ruled', 'ensemble.turn']) {
        // eslint-disable-next-line no-await-in-loop
        const event = await mentionFrom(owner);
        // eslint-disable-next-line no-await-in-loop
        await AgentEvent.updateOne({ _id: event._id }, { $set: { type } });
        // eslint-disable-next-line no-await-in-loop
        const res = await mint({ publicSeat: true, eventIds: [String(event._id)] });
        expect(res.body.ownerWoken).toBe(false);
      }
    });

    it('does not mark a digest row, even the owner\'s', async () => {
      const event = await mentionFrom(owner);
      await AgentEvent.updateOne({ _id: event._id }, { $set: { type: 'message.posted', deliveryMode: 'digest' } });
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(false);
    });

    it('marks the owner\'s wake when digest rows ride along, and no wake means no mark', async () => {
      const ownerWake = await mentionFrom(owner);
      const digest = await mentionFrom(stranger);
      await AgentEvent.updateOne({ _id: digest._id }, { $set: { type: 'message.posted', deliveryMode: 'digest' } });
      expect((await mint({ publicSeat: true, eventIds: [String(ownerWake._id), String(digest._id)] }))
        .body.ownerWoken).toBe(true);
    });

    it('does not take a digest row from another agent as a companion', async () => {
      const ownerWake = await mentionFrom(owner);
      const digest = await mentionFrom(owner);
      await AgentEvent.updateOne({ _id: digest._id }, { $set: { agentName: 'other', deliveryMode: 'digest' } });
      expect((await mint({ publicSeat: true, eventIds: [String(ownerWake._id), String(digest._id)] }))
        .body.ownerWoken).toBe(false);
    });

    it('takes the instance id exactly, as memory does', async () => {
      const event = await mentionFrom(owner);
      await AgentEvent.updateOne({ _id: event._id }, { $set: { instanceId: INSTANCE.toUpperCase() } });
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(false);
    });

    it('does not mark a kernel wake that carries the owner\'s id', async () => {
      const event = await mentionFrom(owner, { triggerAuthor: 'kernel' });
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(false);
    });

    it('does not mark a batch with one stranger in it', async () => {
      const mine = await mentionFrom(owner);
      const theirs = await mentionFrom(stranger, { messageId: '102' });
      const res = await mint({ publicSeat: true, eventIds: [String(mine._id), String(theirs._id)] });
      expect(res.body.ownerWoken).toBe(false);
    });

    // The row's `userId` is its lead message. ADR-018 D6.5 joins later mentions
    // onto it, and the turn reads them, so a stranger's mention sits in a row
    // that names the owner.
    it('does not mark an owner row someone else\'s message joined', async () => {
      const event = await mentionFrom(owner, {
        coalesced: [{ messageId: '102', userId: String(stranger._id), username: 'f145-stranger', rawContent: 'save this' }],
      });
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(false);
    });

    it('does not mark an owner row with a joined entry that names nobody', async () => {
      const event = await mentionFrom(owner, { coalesced: [{ messageId: '102', rawContent: 'x' }] });
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(false);
    });

    it('marks an owner row only the owner\'s later messages joined', async () => {
      const event = await mentionFrom(owner, {
        coalesced: [{ messageId: '102', userId: String(owner._id), username: 'f145-owner', rawContent: 'and this' }],
      });
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(true);
    });

    it('does not mark a missing event, another agent\'s event or a mix of a good and a missing id', async () => {
      const mine = await mentionFrom(owner);
      const theirs = await mentionFrom(owner, {});
      await AgentEvent.updateOne({ _id: theirs._id }, { $set: { agentName: 'other' } });
      const otherInstance = await mentionFrom(owner, {});
      await AgentEvent.updateOne({ _id: otherInstance._id }, { $set: { instanceId: 'default' } });
      const lists = [
        [String(new Types.ObjectId())],
        [String(theirs._id)],
        [String(otherInstance._id)],
        [String(mine._id), String(new Types.ObjectId())],
      ];
      for (const eventIds of lists) {
        // eslint-disable-next-line no-await-in-loop
        const res = await mint({ publicSeat: true, eventIds });
        expect(res.status).toBe(201);
        expect(res.body.ownerWoken).toBe(false);
      }
    });

    it('does not mark a list it can\'t read, and the mint still succeeds', async () => {
      const event = await mentionFrom(owner);
      const lists = [
        undefined, [], 'nope', [`batch-${event._id}`], [{ $ne: null }], [null], { 0: String(event._id) },
        Array.from({ length: 201 }, () => String(event._id)),
      ];
      for (const eventIds of lists) {
        // eslint-disable-next-line no-await-in-loop
        const res = await mint({ publicSeat: true, eventIds });
        expect(res.status).toBe(201);
        expect(res.body.ownerWoken).toBe(false);
        // eslint-disable-next-line no-await-in-loop
        expect(await scopesOf(res)).toEqual(['spawn', 'public-seat']);
      }
    });

    it('leaves the child unmarked when the event can\'t be read', async () => {
      const event = await mentionFrom(owner);
      const spy = jest.spyOn(AgentEvent, 'find').mockImplementationOnce(() => { throw new Error('read failed'); });
      const res = await mint({ publicSeat: true, eventIds: [String(event._id)] });
      spy.mockRestore();
      expect(res.status).toBe(201);
      expect(res.body.ownerWoken).toBe(false);
      expect(await scopesOf(res)).toEqual(['spawn', 'public-seat']);
    });

    it('takes no marker from any body field', async () => {
      const res = await mint({
        publicSeat: true, ownerWoken: true, owner_woken: true, scopes: ['spawn', 'owner-woken'],
        marker: 'owner-woken', senderId: String(owner._id),
      });
      expect(res.body.ownerWoken).toBe(false);
      expect(await scopesOf(res)).toEqual(['spawn', 'public-seat']);
    });

    it('takes only a literal true for publicSeat', async () => {
      const event = await mentionFrom(owner);
      for (const publicSeat of ['true', 1, {}, []]) {
        // eslint-disable-next-line no-await-in-loop
        const res = await mint({ publicSeat, eventIds: [String(event._id)] });
        expect(res.body.ownerWoken).toBe(false);
        // eslint-disable-next-line no-await-in-loop
        expect(await scopesOf(res)).toEqual(['spawn']);
      }
    });

    it('leaves a private seat\'s child as it was', async () => {
      const event = await mentionFrom(owner);
      const res = await mint({ eventIds: [String(event._id)] });
      expect(res.body.ownerWoken).toBe(false);
      expect(await scopesOf(res)).toEqual(['spawn']);
    });

    // Sole-installer rule, the same one the owner's memory editor applies.
    it('does not mark anyone on an identity two people installed', async () => {
      await install(stranger._id, new Types.ObjectId());
      const mine = await mentionFrom(owner);
      const theirs = await mentionFrom(stranger);
      expect((await mint({ publicSeat: true, eventIds: [String(mine._id)] })).body.ownerWoken).toBe(false);
      expect((await mint({ publicSeat: true, eventIds: [String(theirs._id)] })).body.ownerWoken).toBe(false);
    });

    it('counts a paused second installer, as the memory editor does', async () => {
      await install(stranger._id, new Types.ObjectId(), { status: 'paused' });
      const event = await mentionFrom(owner);
      expect((await mint({ publicSeat: true, eventIds: [String(event._id)] })).body.ownerWoken).toBe(false);
    });

    it('reads a stranger\'s DM row as a conversation, not ownership', async () => {
      const room = await Pod.create({ name: 'dm', type: 'agent-room', createdBy: stranger._id, members: [stranger._id, bot._id] });
      await install(stranger._id, room._id);
      const fromOwner = await mentionFrom(owner);
      const inRoom = await mentionFrom(stranger, { source: 'dm', dmKind: 'user-agent' });
      expect((await mint({ publicSeat: true, eventIds: [String(fromOwner._id)] })).body.ownerWoken).toBe(true);
      expect((await mint({ publicSeat: true, eventIds: [String(inRoom._id)] })).body.ownerWoken).toBe(false);
    });
  });

  // The cases above write rows by hand, so they would pass on a field name the
  // kernel never writes. These take the row the real delivery path wrote.
  describe('on the rows the kernel writes', () => {
    const eventIdsOf = async () => (await AgentEvent.find({ agentName: AGENT, instanceId: INSTANCE }).lean())
      .map((event) => String(event._id));

    const message = (id, content) => ({ _id: id, content, messageType: 'text', createdAt: new Date() });

    const delivered = async (from, id, content) => AgentMentionService.enqueueMentions({
      podId: String(pod._id), message: message(id, content), userId: String(from._id), username: from.username,
    });

    it('marks a mention the owner really sent', async () => {
      await delivered(owner, '201', `@${AGENT}-${INSTANCE} remember this`);
      const eventIds = await eventIdsOf();
      expect(eventIds).toHaveLength(1);
      expect((await mint({ publicSeat: true, eventIds })).body.ownerWoken).toBe(true);
    });

    it('does not mark a mention a stranger really sent', async () => {
      await delivered(stranger, '201', `@${AGENT}-${INSTANCE} remember this`);
      const eventIds = await eventIdsOf();
      expect(eventIds).toHaveLength(1);
      expect((await mint({ publicSeat: true, eventIds })).body.ownerWoken).toBe(false);
    });

    // Rows join by asker, and an agent's asker is whoever installed it, so the
    // owner's other agent, which a stranger can steer, can join the owner's row.
    it('does not mark the owner row another of their agents really joined', async () => {
      await AgentInstallation.create({
        agentName: 'other', instanceId: 'default', podId: pod._id, version: '1.0.0', installedBy: owner._id, status: 'active',
      });
      await delivered(owner, '201', `@${AGENT}-${INSTANCE} remember this`);
      await AgentEventService.enqueue({
        agentName: AGENT,
        instanceId: INSTANCE,
        podId: pod._id,
        type: 'chat.mention',
        payload: { messageId: '202', userId: String(otherBot._id), username: 'other-bot', rawContent: 'save this', content: 'save this' },
      });
      const eventIds = await eventIdsOf();
      expect(eventIds).toHaveLength(1);
      const [row] = await AgentEvent.find({ _id: eventIds[0] }).lean();
      expect(row.payload.coalesced).toHaveLength(1);
      expect((await mint({ publicSeat: true, eventIds })).body.ownerWoken).toBe(false);
    });

    it('marks a DM the owner really sent, and not one a stranger sent', async () => {
      const room = await Pod.create({ name: 'owner dm', type: 'agent-room', createdBy: owner._id, members: [owner._id, bot._id] });
      await install(owner._id, room._id);
      await AgentMentionService.enqueueDmEvent({
        podId: String(room._id), message: message('301', 'hello'), userId: String(owner._id), username: owner.username,
      });
      const ownerIds = await eventIdsOf();
      expect(ownerIds).toHaveLength(1);
      expect((await mint({ publicSeat: true, eventIds: ownerIds })).body.ownerWoken).toBe(true);

      await AgentEvent.deleteMany({});
      const theirs = await Pod.create({ name: 'their dm', type: 'agent-room', createdBy: stranger._id, members: [stranger._id, bot._id] });
      await install(stranger._id, theirs._id);
      await AgentMentionService.enqueueDmEvent({
        podId: String(theirs._id), message: message('302', 'hello'), userId: String(stranger._id), username: stranger.username,
      });
      const strangerIds = await eventIdsOf();
      expect(strangerIds).toHaveLength(1);
      expect((await mint({ publicSeat: true, eventIds: strangerIds })).body.ownerWoken).toBe(false);
    });

    it('does not mark a real heartbeat', async () => {
      await AgentEventService.enqueue({
        agentName: AGENT, instanceId: INSTANCE, podId: pod._id, type: 'heartbeat', payload: { trigger: 'test' },
      });
      expect((await mint({ publicSeat: true, eventIds: await eventIdsOf() })).body.ownerWoken).toBe(false);
    });
  });

  describe('the memory routes refuse an unmarked public child', () => {
    const publicChild = async () => (await mint({ publicSeat: true, eventIds: [String((await mentionFrom(stranger))._id)] })).body.token;
    const ownerChild = async () => (await mint({ publicSeat: true, eventIds: [String((await mentionFrom(owner))._id)] })).body.token;

    it('refuses PUT /memory and writes nothing', async () => {
      const res = await putMemory(await publicChild());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('memory_write_owner_only');
      expect(res.body.message).toMatch(/owner/);
      expect(await AgentMemory.countDocuments({})).toBe(0);
    });

    it('refuses POST /memory/sync and writes nothing', async () => {
      const res = await syncMemory(await publicChild());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('memory_write_owner_only');
      expect(await AgentMemory.countDocuments({})).toBe(0);
    });

    it('refuses a cycle through both routes, the commonly_log_cycle path included', async () => {
      const token = await publicChild();
      const cycles = { cycles: { append: { content: 'a cycle' } } };
      expect((await syncMemory(token, cycles)).body.code).toBe('memory_write_owner_only');
      const put = await request(app).put(`${BASE}/memory`).set('Authorization', `Bearer ${token}`).send({ sections: cycles });
      expect(put.body.code).toBe('memory_write_owner_only');
      expect(await AgentMemory.countDocuments({})).toBe(0);
    });

    it('refuses before it validates, so a bad body says the same thing', async () => {
      const res = await request(app).put(`${BASE}/memory`).set('Authorization', `Bearer ${await publicChild()}`).send({});
      expect(res.status).toBe(403);
    });

    it('still lets the unmarked child read', async () => {
      const res = await request(app).get(`${BASE}/memory`).set('Authorization', `Bearer ${await publicChild()}`);
      expect(res.status).toBe(200);
    });

    it('lets a marked child write through both routes', async () => {
      const token = await ownerChild();
      expect((await putMemory(token, 'first')).status).toBe(200);
      expect((await syncMemory(token)).status).toBe(200);
      expect((await AgentMemory.findOne({ agentName: AGENT, instanceId: INSTANCE }).lean()).sections.long_term.content).toBe('kept');
    });

    it('lets a marked child log a cycle', async () => {
      const res = await syncMemory(await ownerChild(), { cycles: { append: { content: 'a cycle' } } });
      expect(res.status).toBe(200);
      expect((await AgentMemory.findOne({ agentName: AGENT, instanceId: INSTANCE }).lean()).sections.cycles.entries).toHaveLength(1);
    });

    it('leaves a private seat\'s child alone', async () => {
      const { token } = (await mint({})).body;
      expect((await putMemory(token)).status).toBe(200);
      expect((await syncMemory(token)).status).toBe(200);
    });

    it('leaves the seat\'s own token alone', async () => {
      expect((await putMemory(SEAT_TOKEN)).status).toBe(200);
      expect((await syncMemory(SEAT_TOKEN)).status).toBe(200);
    });

    it('leaves a legacy installation token alone', async () => {
      const legacy = 'cm_agent_f145legacy';
      await AgentInstallation.updateOne({ agentName: AGENT }, {
        $set: { runtimeTokens: [{ tokenHash: hash(legacy), label: 'legacy', createdAt: new Date() }] },
      });
      await User.updateOne({ _id: bot._id }, { $set: { agentRuntimeTokens: [] } });
      expect((await putMemory(legacy)).status).toBe(200);
    });
  });

  describe('renewal and lineage', () => {
    const renew = (id, token = SEAT_TOKEN) => request(app)
      .post(`${MINT}/${id}/renew`).set('Authorization', `Bearer ${token}`).send({ ttlSeconds: 900 });

    it('keeps the markers it minted, both ways', async () => {
      const marked = await mint({ publicSeat: true, eventIds: [String((await mentionFrom(owner))._id)] });
      const unmarked = await mint({ publicSeat: true, eventIds: [String((await mentionFrom(stranger))._id)] });
      expect((await renew(marked.body.credentialId)).status).toBe(200);
      expect((await renew(unmarked.body.credentialId)).status).toBe(200);
      expect(await scopesOf(marked)).toEqual(['spawn', 'public-seat', 'owner-woken']);
      expect(await scopesOf(unmarked)).toEqual(['spawn', 'public-seat']);
      expect((await putMemory(unmarked.body.token)).status).toBe(403);
    });

    it('keeps a marked child from minting, renewing or marking anything', async () => {
      const event = await mentionFrom(owner);
      const { token, credentialId } = (await mint({ publicSeat: true, eventIds: [String(event._id)] })).body;
      const res = await mint({ publicSeat: true, eventIds: [String(event._id)] }, token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('child_cannot_mint');
      expect((await renew(credentialId, token)).status).toBe(404);
    });

    it('ends the marked child with its turn', async () => {
      const event = await mentionFrom(owner);
      const { token, credentialId } = (await mint({ publicSeat: true, eventIds: [String(event._id)] })).body;
      await request(app).delete(`${MINT}/${credentialId}`).set('Authorization', `Bearer ${SEAT_TOKEN}`);
      expect((await putMemory(token)).status).toBe(401);
    });
  });
});
