/**
 * Initiative v1 row 3 (design #2788, §4 and §6): the stall
 * nudge against a real Mongo, so the unique index that dedupes an episode is
 * the one under test. Witnesses named by §6: two stalls in one episode produce
 * one row; an agent owner with no installer produces none; `needs your check`
 * produces no nudge.
 */
const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AttentionItem = require('../../models/AttentionItem');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { deriveInitiativeStatus, MERGE_EVIDENCE_TEXT } = require('../../services/initiativeStatus');
const { nudgeStalledInitiative, nudgePodId } = require('../../services/initiativeNudge');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../services/needsYouEmailService', () => ({ sendNeedsYouEmail: jest.fn().mockResolvedValue(undefined) }));
const { sendNeedsYouEmail } = require('../../services/needsYouEmailService');

const NOW = new Date('2026-10-26T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);
const merge = (at) => ({
  text: MERGE_EVIDENCE_TEXT, author: 'system', authorId: null, createdAt: at, 
});

describe('initiative stall nudge', () => {
  let giver; let owner; let installer; let agent; let pod; let otherPod;

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    sendNeedsYouEmail.mockClear();
    await AttentionItem.init();
    [giver, owner, installer] = await User.create([
      { username: 'init-giver', email: 'init-giver@test.com', password: 'password123' },
      { username: 'init-owner', email: 'init-owner@test.com', password: 'password123' },
      { username: 'init-installer', email: 'init-installer@test.com', password: 'password123' },
    ]);
    agent = await User.create({
      username: 'init-agent',
      email: 'init-agent@test.com',
      password: 'password123',
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'init-agent', instanceId: 'seat' },
    });
    [pod, otherPod] = await Pod.create([
      {
        name: 'Ship room', type: 'chat', createdBy: giver._id, members: [giver._id, owner._id, installer._id, agent._id], 
      },
      {
        name: 'Elsewhere', type: 'chat', createdBy: giver._id, members: [giver._id], 
      },
    ]);
  });
  afterEach(clearMongoDb);

  const taskRow = (id, status, updates = [], podId = pod._id, taskNum = 1) => ({
    _id: id, podId, taskNum, status, updates,
  });
  const initiativeFor = (ownerField, links, extra = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    title: 'Ship the onboarding',
    createdAt: hoursAgo(24 * 10),
    direction: String(giver._id),
    owner: ownerField,
    ownerId: String(ownerField.userId || ownerField.agentUserId),
    links,
    ...extra,
  });
  const run = (initiative, tasks, at = NOW) => nudgeStalledInitiative(
    initiative,
    deriveInitiativeStatus(initiative, { tasks, decisions: [], attention: [] }, at),
    tasks,
  );
  const link = (ref) => ({ kind: 'task', ref, addedAt: hoursAgo(24 * 9) });
  const stallRows = () => AttentionItem.find({ 'source.type': 'initiative' }).lean();

  it('two runs inside one episode write one row, to the human owner', async () => {
    const initiative = initiativeFor({ userId: owner._id }, [link('t1')]);
    const tasks = [taskRow('t1', 'claimed', [merge(hoursAgo(50))])];

    const first = await run(initiative, tasks);
    const second = await run(initiative, tasks, new Date(NOW.getTime() + 3600 * 1000));

    expect(first).toMatchObject({ state: 'nudged', recipientUserId: String(owner._id), podId: String(pod._id) });
    expect(first.episodeStart).toEqual(hoursAgo(50));
    expect(second).toMatchObject({ state: 'nudged', episodeStart: hoursAgo(50) });
    const rows = await stallRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'blocked',
      status: 'open',
      title: 'Stalled: Ship the onboarding',
      source: { type: 'initiative', id: `initiative:${initiative._id}:stall:${hoursAgo(50).toISOString()}` },
    });
    expect(String(rows[0].recipientUserId)).toBe(String(owner._id));
    expect(sendNeedsYouEmail).toHaveBeenCalledTimes(1);
    expect(String(sendNeedsYouEmail.mock.calls[0][0].recipientUserId)).toBe(String(owner._id));
  });

  it('an owner change inside one episode does not nudge the new owner too', async () => {
    const tasks = [taskRow('t1', 'claimed', [merge(hoursAgo(50))])];
    const before = initiativeFor({ userId: owner._id }, [link('t1')]);
    const after = { ...before, owner: { userId: giver._id }, ownerId: String(giver._id) };

    await run(before, tasks);
    const second = await run(after, tasks, new Date(NOW.getTime() + 3600 * 1000));

    expect(second).toMatchObject({ state: 'nudged', recipientUserId: String(owner._id) });
    const rows = await stallRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(String(rows[0].recipientUserId)).toBe(String(owner._id));
    expect(sendNeedsYouEmail).toHaveBeenCalledTimes(1);
  });

  it('when the nudged owner has left the pod, the new owner gets the episode', async () => {
    const tasks = [taskRow('t1', 'claimed', [merge(hoursAgo(50))])];
    const before = initiativeFor({ userId: owner._id }, [link('t1')]);
    const after = { ...before, owner: { userId: giver._id }, ownerId: String(giver._id) };

    await run(before, tasks);
    await Pod.updateOne({ _id: pod._id }, { $pull: { members: owner._id } });
    const second = await run(after, tasks, new Date(NOW.getTime() + 3600 * 1000));

    expect(second).toMatchObject({ state: 'nudged', recipientUserId: String(giver._id) });
    const rows = await stallRows();
    expect(rows.map((r) => String(r.recipientUserId)).sort())
      .toEqual([String(giver._id), String(owner._id)].sort());
    expect(sendNeedsYouEmail).toHaveBeenCalledTimes(2);
  });

  it('a failed write reports failed, and the next run retries it', async () => {
    const initiative = initiativeFor({ userId: owner._id }, [link('t1')]);
    const tasks = [taskRow('t1', 'claimed', [merge(hoursAgo(50))])];
    const spy = jest.spyOn(AttentionItem, 'updateOne').mockRejectedValueOnce(new Error('mongo down'));
    try {
      expect(await run(initiative, tasks)).toMatchObject({ state: 'failed', podId: String(pod._id) });
      expect(await stallRows()).toHaveLength(0);
      expect(sendNeedsYouEmail).not.toHaveBeenCalled();

      expect(await run(initiative, tasks)).toMatchObject({ state: 'nudged', recipientUserId: String(owner._id) });
      expect(await stallRows()).toHaveLength(1);
      expect(sendNeedsYouEmail).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('an episode already in the audit trail is not written again', async () => {
    const initiative = initiativeFor({ userId: owner._id }, [link('t1')], {
      nudges: [{ episodeStart: hoursAgo(50).toISOString(), nudgedAt: hoursAgo(20) }],
    });
    expect(await run(initiative, [taskRow('t1', 'claimed', [merge(hoursAgo(50))])]))
      .toEqual({ state: 'already-nudged', episodeStart: hoursAgo(50) });
    expect(await stallRows()).toHaveLength(0);
  });

  it("an agent owner's stall goes to the agent's installer", async () => {
    await AgentInstallation.create({
      agentName: 'init-agent', instanceId: 'seat', podId: pod._id, version: '1', installedBy: installer._id,
    });
    const initiative = initiativeFor({ agentUserId: agent._id }, [link('t1')]);
    const result = await run(initiative, [taskRow('t1', 'claimed')]);
    expect(result).toMatchObject({ state: 'nudged', recipientUserId: String(installer._id) });
    expect(result.episodeStart).toEqual(hoursAgo(24 * 10));
  });

  it('an agent owner with no installer produces no row', async () => {
    const initiative = initiativeFor({ agentUserId: agent._id }, [link('t1')]);
    expect(await run(initiative, [taskRow('t1', 'claimed')])).toMatchObject({ state: 'no-human', podId: String(pod._id) });
    expect(await stallRows()).toHaveLength(0);
  });

  it('a failed installer lookup reports failed, not no-human', async () => {
    const initiative = initiativeFor({ agentUserId: agent._id }, [link('t1')]);
    const spy = jest.spyOn(AgentInstallation, 'findOne').mockImplementationOnce(() => {
      throw new Error('mongo down');
    });
    try {
      expect(await run(initiative, [taskRow('t1', 'claimed')])).toMatchObject({ state: 'failed', podId: String(pod._id) });
      expect(await stallRows()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('needs your check produces no nudge, however old the merge', async () => {
    const initiative = initiativeFor({ userId: owner._id }, [link('t1')]);
    expect(await run(initiative, [taskRow('t1', 'done', [merge(hoursAgo(24 * 5))])])).toEqual({ state: 'not-stalled' });
    expect(await stallRows()).toHaveLength(0);
  });

  it('an owner who is not a human member of the nudge pod produces no row', async () => {
    const initiative = initiativeFor({ userId: owner._id }, [link('t1')]);
    expect(await run(initiative, [taskRow('t1', 'claimed', [], otherPod._id)])).toMatchObject({ state: 'no-human' });
    expect(await stallRows()).toHaveLength(0);
  });

  it('with no open linked task, the first pod link routes the nudge', async () => {
    const initiative = initiativeFor({ userId: owner._id }, [
      link('t1'), { kind: 'pod', ref: String(pod._id), addedAt: hoursAgo(24 * 9) },
    ]);
    expect(await run(initiative, [taskRow('t1', 'done', [], otherPod._id)]))
      .toMatchObject({ state: 'nudged', podId: String(pod._id), recipientUserId: String(owner._id) });
    expect(await stallRows()).toHaveLength(1);
  });

  it('with no open linked task and no pod link, nothing is written', async () => {
    const initiative = initiativeFor({ userId: owner._id }, [link('t1')]);
    expect(await run(initiative, [taskRow('t1', 'done')])).toMatchObject({ state: 'no-pod' });
    expect(await stallRows()).toHaveLength(0);
  });

  it('a new episode opens a new row and closes the old one; moving again closes it too', async () => {
    const initiative = initiativeFor({ userId: owner._id }, [link('t1')]);
    await run(initiative, [taskRow('t1', 'claimed', [merge(hoursAgo(50))])]);
    // A merge 30 h ago moved it; it has been quiet since, so this is a new stall.
    await run(initiative, [taskRow('t1', 'claimed', [merge(hoursAgo(50)), merge(hoursAgo(30))])]);
    let rows = await stallRows();
    expect(rows.map((r) => [r.source.id.endsWith(hoursAgo(50).toISOString()), r.status]).sort())
      .toEqual([[false, 'open'], [true, 'resolved']]);

    await run(initiative, [taskRow('t1', 'claimed', [merge(hoursAgo(30)), merge(hoursAgo(1))])]);
    rows = await stallRows();
    expect(rows.every((r) => r.status === 'resolved')).toBe(true);
  });
});

describe('nudgePodId', () => {
  const init = (links) => ({
    _id: 'i', title: 't', createdAt: new Date(), direction: 'g', links, 
  });
  const l = (kind, ref) => ({ kind, ref, addedAt: new Date() });

  it('picks the open linked task with the lowest taskNum, through task or pr links', () => {
    const tasks = [
      {
        _id: 'a', podId: 'pod-a', taskNum: 9, status: 'claimed', 
      },
      {
        _id: 'b', podId: 'pod-b', taskNum: 3, status: 'pending', prUrl: 'https://example.test/pr/1', 
      },
      {
        _id: 'c', podId: 'pod-c', taskNum: 1, status: 'done', 
      },
    ];
    expect(nudgePodId(init([l('task', 'a'), l('pr', 'https://example.test/pr/1'), l('task', 'c')]), tasks)).toBe('pod-b');
  });

  it('falls back to the first pod link, then to none', () => {
    expect(nudgePodId(init([l('task', 'x'), l('pod', 'pod-z')]), [])).toBe('pod-z');
    expect(nudgePodId(init([l('task', 'x')]), [])).toBeNull();
  });
});
