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
const attention = require('../../services/attentionItemService');
const {
  sweepExpiredToolCallApprovals, resolveApproval, EXPIRY_RETRY_GRACE_MS, MAX_EXPIRY_RETRIES, expiryRetryDueAt,
  EXPIRY_WAKE_CLAIM_LEASE_MS,
} = require('../../services/approvalActionService');
const retryCappedScript = require('../../scripts/retry-capped-approval-expiries');

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
const deferred = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};
// Hold the next completion at its first step (the inbox resolve) until released.
const gateNextCompletion = () => {
  const gate = deferred();
  const reached = deferred();
  attention.resolve.mockImplementationOnce(async () => { reached.release(); await gate.promise; });
  // Fail fast, not at the suite timeout, when no completion ever reaches the gate.
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('no completion reached the gate')), 5000).unref();
  });
  return { reached: Promise.race([reached.promise, timeout]), release: gate.release };
};
// Sweep at the moment the row next becomes due, as the cron eventually would.
const sweepWhenDue = async (row) => sweepExpiredToolCallApprovals(expiryRetryDueAt(await reread(row)));
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
  // clearAllMocks keeps queued Once implementations; a gate a failing test never
  // consumed must not hold the next test's completion.
  attention.resolve.mockReset();
  attention.resolve.mockImplementation(async () => undefined);
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

  it('a second sweeper inside the claim lease neither claims the row nor wakes the run again', async () => {
    const row = await park();
    failWakeOnce();
    const now = new Date();
    await sweepExpiredToolCallApprovals(now);
    const later = new Date(now.getTime() + EXPIRY_RETRY_GRACE_MS + MINUTE);

    // The first retry claims the row and is held mid-completion...
    const held = gateNextCompletion();
    const first = sweepExpiredToolCallApprovals(later);
    await held.reached;
    expect((await reread(row)).expiryRetryCount).toBe(1);
    // ...while a second sweeper, half a grace later, tries the same row.
    await sweepExpiredToolCallApprovals(new Date(later.getTime() + EXPIRY_RETRY_GRACE_MS / 2));
    expect((await reread(row)).expiryRetryCount).toBe(1);
    expect(attention.resolve).toHaveBeenCalledTimes(2); // the first expiry, then the held retry
    held.release();
    await first;

    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBe(1);
    expect(stored.expiryRetryClaimedAt).toEqual(later);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    // One failed send on the first expiry, one successful send on the retry.
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(2);
    expect(await eventsFor(row)).toHaveLength(1);
  });

  it('a wake another attempt already claimed is not sent again', async () => {
    const row = await park();
    failWakeOnce();
    const now = new Date();
    await sweepExpiredToolCallApprovals(now);
    expect((await reread(row)).expiryEventSentAt).toBeUndefined(); // the failed send released its claim

    const held = gateNextCompletion();
    const retry = sweepExpiredToolCallApprovals(new Date(now.getTime() + EXPIRY_RETRY_GRACE_MS + MINUTE));
    await held.reached;
    // An overlapping attempt claims the wake while this one holds a row read before that.
    await ApprovalAction.updateOne({ _id: row._id }, { $set: { expiryEventSentAt: new Date() } });
    held.release();
    await retry;

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1); // only the first, failed send
    expect((await reread(row)).expirySideEffectsDoneAt).toBeInstanceOf(Date);
  });

  it('an existing wake event stops a resend even when the stamp is missing', async () => {
    const row = await park();
    const now = new Date();
    await sweepExpiredToolCallApprovals(now);
    expect(await eventsFor(row)).toHaveLength(1);
    // A crash after the send but before the stamp, found after the wake lease lapsed.
    await ApprovalAction.updateOne({ _id: row._id }, {
      $unset: { expirySideEffectsDoneAt: 1, expiryEventSentAt: 1 },
      $set: { expiryEventClaimedAt: new Date(Date.now() - EXPIRY_WAKE_CLAIM_LEASE_MS - 1000) },
    });

    await sweepExpiredToolCallApprovals(new Date(now.getTime() + EXPIRY_RETRY_GRACE_MS + MINUTE));
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(await eventsFor(row)).toHaveLength(1);
    expect((await reread(row)).expirySideEffectsDoneAt).toBeInstanceOf(Date);
  });

  // An expired row whose first attempt took the wake lease at `claimedAt` and
  // then crashed: no stamp, no event row, no marker, due for a retry.
  const crashedHoldingTheWake = async (claimedAt) => {
    const row = await park();
    await ApprovalAction.updateOne({ _id: row._id }, {
      $set: {
        status: 'expired',
        toolCallEnding: 'expired',
        resolvedAt: new Date(Date.now() - 60 * MINUTE),
        expiryRetryCount: 0,
        expiryEventClaimedAt: claimedAt,
      },
    });
    return row;
  };

  it('a stale wake lease from a crashed attempt is taken over, and the wake is sent once', async () => {
    const row = await crashedHoldingTheWake(new Date(Date.now() - EXPIRY_WAKE_CLAIM_LEASE_MS - 1000));
    await sweepExpiredToolCallApprovals(new Date());
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(await eventsFor(row)).toHaveLength(1);
    const stored = await reread(row);
    expect(stored.expiryEventSentAt).toBeInstanceOf(Date);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);

    await ApprovalAction.updateOne({ _id: row._id }, { $unset: { expirySideEffectsDoneAt: 1 } });
    await sweepWhenDue(row);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a fresh wake lease held by another attempt is not sent over, and the row stays incomplete', async () => {
    const row = await crashedHoldingTheWake(new Date(Date.now() - 10 * 1000));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sweepExpiredToolCallApprovals(new Date());
    } finally {
      warn.mockRestore();
    }
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBe(1);
    expect(stored.expiryEventSentAt).toBeUndefined();
    expect(stored.expirySideEffectsDoneAt).toBeUndefined();
  });

  it('a card that never writes does not hold back the wake, and is retried until the cap', async () => {
    const row = await park();
    const write = jest.spyOn(Message, 'updateOne').mockRejectedValue(new Error('card store down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sweepExpiredToolCallApprovals(new Date());
      expect(await eventsFor(row)).toHaveLength(1);
      expect((await reread(row)).expiryEventSentAt).toBeInstanceOf(Date);

      for (let i = 1; i <= MAX_EXPIRY_RETRIES + 1; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sweepWhenDue(row);
      }
      const stored = await reread(row);
      expect(stored.expiryRetryCount).toBe(MAX_EXPIRY_RETRIES);
      expect(stored.expirySideEffectsDoneAt).toBeUndefined();
      expect(write).toHaveBeenCalledTimes(1 + MAX_EXPIRY_RETRIES);
      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
      expect(await eventsFor(row)).toHaveLength(1);
    } finally {
      write.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
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
      await sweepExpiredToolCallApprovals(new Date());
      for (let i = 1; i <= MAX_EXPIRY_RETRIES; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sweepWhenDue(row);
        // The row stays eligible, one retry per due time, up to the cap.
        // eslint-disable-next-line no-await-in-loop
        expect((await reread(row)).expiryRetryCount).toBe(i);
      }
      // Past the cap no sweep selects it, however late.
      await sweepWhenDue(row);
      await sweepExpiredToolCallApprovals(new Date(Date.now() + 48 * 60 * MINUTE));
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

  // A row whose expiry failed `count` times so far, last attempted at `last`.
  const failedSoFar = async (count, last) => {
    const row = await park();
    await ApprovalAction.updateOne({ _id: row._id }, {
      $set: {
        status: 'expired',
        toolCallEnding: 'expired',
        resolvedAt: new Date(last.getTime() - (count ? 30 * MINUTE : 0)),
        expiryRetryCount: count,
        ...(count ? { expiryRetryClaimedAt: last } : {}),
      },
    });
    return row;
  };

  it.each([
    [0, 1],
    [1, 2],
    [3, 8],
    [8, 60], // 2^8 minutes, capped at an hour
  ])('after %i retries the row waits %i minutes from its last attempt, then is retried', async (count, minutes) => {
    const last = new Date(Date.now() - 24 * 60 * MINUTE);
    const row = await failedSoFar(count, last);
    expect(expiryRetryDueAt(await reread(row))).toEqual(new Date(last.getTime() + minutes * MINUTE));

    await sweepExpiredToolCallApprovals(new Date(last.getTime() + minutes * MINUTE - 1000));
    expect((await reread(row)).expiryRetryCount).toBe(count);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();

    await sweepExpiredToolCallApprovals(new Date(last.getTime() + minutes * MINUTE));
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBe(count + 1);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
  });

  it('the retries before the cap span about six hours', () => {
    let at = new Date(0);
    for (let count = 0; count < MAX_EXPIRY_RETRIES; count += 1) {
      at = expiryRetryDueAt({
        resolvedAt: new Date(0), expiryRetryClaimedAt: count ? at : null, expiryRetryCount: count,
      });
    }
    expect(at.getTime()).toBeGreaterThanOrEqual(5.5 * 60 * MINUTE);
    expect(at.getTime()).toBeLessThanOrEqual(6.5 * 60 * MINUTE);
  });

  it('the operator script lists capped rows on a dry run and requeues them only with --apply', async () => {
    const last = new Date(Date.now() - 24 * 60 * MINUTE);
    const capped = await failedSoFar(MAX_EXPIRY_RETRIES, last);
    const retrying = await failedSoFar(2, last);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => retryCappedScript.parseArgs(['--aply'])).toThrow(/unknown argument/);

      const dry = await retryCappedScript.run([]);
      expect(dry).toMatchObject({ apply: false, requeued: 0 });
      expect(dry.capped.map((r) => r.approvalId)).toEqual([String(capped._id)]);
      expect((await reread(capped)).expiryRetryCount).toBe(MAX_EXPIRY_RETRIES);
      await sweepExpiredToolCallApprovals(new Date());
      expect((await reread(capped)).expiryRetryCount).toBe(MAX_EXPIRY_RETRIES);
      expect((await reread(capped)).expirySideEffectsDoneAt).toBeUndefined();

      const applied = await retryCappedScript.run(['--apply']);
      expect(applied).toMatchObject({ apply: true, requeued: 1 });
      expect((await reread(capped)).expiryRetryCount).toBe(0);
      expect((await reread(retrying)).expiryRetryCount).toBe(3); // the sweep above retried it once

      await sweepExpiredToolCallApprovals(new Date());
      const stored = await reread(capped);
      expect(stored.expiryRetryCount).toBe(1);
      expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    } finally {
      log.mockRestore();
    }
  });
});
