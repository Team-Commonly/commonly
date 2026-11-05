/**
 * F202: a broker approval's expiry is retryable and idempotent.
 *
 * expireToolCallApproval flips the row to `expired` first and then writes the
 * refusal trail, the card and the `approval.resolved` wake. Before F202, a
 * crash or a throw after the flip left the row `expired` with no trail, a
 * stale card and no wake, and nothing re-selected it, because every sweep
 * selects `flagged`; the parked runs waited forever (CodeRabbit on #3520).
 *
 * Real Mongo with the model's indexes. The trail store keeps its primary key
 * (a duplicate call id throws 23505, as Postgres does), and the event
 * service writes real AgentEvent rows, so "delivered once" is read from the
 * collection the dedupe reads.
 */
process.env.PG_HOST = '';
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../models/ToolCall', () => {
  const rows = new Map();
  const create = jest.fn(async (row) => {
    if (rows.has(row.callId)) {
      const error = new Error('duplicate key value violates unique constraint "tool_calls_pkey"');
      error.code = '23505';
      throw error;
    }
    rows.set(row.callId, row);
    return row;
  });
  const digestArgs = () => 'd'.repeat(64);
  return {
    __esModule: true, default: { create, digestArgs }, create, digestArgs, rows, 
  };
});
jest.mock('../../services/agentEventService', () => {
  const enqueue = jest.fn(async (options) => {
    // eslint-disable-next-line global-require
    const AgentEvent = require('../../models/AgentEvent');
    return AgentEvent.create({
      agentName: options.agentName,
      instanceId: options.instanceId,
      podId: options.podId,
      type: options.type,
      payload: options.payload,
    });
  });
  return { enqueue };
});
jest.mock('../../services/attentionItemService', () => ({
  ...jest.requireActual('../../services/attentionItemService'),
  resolve: jest.fn(async () => undefined),
  recordMentionedUsers: jest.fn(async () => undefined),
  resolveMentionAttentionForReply: jest.fn(async () => undefined),
}));
jest.mock('../../services/brokerRecordService', () => ({
  recordApprovalOutcome: jest.fn(),
}));

const User = require('../../models/User');
const Message = require('../../models/Message');
const AgentEvent = require('../../models/AgentEvent');
const ApprovalAction = require('../../models/ApprovalAction');
const ToolCall = require('../../models/ToolCall');
const AgentEventService = require('../../services/agentEventService');
const {
  sweepExpiredToolCallApprovals, resolveApproval, EXPIRY_RETRY_GRACE_MS, MAX_EXPIRY_RETRIES,
} = require('../../services/approvalActionService');

jest.setTimeout(60000);

let owner;
const podId = new mongoose.Types.ObjectId();
const MINUTE = 60 * 1000;

const park = async (overrides = {}) => {
  const card = await Message.create({
    podId, userId: owner._id, content: 'approval', messageType: 'card', payload: { status: 'flagged' },
  });
  return ApprovalAction.create({
    podId,
    messageId: String(card._id),
    runId: new mongoose.Types.ObjectId(),
    ownerUserId: owner._id,
    agentName: 'alice',
    agentUserId: String(new mongoose.Types.ObjectId()),
    actionType: 'tool_call',
    summary: 'Create an issue',
    toolCall: {
      grantId: 'grant-1', tool: 'github.create_issue', argsDigest: 'a'.repeat(64), canonicalArgs: { title: 'Bug' },
    },
    toolCallSlot: 0,
    expiresAt: new Date(Date.now() - 1000),
    ...overrides,
  });
};

const trailFor = (row) => [...ToolCall.rows.values()].filter((r) => r.approvalId === String(row._id));
const eventsFor = (row) => AgentEvent.find({ type: 'approval.resolved', 'payload.approvalId': String(row._id) }).lean();
const cardFor = async (row) => (await Message.findById(row.messageId).lean()).payload;
const reread = (row) => ApprovalAction.findById(row._id).lean();
const realEnqueue = AgentEventService.enqueue.getMockImplementation();
const failWakeOnce = () => AgentEventService.enqueue.mockImplementationOnce(async () => {
  throw new Error('event store down');
});

