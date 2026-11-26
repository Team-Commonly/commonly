// F639 backfill: the production deps against the real Machine and User schemas
// (MongoMemoryServer) and a Postgres messages table (pg-mem).
/* eslint-disable global-require */
const { MongoMemoryServer } = require('mongodb-memory-server');
const { newDb } = require('pg-mem');
const mongoose = require('mongoose');

let mongod;
let pool;
let Machine;
let User;
let Pod;
let backfillMachineFirstAnswer;
let productionDeps;
let parseCursor;

const REGISTERED = new Date('2026-11-01T00:00:00Z');
const BEFORE = new Date('2026-10-20T00:00:00Z');
const FIRST = new Date('2026-11-02T10:00:00Z');
const LATER = new Date('2026-11-03T10:00:00Z');

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Machine = require('../../../models/Machine');
  User = require('../../../models/User');
  Pod = require('../../../models/Pod');
  ({
    backfillMachineFirstAnswer, productionDeps, parseCursor,
  } = require('../../../scripts/backfill-machine-first-answer'));
  const db = newDb();
  pool = new (db.adapters.createPg().Pool)();
  await pool.query(`CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    pod_id VARCHAR(24),
    user_id VARCHAR(24) NOT NULL,
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text' NOT NULL,
    author_kind VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL
  )`);
});
afterEach(async () => {
  await Machine.deleteMany({});
  await User.deleteMany({});
  await Pod.deleteMany({});
  await pool.query('DELETE FROM messages');
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let n = 0;
const machine = async (extra = {}) => {
  n += 1;
  const row = await Machine.create({
    ownerUserId: new mongoose.Types.ObjectId(), machineId: `m-${n}`, name: 'laptop', ...extra,
  });
  await Machine.collection.updateOne({ _id: row._id }, { $set: { createdAt: REGISTERED } });
  return row;
};
const agentOn = async (machineId) => {
  n += 1;
  return User.create({
    username: `seat-${n}`,
    email: `seat-${n}@agents.commonly.local`,
    password: 'Password123!',
    isBot: true,
    botMetadata: { agentName: `seat-${n}`, instanceId: 'default', ...(machineId ? { machineId } : {}) },
  });
};
const message = (userId, at, extra = {}) => pool.query(
  'INSERT INTO messages (pod_id, user_id, content, message_type, author_kind, created_at) '
    + 'VALUES ($1, $2, $3, $4, $5, $6)',
  [
    extra.podId ? String(extra.podId) : null, String(userId), 'hi',
    extra.messageType || 'text', extra.authorKind || null, at,
  ],
);
const stampOf = async (row) => (await Machine.findById(row._id).lean()).firstAnswerAt;
const run = (apply, extra = {}) => backfillMachineFirstAnswer(productionDeps(pool), { apply, paceMs: 0, ...extra });

describe('backfill-machine-first-answer', () => {
  it('sets the earliest post by a bound agent since registration, not a system line or kernel notice', async () => {
    const m = await machine();
    const claude = await agentOn(m.machineId);
    const codex = await agentOn(m.machineId);
    await message(claude._id, BEFORE); // before this machine existed
    await message(codex._id, new Date('2026-11-01T12:00:00Z'), { messageType: 'system' });
    await message(codex._id, new Date('2026-11-01T13:00:00Z'), { authorKind: 'kernel' });
    await message(claude._id, LATER);
    await message(codex._id, FIRST);

    const dry = await run(false);
    expect(dry).toMatchObject({ dryRun: true, unstamped: 1, toStamp: 1, applied: 0 });
    expect(await stampOf(m)).toBeNull();

    const applied = await run(true);
    expect(applied).toMatchObject({ dryRun: false, toStamp: 1, applied: 1, failed: 0 });
    expect(await stampOf(m)).toEqual(FIRST);
  });

  // No person is in an agent-dm pod (ADR-001 §3.10), so a post there is no one's answer.
  it('does not count a message in an agent-to-agent DM', async () => {
    const m = await machine();
    const agent = await agentOn(m.machineId);
    const peer = await agentOn(null);
    const dm = await Pod.create({
      name: 'agent dm', type: 'agent-dm', createdBy: agent._id, members: [agent._id, peer._id],
    });
    const room = await Pod.create({ name: 'team', type: 'chat', createdBy: agent._id, members: [agent._id] });
    await message(agent._id, new Date('2026-11-01T12:00:00Z'), { podId: dm._id });
    await message(agent._id, FIRST, { podId: room._id });

    const report = await run(true);
    expect(report).toMatchObject({ toStamp: 1, applied: 1 });
    expect(await stampOf(m)).toEqual(FIRST);
  });

  it('leaves a machine whose agents only posted into agent-to-agent DMs alone', async () => {
    const m = await machine();
    const agent = await agentOn(m.machineId);
    const dm = await Pod.create({ name: 'agent dm', type: 'agent-dm', createdBy: agent._id, members: [agent._id] });
    await message(agent._id, FIRST, { podId: dm._id });
    expect(await run(true)).toMatchObject({ noPosts: 1, applied: 0 });
    expect(await stampOf(m)).toBeNull();
  });

  it('leaves a stamped machine, a machine with no agents and one whose agents never posted alone', async () => {
    const stamped = await machine({ firstAnswerAt: LATER });
    const stampedAgent = await agentOn(stamped.machineId);
    await message(stampedAgent._id, FIRST);
    const empty = await machine();
    const quiet = await machine();
    await agentOn(quiet.machineId);
    const unbound = await agentOn(null);
    await message(unbound._id, FIRST);

    const report = await run(true);
    expect(report).toMatchObject({ unstamped: 2, noAgents: 1, noPosts: 1, toStamp: 0, applied: 0 });
    expect(await stampOf(stamped)).toEqual(LATER);
    expect(await stampOf(empty)).toBeNull();
    expect(await stampOf(quiet)).toBeNull();
  });

  it('never overwrites a stamp a live post wrote between the read and the write', async () => {
    const m = await machine();
    const agent = await agentOn(m.machineId);
    await message(agent._id, FIRST);
    const deps = productionDeps(pool);
    const report = await backfillMachineFirstAnswer({
      ...deps,
      stamp: async (id, at) => {
        await Machine.updateOne({ _id: id }, { $set: { firstAnswerAt: LATER } });
        return deps.stamp(id, at);
      },
    }, { apply: true, paceMs: 0 });
    expect(report).toMatchObject({ toStamp: 1, applied: 0, alreadyStamped: 1 });
    expect(await stampOf(m)).toEqual(LATER);
  });

  // Machines that stay unset (no agents, no eligible post) are read again on
  // every run; a fixed first page of them would hide every newer machine.
  it('pages past a first batch of machines that stay unset to reach the next one', async () => {
    await machine();
    await machine();
    const eligible = await machine();
    const agent = await agentOn(eligible.machineId);
    await message(agent._id, FIRST);
    const listUnstamped = jest.fn(productionDeps(pool).listUnstamped);
    const report = await backfillMachineFirstAnswer(
      { ...productionDeps(pool), listUnstamped }, { apply: true, batch: 2, paceMs: 0 },
    );
    expect(listUnstamped).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ unstamped: 3, noAgents: 2, toStamp: 1, applied: 1, nextCursor: null });
    expect(await stampOf(eligible)).toEqual(FIRST);
  });

  it('stops at --limit with a cursor that resumes after the last machine it read', async () => {
    await machine();
    await machine();
    const eligible = await machine();
    const agent = await agentOn(eligible.machineId);
    await message(agent._id, FIRST);
    const first = await run(true, { limit: 2, batch: 1 });
    expect(first).toMatchObject({ unstamped: 2, noAgents: 2, applied: 0 });
    expect(first.nextCursor).toMatch(/^\d{4}-\d\d-\d\dT[^_]+Z_[a-f0-9]{24}$/);
    expect(await stampOf(eligible)).toBeNull();

    const resumed = await run(true, { after: parseCursor(first.nextCursor) });
    expect(resumed).toMatchObject({ unstamped: 1, applied: 1, nextCursor: null });
    expect(await stampOf(eligible)).toEqual(FIRST);
  });

  it('refuses a cursor it did not print', () => {
    expect(() => parseCursor('m-1')).toThrow(/--after/);
    expect(() => parseCursor(`not-a-date_${'a'.repeat(24)}`)).toThrow(/--after/);
  });

  it('is bounded and paced, and prints no ids', async () => {
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await machine();
    }
    const pause = jest.fn(async () => {});
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const report = await backfillMachineFirstAnswer({
      ...productionDeps(pool),
      agentIdsOn: async () => { throw new Error('boom'); },
      pause,
    }, { limit: 2, paceMs: 7 });
    expect(report).toMatchObject({ unstamped: 2, failed: 2 });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledWith(7);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/m-\d+/);
    log.mockRestore();
  });
});
