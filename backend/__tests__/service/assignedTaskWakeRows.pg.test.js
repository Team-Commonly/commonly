// Production reads pod messages from PostgreSQL, so the floor and the re-arm
// are checked here against real PostgreSQL rows written through the PG model.
// assignedTaskWakeRows.test.js covers the same rules with MongoDB messages.
const mongoose = require('mongoose');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, setupPgDb, clearPgDb, closePgDb,
} = require('../utils/testUtils');

jest.mock('jsonwebtoken', () => ({}));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn() }));
const { pool } = require('../../config/db-pg');
const PGMessage = require('../../models/pg/Message');
const Task = require('../../models/Task');
const User = require('../../models/User');
const Message = require('../../models/Message');
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentEventService = require('../../services/agentEventService');
const { dispatchAssignedTaskWakes } = require('../../services/assignedTaskWakeService');

const d = process.env.INTEGRATION_TEST === 'true' && process.env.PG_HOST ? describe : describe.skip;
let NOW;
const at = (minutes) => new Date(NOW.getTime() + minutes * 60000);
let podId;
let agent;
let person;

const acked = (when, extra) => ({
  ...extra,
  status: 'acked',
  delivery: { outcome: 'no_action', reasonRecorded: true, updatedAt: when },
  createdAt: when,
  updatedAt: when,
});
const eventRow = (extra) => ({
  agentName: 'codex', instanceId: 'forge', podId, type: 'chat.mention', deliveryMode: 'wake', ...extra,
});
async function settle(minutes) {
  const { _id } = await AgentEventService.enqueue.mock.results.at(-1).value;
  const when = at(minutes);
  await AgentEvent.collection.insertOne(eventRow(acked(when, { _id })));
}
const wakes = async (minutes) => (await dispatchAssignedTaskWakes(at(minutes))).woken;
const say = (user) => PGMessage.create(String(podId), String(user._id), 'hello');

d('assigned-task wakes read PostgreSQL pod messages', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await setupPgDb();
  });
  afterAll(async () => {
    await clearPgDb();
    await closePgDb();
    await pool.end();
    await closeMongoDb();
  });
  beforeEach(async () => {
    await clearMongoDb();
    await clearPgDb();
    podId = new mongoose.Types.ObjectId();
    agent = await User.create({
      username: 'forge-pg-row',
      email: 'forge-pg-row@example.test',
      password: 'test-password',
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'codex', instanceId: 'forge' },
    });
    person = await User.create({
      username: 'pg-row-owner',
      email: 'pg-row-owner@example.test',
      password: 'test-password',
    });
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'wake-rows', 'chat', $2)",
      [String(podId), String(person._id)],
    );
    await pool.query(
      "INSERT INTO users (_id, username, is_bot) VALUES ($1, 'forge-pg-row', true), ($2, 'pg-row-owner', false)",
      [String(agent._id), String(person._id)],
    );
    await AgentInstallation.create({
      agentName: 'codex',
      instanceId: 'forge',
      podId,
      version: '1',
      installedBy: agent._id,
      config: { boardWake: { enabled: false } },
      status: 'active',
    });
    // created_at is the database's clock, so the wakes run on it too.
    NOW = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now;
    await AgentEvent.collection.insertOne(eventRow(acked(at(-6))));
    AgentEventService.enqueue.mockReset().mockImplementation(async () => ({ _id: new mongoose.Types.ObjectId() }));
  });
  afterEach(async () => {
    // Every message these cases read came from PostgreSQL.
    expect(await Message.countDocuments({ podId })).toBe(0);
  });

  it('does not wake an agent whose last posts are unanswered, and wakes it once a person replies', async () => {
    await Task.create({
      podId, taskNum: 1, taskId: 'TASK-1', title: 'Do the assigned work', assignee: 'forge',
    });
    for (let i = 0; i < 3; i += 1) await say(agent); // eslint-disable-line no-await-in-loop
    expect(await wakes(0)).toBe(0);
    await say(person);
    expect(await wakes(2)).toBe(1);
  });

  it('re-arms a row the agent created for itself only when a person posts', async () => {
    await Task.create({
      podId, taskNum: 4, taskId: 'N-4-codex-mvid77qk', title: 'Keep posting updates', assignee: 'forge', source: 'agent',
    });
    expect(await wakes(0)).toBe(1);
    await settle(1);
    await say(agent);
    expect(await wakes(31)).toBe(0);
    await say(person);
    expect(await wakes(62)).toBe(1);
    await settle(63);
    expect(await wakes(93)).toBe(0);
  });
});
