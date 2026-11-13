/* eslint-disable global-require -- models load after the in-memory Mongo connects */
// F237 item 2: a poll from a driver whose carry already fills its prompt.
//
// Before: the CLI asked for max(1, limit - carried) rows, so a full carry
// claimed one new row on every poll that couldn't fit the turn. During an
// outage each such row rode the carry past the prompt cap, was released after
// five failed turns, and was claimed again, one attempt each time, until the
// requeue cap retired it unanswered, without ever being tried.
//
// Now the driver names the rows it carries (`onlyIds`). The server claims only
// those of them it has requeued, so the driver gets their live delivery ids,
// and leaves every other row pending with its attempts untouched. A server
// that predates this ignores the field and claims as before.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('../../../services/agentMemoryService', () => ({
  buildMemoryDigestBundle: jest.fn(() => ({})),
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  getAgentSessionSizes: jest.fn(),
  clearAgentRuntimeSessions: jest.fn(),
  restartAgentRuntime: jest.fn(),
  resolveOpenClawAccountId: jest.fn(() => 'acct'),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(() => ({ runtime: 'moltbot' })),
}));
jest.mock('../../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));

let mongod;
let AgentEvent;
let AgentEventService;

const AGENT = 'pixel';
const INSTANCE = 'default';
const POD_ID = new mongoose.Types.ObjectId();
const OTHER_POD = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentEvent = require('../../../models/AgentEvent');
  AgentEventService = require('../../../services/agentEventService');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AgentEvent.deleteMany({});
});

const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000);
const make = (over = {}) => AgentEvent.create({
  agentName: AGENT, instanceId: INSTANCE, podId: POD_ID, type: 'chat.mention', payload: { content: 'q' }, ...over,
});
const page = (over = {}) => AgentEventService.listInboxPage({
  agentName: AGENT, instanceId: INSTANCE, podIds: [POD_ID, OTHER_POD], limit: 1, ...over,
});
const row = async (doc) => AgentEvent.findById(doc._id).lean();

describe('listInboxPage with onlyIds (a full carry)', () => {
  test('claims only the carried rows the server requeued, never a new one', async () => {
    // Carried: one still held, one the server requeued while the turn was out.
    const held = await make({
      status: 'delivered', deliveryNonce: 'n-held', attempts: 1, createdAt: at(30), 
    });
    const requeued = await make({ status: 'pending', attempts: 1, createdAt: at(29) });
    // Waiting on the server, older than the requeued row: today's poll takes it.
    const waiting = await make({ status: 'pending', createdAt: at(40) });

    const result = await page({ onlyIds: [String(held._id), String(requeued._id)] });

    expect(result.events.map((event) => String(event._id))).toEqual([String(requeued._id)]);
    expect((await row(requeued)).attempts).toBe(2);
    expect((await row(waiting)).status).toBe('pending');
    expect((await row(waiting)).attempts || 0).toBe(0);
    expect((await row(held)).deliveryNonce).toBe('n-held');
    // The header still counts what waits in the pod.
    expect(result.inboxCount).toBe(2);
  });

  test('without onlyIds the same poll claims the waiting row, as before', async () => {
    const requeued = await make({ status: 'pending', attempts: 1, createdAt: at(29) });
    const waiting = await make({ status: 'pending', createdAt: at(40) });

    const result = await page();

    expect(result.events.map((event) => String(event._id))).toEqual([String(waiting._id)]);
    expect((await row(requeued)).status).toBe('pending');
  });

  test('refreshes every requeued carried row, past the limit, across the pods it carries', async () => {
    const a = await make({ status: 'pending', attempts: 1, createdAt: at(10) });
    const b = await make({ status: 'pending', attempts: 1, createdAt: at(9) });
    const c = await make({
      status: 'pending', attempts: 1, podId: OTHER_POD, createdAt: at(8), 
    });

    const result = await page({ onlyIds: [String(a._id), String(b._id), String(c._id)] });

    expect(result.events.map((event) => String(event._id)).sort())
      .toEqual([String(a._id), String(b._id), String(c._id)].sort());
  });

  test('a carried digest row comes back without an attempt', async () => {
    const wake = await make({ status: 'pending', attempts: 1, createdAt: at(10) });
    const digest = await make({
      status: 'pending', deliveryMode: 'digest', type: 'message.posted', createdAt: at(11), 
    });

    const result = await page({ onlyIds: [String(wake._id), String(digest._id)] });

    expect(result.events.map((event) => String(event._id))).toEqual([String(wake._id), String(digest._id)]);
    expect((await row(digest)).attempts || 0).toBe(0);
  });

  test('never claims another agent\'s row or one outside the caller\'s pods, named or not', async () => {
    const theirs = await make({ status: 'pending', agentName: 'someone-else' });
    const elsewhere = await make({ status: 'pending', podId: new mongoose.Types.ObjectId() });
    const mine = await make({ status: 'pending', attempts: 1 });

    const result = await page({ onlyIds: [String(theirs._id), String(elsewhere._id), String(mine._id)] });

    expect(result.events.map((event) => String(event._id))).toEqual([String(mine._id)]);
    expect((await row(theirs)).status).toBe('pending');
    expect((await row(elsewhere)).status).toBe('pending');
  });

  test('an empty list claims nothing', async () => {
    await make({ status: 'pending', createdAt: at(40) });
    const result = await page({ onlyIds: [] });
    expect(result.events).toEqual([]);
  });
});
