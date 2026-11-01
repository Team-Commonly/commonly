// The fixture writes pod messages to MongoDB, so the service must read them
// there. With PG_HOST set (the Tier 1 job), the floor and author reads go to
// PostgreSQL, which these tests never write; the store read itself is covered
// in agentMessageService.authorIdsSince.test.js.
process.env.PG_HOST = '';
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('jsonwebtoken', () => ({}));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn() }));
const Task = require('../../models/Task');
const User = require('../../models/User');
const Message = require('../../models/Message');
const AgentEvent = require('../../models/AgentEvent');
const AgentTaskRowWakeState = require('../../models/AgentTaskRowWakeState');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentEventService = require('../../services/agentEventService');
const AgentMessageService = require('../../services/agentMessageService');
const { dispatchAssignedTaskWakes } = require('../../services/assignedTaskWakeService');

const STOPPED = 'I stopped retrying this after repeated errors. Reassign it or update it to try again.';
const NOW = new Date('2026-10-24T11:00:00Z');
const at = (minutes) => new Date(NOW.getTime() + minutes * 60000);
let podId;
let agent;
let person;

const eventRow = (extra) => ({
  agentName: 'codex', instanceId: 'forge', podId, type: 'chat.mention', deliveryMode: 'wake', ...extra,
});

// How the run a wake started ended, as the queue records it.
async function settle(outcome, minutes) {
  const { _id } = await AgentEventService.enqueue.mock.results.at(-1).value;
  const when = at(minutes);
  const delivery = {
    failed: { outcome: 'error', updatedAt: when },
    neutral: { outcome: 'no_action', reason: 'consecutive_run_cap', reasonRecorded: true, updatedAt: when },
  }[outcome] || { outcome: 'no_action', reasonRecorded: true, updatedAt: when };
  await AgentEvent.collection.insertOne(eventRow({
    _id, status: outcome === 'failed' ? 'failed' : 'acked', delivery, createdAt: when, updatedAt: when,
  }));
}

const wakes = async (minutes) => (await dispatchAssignedTaskWakes(at(minutes))).woken;
const say = (userId, minutes) => Message.collection.insertOne({
  podId, userId, content: 'hello', messageType: 'text', createdAt: at(minutes),
});
const row = () => Task.findOne({ podId }).lean();
const note = (authorId, minutes, author = 'someone') => Task.updateOne({ podId }, { $push: { updates: {
  text: 'a note', author, authorId: authorId === null ? null : String(authorId), createdAt: at(minutes),
} } });

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  podId = new mongoose.Types.ObjectId();
  agent = await User.create({
    username: 'forge-row-test', email: 'forge-row@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'codex', instanceId: 'forge' },
  });
  person = await User.create({ username: 'row-owner', email: 'row-owner@example.test', password: 'test-password' });
  await AgentInstallation.create({
    agentName: 'codex', instanceId: 'forge', podId, version: '1', installedBy: agent._id,
    config: { boardWake: { enabled: false } }, status: 'active',
  });
  const when = at(-6);
  await AgentEvent.collection.insertOne(eventRow({
    status: 'acked', delivery: { outcome: 'no_action', reasonRecorded: true, updatedAt: when }, createdAt: when, updatedAt: when,
  }));
  AgentEventService.enqueue.mockReset().mockImplementation(async () => ({ _id: new mongoose.Types.ObjectId() }));
});