beforeAll(async () => {
  await setupMongoDb();
  await ApprovalAction.init();
  owner = await User.create({ username: 'expiry-owner', email: 'expiry-owner@test.com', password: 'password123' });
});

afterAll(closeMongoDb);

beforeEach(async () => {
  await ApprovalAction.deleteMany({});
  await AgentEvent.deleteMany({});
  await Message.deleteMany({});
  ToolCall.rows.clear();
  jest.clearAllMocks();
});

describe('F202: expiry side effects survive a failure after the status flip', () => {
  it('the next sweep past the grace completes a failed expiry: one trail, card, one wake, marker', async () => {
    const row = await park();
    failWakeOnce();
    const now = new Date();

    await expect(sweepExpiredToolCallApprovals(now)).resolves.toBe(1);
    let stored = await reread(row);
    expect(stored.status).toBe('expired');
    expect(stored.expirySideEffectsDoneAt).toBeUndefined();
    expect(await eventsFor(row)).toHaveLength(0);

    await sweepExpiredToolCallApprovals(new Date(now.getTime() + EXPIRY_RETRY_GRACE_MS + MINUTE));
    stored = await reread(row);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(stored.expiryRetryCount).toBe(1);
    expect(trailFor(row)).toHaveLength(1);
    expect(trailFor(row)[0]).toMatchObject({ outcome: 'refused', reason: 'approval_expired' });
    expect(stored.toolCallTrailId).toBe(trailFor(row)[0].callId);
    expect(await cardFor(row)).toMatchObject({ status: 'expired', toolCallEnding: 'expired' });
    const events = await eventsFor(row);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ ending: 'expired', runIds: [String(row.runId)] });
  });

  it('a crash after the wake but before the marker does not wake the run again', async () => {
    const row = await park();
    const now = new Date();
    await sweepExpiredToolCallApprovals(now);
    expect(await eventsFor(row)).toHaveLength(1);
    expect((await reread(row)).expiryEventSentAt).toBeInstanceOf(Date);
    // The process died between the wake and the marker write, and the event
    // row has since been collected (AgentEvent retention is ~30 min), so only
    // the stamp on the approval can stop a second wake.
    await ApprovalAction.updateOne({ _id: row._id }, { $unset: { expirySideEffectsDoneAt: 1 } });
    await AgentEvent.deleteMany({});
    const wakes = AgentEventService.enqueue.mock.calls.length;

    await sweepExpiredToolCallApprovals(new Date(now.getTime() + EXPIRY_RETRY_GRACE_MS + MINUTE));
    const stored = await reread(row);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(stored.expiryRetryCount).toBe(1);
    expect(AgentEventService.enqueue.mock.calls.length).toBe(wakes);
    expect(trailFor(row)).toHaveLength(1);
  });

  it('a failed card write is retried until the card shows expired', async () => {
    const row = await park();
    const write = jest.spyOn(Message, 'updateOne').mockRejectedValueOnce(new Error('card store down'));
    try {
      const now = new Date();
      await sweepExpiredToolCallApprovals(now);
      expect((await reread(row)).expirySideEffectsDoneAt).toBeUndefined();
      expect(await cardFor(row)).toMatchObject({ status: 'flagged' });

      await sweepExpiredToolCallApprovals(new Date(now.getTime() + EXPIRY_RETRY_GRACE_MS + MINUTE));
      expect((await reread(row)).expirySideEffectsDoneAt).toBeInstanceOf(Date);
      expect(await cardFor(row)).toMatchObject({ status: 'expired' });
    } finally {
      write.mockRestore();
    }
  });

  it('two sweepers racing on one crashed expiry retry it once', async () => {
    const row = await park();
    failWakeOnce();
    const now = new Date();
    await sweepExpiredToolCallApprovals(now);
    const later = new Date(now.getTime() + EXPIRY_RETRY_GRACE_MS + MINUTE);

    await Promise.all([sweepExpiredToolCallApprovals(later), sweepExpiredToolCallApprovals(later)]);
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBe(1);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(await eventsFor(row)).toHaveLength(1);
  });

  it('a fully completed expiry is not re-run', async () => {
    const row = await park();
    const now = new Date();
    await sweepExpiredToolCallApprovals(now);
    const done = await reread(row);
    expect(done.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    const wakes = AgentEventService.enqueue.mock.calls.length;
    const writes = ToolCall.create.mock.calls.length;

    await sweepExpiredToolCallApprovals(new Date(now.getTime() + EXPIRY_RETRY_GRACE_MS + MINUTE));
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBe(0);
    expect(stored.expirySideEffectsDoneAt).toEqual(done.expirySideEffectsDoneAt);
    expect(AgentEventService.enqueue.mock.calls.length).toBe(wakes);
    expect(ToolCall.create.mock.calls.length).toBe(writes);
  });

  it('an expiry still inside the grace is left to the expiry in progress', async () => {
    const row = await park();
    const flippedAt = new Date();
    // A live expiry has flipped the row and is still running its side effects.
    await ApprovalAction.updateOne({ _id: row._id }, {
      $set: {
        status: 'expired', resolvedAt: flippedAt, expiryRetryCount: 0, toolCallEnding: 'expired', 
      },
    });

    await sweepExpiredToolCallApprovals(new Date(flippedAt.getTime() + EXPIRY_RETRY_GRACE_MS - 1000));
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBe(0);
    expect(stored.expirySideEffectsDoneAt).toBeUndefined();
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(ToolCall.create).not.toHaveBeenCalled();
  });

  it('stops re-selecting a row once its retries are spent, and logs it', async () => {
    const row = await park();
    AgentEventService.enqueue.mockImplementation(async () => { throw new Error('event store down'); });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const start = Date.now();
      await sweepExpiredToolCallApprovals(new Date(start));
      for (let i = 1; i <= MAX_EXPIRY_RETRIES + 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sweepExpiredToolCallApprovals(new Date(start + i * 5 * MINUTE));
      }
      const stored = await reread(row);
      expect(stored.expiryRetryCount).toBe(MAX_EXPIRY_RETRIES);
      expect(stored.expirySideEffectsDoneAt).toBeUndefined();
      // The first expiry plus one attempt per retry; the sweeps past the cap select nothing.
      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1 + MAX_EXPIRY_RETRIES);
      expect(error.mock.calls.filter(([line]) => String(line).includes('gave up'))).toHaveLength(1);
      expect(trailFor(row)).toHaveLength(1);
    } finally {
      error.mockRestore();
      warn.mockRestore();
      AgentEventService.enqueue.mockImplementation(realEnqueue);
    }
  });

  it('leaves an expired row written before F202 alone', async () => {
    const row = await park();
    // A legacy expiry: no retry count, no marker.
    await ApprovalAction.updateOne({ _id: row._id }, {
      $set: { status: 'expired', resolvedAt: new Date(Date.now() - 60 * MINUTE), toolCallEnding: 'expired' },
    });
    await sweepExpiredToolCallApprovals(new Date());
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect((await reread(row)).expiryRetryCount).toBeUndefined();
  });

  it('a decide on a lapsed call answers expired despite a failed side effect; the sweep completes it', async () => {
    const row = await park();
    failWakeOnce();
    const res = await resolveApproval({
      approvalId: String(row._id), callerUserId: String(owner._id), decision: 'approved',
    });
    expect(res).toMatchObject({ status: 409, body: { error: 'expired' } });
    let stored = await reread(row);
    expect(stored).toMatchObject({ status: 'expired', expiryRetryCount: 0 });
    expect(stored.expirySideEffectsDoneAt).toBeUndefined();

    await sweepExpiredToolCallApprovals(new Date(Date.now() + EXPIRY_RETRY_GRACE_MS + MINUTE));
    stored = await reread(row);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(await eventsFor(row)).toHaveLength(1);
    expect(trailFor(row)).toHaveLength(1);
  });
});