describe('a row the agent created for itself', () => {
  beforeEach(() => Task.create({
    podId, taskNum: 4, taskId: 'N-4-codex-mvid77qk', title: 'Keep posting updates', assignee: 'forge', source: 'agent',
  }));

  it('wakes once, then stays quiet while nobody acts', async () => {
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    expect(await wakes(31)).toBe(0);
    expect(await wakes(240)).toBe(0);
  });

  it('stays quiet after its own run fails, too', async () => {
    expect(await wakes(0)).toBe(1);
    await settle('failed', 1);
    expect(await wakes(31)).toBe(0);
  });

  it('is not re-armed by the agent itself speaking', async () => {
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    await say(agent._id, 10);
    expect(await wakes(31)).toBe(0);
  });

  it('is re-armed for exactly one wake by a person posting in the pod', async () => {
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    await say(person._id, 10);
    expect(await wakes(31)).toBe(1);
    await settle('succeeded', 32);
    expect(await wakes(62)).toBe(0);
  });

  // Agent accounts from before `isBot` carry only the install markers.
  it.each([
    ['botType', { botType: 'agent' }],
    ['botMetadata.agentName', { botMetadata: { agentName: 'openclaw', instanceId: 'aria' } }],
    ['its derived address', { email: 'openclaw-aria@agents.commonly.local' }],
  ])('is not re-armed by a legacy agent account marked only by %s', async (_marker, markers) => {
    const { insertedId } = await User.collection.insertOne({ username: 'legacy-aria', ...markers });
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    await say(insertedId, 10);
    expect(await wakes(31)).toBe(0);
  });

  it('sees a person who posted before a long run of other agents', async () => {
    const other = await User.create({
      username: 'other-bot', email: 'other-bot@example.test', password: 'test-password', isBot: true, botType: 'agent',
    });
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    await say(person._id, 2);
    await Message.collection.insertMany(Array.from({ length: 60 }, (_, i) => ({
      podId, userId: other._id, content: `status ${i}`, messageType: 'text', createdAt: new Date(at(3).getTime() + i * 1000),
    })));
    expect(await wakes(31)).toBe(1);
  });

  it('queues no wake it could not record, and wakes once the record works', async () => {
    const write = jest.spyOn(AgentTaskRowWakeState, 'bulkWrite').mockRejectedValueOnce(new Error('mongo down'));
    try {
      expect(await wakes(0)).toBe(0);
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(await wakes(1)).toBe(1);
      await settle('succeeded', 2);
      expect(await wakes(32)).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it('stays quiet when the pod read fails and nobody updated a row', async () => {
    const read = jest.spyOn(AgentMessageService, 'authorIdsSince').mockRejectedValue(new Error('pg down'));
    try {
      expect(await wakes(0)).toBe(1);
      await settle('succeeded', 1);
      await say(person._id, 10);
      expect(await wakes(31)).toBe(0);
    } finally {
      read.mockRestore();
    }
  });

  it('is still re-armed by a person updating a row when the pod read fails', async () => {
    const read = jest.spyOn(AgentMessageService, 'authorIdsSince').mockRejectedValue(new Error('pg down'));
    try {
      expect(await wakes(0)).toBe(1);
      await settle('succeeded', 1);
      await Task.create({
        podId, taskNum: 5, taskId: 'TASK-5', title: 'Unrelated', status: 'done',
        updates: [{ text: 'Created by row-owner', author: 'row-owner', authorId: String(person._id), createdAt: at(10) }],
      });
      expect(await wakes(31)).toBe(1);
    } finally {
      read.mockRestore();
    }
  });

  it('clears the stamp on rows a failed write reached, so their first wake is not lost', async () => {
    await Task.create({
      podId, taskNum: 6, taskId: 'N-6-codex-mvid77ql', title: 'Second own row', assignee: 'forge', source: 'agent',
    });
    const original = AgentTaskRowWakeState.bulkWrite.bind(AgentTaskRowWakeState);
    const write = jest.spyOn(AgentTaskRowWakeState, 'bulkWrite').mockImplementationOnce(async (ops) => {
      await original(ops.slice(0, 1));
      throw new Error('write failed after the first row');
    });
    try {
      expect(await wakes(0)).toBe(0);
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(await wakes(1)).toBe(1);
      const { content } = AgentEventService.enqueue.mock.calls[0][0].payload;
      expect(content).toContain('N-4-codex-mvid77qk');
      expect(content).toContain('N-6-codex-mvid77ql');
    } finally {
      write.mockRestore();
    }
  });

  it('is re-armed by a person creating or updating a row in the pod', async () => {
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    await Task.create({
      podId, taskNum: 5, taskId: 'TASK-5', title: 'Unrelated', status: 'done',
      updates: [{ text: 'Created by row-owner', author: 'row-owner', authorId: String(person._id), createdAt: at(10) }],
    });
    expect(await wakes(31)).toBe(1);
  });

  it('is recognised from its creator update when the id carries no agent name', async () => {
    await Task.updateOne({ podId }, { $set: {
      taskId: 'TASK-4',
      updates: [{ text: 'Created by forge', author: 'forge', authorId: String(agent._id), createdAt: at(-60) }],
    } });
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    expect(await wakes(31)).toBe(0);
  });
});

describe('a row a person created or assigned', () => {
  beforeEach(() => Task.create({ podId, taskNum: 1, taskId: 'TASK-1', title: 'Do the assigned work', assignee: 'forge' }));

  // F42: 304 of 327 repeat wakes on 11-01 found the row as the agent's last
  // completed run left it, apart from the kernel's lease notes. A completed run
  // has seen the row; it wakes again only for a change someone else made.
  it('wakes once, then stays quiet while nothing on it changes', async () => {
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    expect(await wakes(31)).toBe(0);
    expect(await wakes(240)).toBe(0);
  });

  it("is not re-armed by the kernel's lease notes or the agent's own updates", async () => {
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    await note(null, 10, 'kernel-sweep');
    await note(agent._id, 12, 'forge');
    expect(await wakes(31)).toBe(0);
  });

  it('wakes again for an update a person made, once', async () => {
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    await note(person._id, 10, 'row-owner');
    expect(await wakes(31)).toBe(1);
    await settle('succeeded', 32);
    expect(await wakes(62)).toBe(0);
  });

  it('wakes again for an update another agent made', async () => {
    const other = await User.create({
      username: 'other-bot', email: 'other-bot@example.test', password: 'test-password', isBot: true, botType: 'agent',
    });
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    await note(other._id, 10, 'other-bot');
    expect(await wakes(31)).toBe(1);
  });

  it('is not re-armed by a pod message alone', async () => {
    expect(await wakes(0)).toBe(1);
    await settle('succeeded', 1);
    await say(person._id, 10);
    expect(await wakes(31)).toBe(0);
  });

  it('wakes again after a run that ended for its own reason, since that run did not see the row', async () => {
    expect(await wakes(0)).toBe(1);
    await settle('neutral', 1);
    expect(await wakes(31)).toBe(1);
  });

  it('stops after three failed runs in a row, and says so once on the row', async () => {
    const before = (await row()).updatedAt;
    for (const minutes of [0, 31, 62]) {
      expect(await wakes(minutes)).toBe(1); // eslint-disable-line no-await-in-loop
      await settle('failed', minutes + 1); // eslint-disable-line no-await-in-loop
    }
    expect(await wakes(93)).toBe(0);
    expect(await wakes(124)).toBe(0);
    const stopped = await row();
    expect(stopped.updates.filter((update) => update.text === STOPPED)).toEqual([
      expect.objectContaining({ author: 'codex', authorId: String(agent._id) }),
    ]);
    expect(stopped.updatedAt).toEqual(before);
  });

  it('stays quiet when the stop note cannot be written, and the next pass writes it once', async () => {
    const realUpdate = Task.updateOne.bind(Task);
    let refusals = 2;
    const spy = jest.spyOn(Task, 'updateOne').mockImplementation((filter, update, ...rest) => {
      if (update?.$push?.updates?.text === STOPPED && refusals > 0) {
        refusals -= 1;
        return Promise.reject(new Error('write refused'));
      }
      return realUpdate(filter, update, ...rest);
    });
    try {
      for (const minutes of [0, 31, 62]) {
        await wakes(minutes); // eslint-disable-line no-await-in-loop
        await settle('failed', minutes + 1); // eslint-disable-line no-await-in-loop
      }
      expect(await wakes(93)).toBe(0);
      expect((await row()).updates || []).toEqual([]);
      expect(await wakes(124)).toBe(0);
      expect((await row()).updates.filter((update) => update.text === STOPPED)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('starts again after a person updates the stopped row', async () => {
    for (const minutes of [0, 31, 62]) {
      await wakes(minutes); // eslint-disable-line no-await-in-loop
      await settle('failed', minutes + 1); // eslint-disable-line no-await-in-loop
    }
    expect(await wakes(93)).toBe(0);
    await Task.updateOne({ podId }, { $push: { updates: {
      text: 'Try with the new key', author: 'row-owner', authorId: String(person._id), createdAt: at(100),
    } } });
    expect(await wakes(124)).toBe(1);
    await settle('failed', 125);
    expect(await wakes(155)).toBe(1);
  });

  it('is not restarted by a pod message alone', async () => {
    for (const minutes of [0, 31, 62]) {
      await wakes(minutes); // eslint-disable-line no-await-in-loop
      await settle('failed', minutes + 1); // eslint-disable-line no-await-in-loop
    }
    await say(person._id, 70);
    expect(await wakes(93)).toBe(0);
  });

  it('counts only consecutive failures: a successful run resets the count', async () => {
    const other = await User.create({
      username: 'other-bot', email: 'other-bot@example.test', password: 'test-password', isBot: true, botType: 'agent',
    });
    const outcomes = ['failed', 'failed', 'succeeded', 'failed', 'failed'];
    for (const [step, outcome] of outcomes.entries()) {
      expect(await wakes(step * 31)).toBe(1); // eslint-disable-line no-await-in-loop
      await settle(outcome, step * 31 + 1); // eslint-disable-line no-await-in-loop
      // A succeeded run has seen the row (F42): another agent's update brings the next wake.
      if (outcome === 'succeeded') await note(other._id, step * 31 + 2, 'other-bot'); // eslint-disable-line no-await-in-loop
    }
    expect(await wakes(outcomes.length * 31)).toBe(1);
  });
});

it('does not wake an agent whose last posts in the pod are still unanswered', async () => {
  await Task.create({ podId, taskNum: 1, taskId: 'TASK-1', title: 'Do the assigned work', assignee: 'forge' });
  for (const minutes of [-30, -20, -10]) await say(agent._id, minutes); // eslint-disable-line no-await-in-loop
  expect(await wakes(0)).toBe(0);
  await say(person._id, 1);
  expect(await wakes(2)).toBe(1);
});
