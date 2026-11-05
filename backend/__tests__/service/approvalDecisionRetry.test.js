/**
 * A parked tool call's decline and approve finish their side effects on a
 * retry, as an expiry does.
 *
 * The decision is one conditional write; the trail, the room receipt, the card
 * and the `approval.resolved` wake follow it. A failure or a crash after that
 * write used to lose whatever had not run, and an approved call that ran left
 * no durable ending at all if the process died before saving it.
 *
 * The rule under test on the approve path: the sweep never reaches the broker.
 * It finishes what the call left behind, and when the row does not say what
 * happened it asks the trail, then says it does not know.
 *
 * Real Mongo with the model's indexes. The trail store keeps its primary key,
 * and the event service writes real AgentEvent rows.
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
  const findApprovedRun = jest.fn(async (_grantId, approvalId) => {
    const found = [...rows.values()].find((r) => r.approvalId === approvalId && r.outcome !== 'pending_approval');
    return found ? {
      callId: found.callId, outcome: found.outcome, reason: found.reason, at: new Date('2026-11-05T10:00:00Z'),
    } : null;
  });
  const digestArgs = () => 'd'.repeat(64);
  return {
    __esModule: true, default: { create, digestArgs, findApprovedRun }, create, digestArgs, findApprovedRun, rows,
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
jest.mock('../../services/agentMessageService', () => ({ postMessage: jest.fn(async () => ({ success: true })) }));
jest.mock('../../services/toolBrokerService', () => ({ executeApprovedToolCall: jest.fn() }));
jest.mock('../../services/attentionItemService', () => ({
  ...jest.requireActual('../../services/attentionItemService'),
  resolve: jest.fn(async () => undefined),
  recordMentionedUsers: jest.fn(async () => undefined),
  resolveMentionAttentionForReply: jest.fn(async () => undefined),
}));
jest.mock('../../services/brokerRecordService', () => ({ recordApprovalOutcome: jest.fn() }));

const User = require('../../models/User');
const Message = require('../../models/Message');
const AgentEvent = require('../../models/AgentEvent');
const ApprovalAction = require('../../models/ApprovalAction');
const ToolCall = require('../../models/ToolCall');
const AgentEventService = require('../../services/agentEventService');
const AgentMessageService = require('../../services/agentMessageService');
const broker = require('../../services/toolBrokerService');
const attention = require('../../services/attentionItemService');
const { recordApprovalOutcome } = require('../../services/brokerRecordService');
const {
  sweepExpiredToolCallApprovals: sweep, resolveApproval, expiryRetryDueAt, MAX_EXPIRY_RETRIES,
  EXPIRY_RETRY_GRACE_MS, EXPIRY_WAKE_CLAIM_LEASE_MS, APPROVED_CALL_SETTLE_MS,
} = require('../../services/approvalActionService');

const retryCappedScript = require('../../scripts/retry-capped-approval-expiries');

jest.setTimeout(60000);

const MINUTE = 60 * 1000;
const podId = new mongoose.Types.ObjectId();
let owner;

// The broker call stays open until `finish`; `reached` resolves once it started.
const holdBroker = () => {
  let started;
  let finish;
  const reached = new Promise((resolve) => { started = resolve; });
  const held = new Promise((resolve) => { finish = resolve; });
  broker.executeApprovedToolCall.mockImplementation(() => {
    started();
    return held;
  });
  return { reached, finish: (...args) => finish(...args) };
};

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
      grantId: 'grant-1', callId: 'tool_call_parked', tool: 'github.create_issue', argsDigest: 'a'.repeat(64), canonicalArgs: { title: 'Bug' },
    },
    toolCallSlot: 0,
    expiresAt: new Date(Date.now() + 60 * MINUTE),
    ...overrides,
  });
};

const decide = (row, decision) => resolveApproval({
  approvalId: String(row._id), callerUserId: String(owner._id), decision,
});
const reread = (row) => ApprovalAction.findById(row._id).lean();
const trailFor = (row) => [...ToolCall.rows.values()].filter((r) => r.approvalId === String(row._id));
const eventsFor = (row) => AgentEvent.find({ type: 'approval.resolved', 'payload.approvalId': String(row._id) }).lean();
const cardFor = async (row) => (await Message.findById(row.messageId).lean()).payload;
const receipts = () => AgentMessageService.postMessage.mock.calls.length;
const pastGrace = () => new Date(Date.now() + EXPIRY_RETRY_GRACE_MS + MINUTE);
const pastSettle = () => new Date(Date.now() + APPROVED_CALL_SETTLE_MS + MINUTE);
const sweepWhenDue = async (row) => sweep(expiryRetryDueAt(await reread(row)));

// The broker's contract on a good run: its own trail row, then the result.
const brokerRuns = (row, { outcome = 'ok', receipt = { number: 42 } } = {}) => {
  broker.executeApprovedToolCall.mockImplementation(async () => {
    ToolCall.rows.set('tool_call_ran', {
      callId: 'tool_call_ran', approvalId: String(row._id), outcome, ...(outcome === 'failed' ? { reason: 'upstream_tool_error' } : {}),
    });
    return {
      callId: 'tool_call_ran', outcome, result: {}, ...(receipt ? { receipt } : {}),
    };
  });
};

// A row as a crash leaves it: the decision flipped, nothing after it ran.
const crashedAfterFlip = async (decision, overrides = {}) => {
  const row = await park();
  await ApprovalAction.updateOne({ _id: row._id }, {
    $set: {
      status: 'resolved',
      decision,
      resolvedBy: owner._id,
      resolvedAt: new Date(Date.now() - 5 * MINUTE),
      decidedBy: String(owner._id),
      decidedByRole: 'credential-owner',
      expiryRetryCount: 0,
      ...(decision === 'declined' ? { toolCallEnding: 'declined', toolCallCode: 'approval_declined' } : {}),
      ...overrides,
    },
    $unset: { 'toolCall.canonicalArgs': 1 },
  });
  return row;
};

const withLogsMuted = async (run) => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await run({ warn, error });
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
};

const failCardOnce = () => jest.spyOn(Message, 'updateOne').mockRejectedValueOnce(new Error('card store down'));
const failWakeOnce = () => AgentEventService.enqueue.mockImplementationOnce(async () => {
  throw new Error('event store down');
});
const failTrailOnce = () => ToolCall.create.mockImplementationOnce(async () => {
  throw new Error('trail store down');
});
const failReceiptOnce = () => AgentMessageService.postMessage.mockImplementationOnce(async () => {
  throw new Error('message store down');
});

const realEnqueue = AgentEventService.enqueue.getMockImplementation();
const realCreate = ToolCall.create.getMockImplementation();
const realFindRun = ToolCall.findApprovedRun.getMockImplementation();

beforeAll(async () => {
  await setupMongoDb();
  await ApprovalAction.init();
  owner = await User.create({
    username: 'decide-owner', email: 'decide-owner@test.com', password: 'password123', displayName: 'Dana',
  });
});

afterAll(closeMongoDb);

beforeEach(async () => {
  await ApprovalAction.deleteMany({});
  await AgentEvent.deleteMany({});
  await Message.deleteMany({});
  ToolCall.rows.clear();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  AgentEventService.enqueue.mockReset();
  AgentEventService.enqueue.mockImplementation(realEnqueue);
  ToolCall.create.mockReset();
  ToolCall.create.mockImplementation(realCreate);
  ToolCall.findApprovedRun.mockReset();
  ToolCall.findApprovedRun.mockImplementation(realFindRun);
  AgentMessageService.postMessage.mockReset();
  AgentMessageService.postMessage.mockImplementation(async () => ({ success: true }));
  broker.executeApprovedToolCall.mockReset();
});

describe('decline: each side effect can fail and is finished by the sweep', () => {
  it.each([
    ['trail', failTrailOnce],
    ['wake', failWakeOnce],
    ['card', failCardOnce],
  ])('a failed %s leaves the decline standing and the retry completes all of it, once', async (_, fail) => {
    const row = await park();
    fail();
    const res = await withLogsMuted(() => decide(row, 'declined'));
    expect(res.status).toBe(200);
    let stored = await reread(row);
    expect(stored).toMatchObject({
      status: 'resolved', decision: 'declined', toolCallEnding: 'declined', toolCallCode: 'approval_declined', expiryRetryCount: 0,
    });
    expect(stored.expirySideEffectsDoneAt).toBeUndefined();

    await sweep(pastGrace());
    stored = await reread(row);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(stored.expiryRetryCount).toBe(1);
    expect(stored).toMatchObject({ status: 'resolved', decision: 'declined', toolCallEnding: 'declined' });
    expect(trailFor(row)).toHaveLength(1);
    expect(trailFor(row)[0]).toMatchObject({ outcome: 'refused', reason: 'approval_declined' });
    expect(stored.toolCallTrailId).toBe(trailFor(row)[0].callId);
    expect(await cardFor(row)).toMatchObject({ status: 'resolved', decision: 'declined', toolCallEnding: 'declined' });
    const events = await eventsFor(row);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      decision: 'declined', ending: 'declined', runIds: [String(row.runId)], approvedBy: { username: 'Dana' },
    });
    expect(broker.executeApprovedToolCall).not.toHaveBeenCalled();
  });

  it('one failing step does not hold back the others', async () => {
    const row = await park();
    failTrailOnce();
    await withLogsMuted(() => decide(row, 'declined'));
    expect(await eventsFor(row)).toHaveLength(1);
    expect(await cardFor(row)).toMatchObject({ toolCallEnding: 'declined' });
    expect(trailFor(row)).toHaveLength(0);
  });

  it('a clean decline is marked done and no sweep touches it', async () => {
    const row = await park();
    expect((await decide(row, 'declined')).status).toBe(200);
    const done = await reread(row);
    expect(done.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    await sweep(pastSettle());
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBe(0);
    expect(stored.expirySideEffectsDoneAt).toEqual(done.expirySideEffectsDoneAt);
    expect(ToolCall.create).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a crash straight after the flip is finished by the sweep, inbox included', async () => {
    const row = await crashedAfterFlip('declined');
    await sweep(new Date());
    const stored = await reread(row);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(attention.resolve).toHaveBeenCalledWith('approval_action', expect.anything());
    expect(trailFor(row)).toHaveLength(1);
    expect(await eventsFor(row)).toHaveLength(1);
    expect(recordApprovalOutcome).toHaveBeenCalledWith(expect.anything(), expect.anything(), { kind: 'declined' });
  });
});

describe('approve: a failure after the call never runs it again', () => {
  it.each([
    ['receipt', failReceiptOnce],
    ['wake', failWakeOnce],
    ['card', failCardOnce],
  ])('a failed %s keeps the call recorded as run, and the retries finish without the broker', async (_, fail) => {
    const row = await park();
    brokerRuns(row);
    fail();
    const res = await withLogsMuted(() => decide(row, 'approved'));
    expect(res.status).toBe(200);
    expect(res.body.approval).toMatchObject({ toolCallEnding: 'ran' });
    let stored = await reread(row);
    expect(stored).toMatchObject({
      status: 'resolved', decision: 'approved', toolCallEnding: 'ran', toolCallTrailId: 'tool_call_ran', 
    });
    expect(stored.executedAt).toBeInstanceOf(Date);
    expect(stored.expirySideEffectsDoneAt).toBeUndefined();

    await sweep(pastGrace());
    await sweep(pastSettle());
    stored = await reread(row);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
    expect(await cardFor(row)).toMatchObject({ status: 'resolved', toolCallEnding: 'ran', toolCallTrailId: 'tool_call_ran' });
    const events = await eventsFor(row);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      decision: 'approved', ending: 'ran', callId: 'tool_call_ran', receipt: { number: 42 }, approvedBy: { username: 'Dana' },
    });
    expect(AgentMessageService.postMessage.mock.calls
      .filter(([m]) => m.metadata?.source === 'approval-tool-call').length)
      .toBe(fail === failReceiptOnce ? 2 : 1); // the failed post, then the one that landed
    expect(trailFor(row)).toHaveLength(1);
  });

  it('the marker is durable before any side effect runs', async () => {
    const row = await park();
    brokerRuns(row);
    let atReceipt;
    AgentMessageService.postMessage.mockImplementationOnce(async () => {
      atReceipt = await reread(row);
      return { success: true };
    });
    await decide(row, 'approved');
    expect(atReceipt).toMatchObject({ toolCallEnding: 'ran', toolCallTrailId: 'tool_call_ran', toolCallReceipt: { number: 42 } });
    expect(atReceipt.executedAt).toBeInstanceOf(Date);
  });

  it('a clean approval is marked done, and a second decision neither runs nor re-opens it', async () => {
    const row = await park();
    brokerRuns(row);
    await decide(row, 'approved');
    expect((await reread(row)).expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect((await decide(row, 'approved')).status).toBe(409);
    await sweep(pastSettle());
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
    expect(receipts()).toBe(1);
  });

  it('a retry has no arguments to run with: the decision scrubbed them', async () => {
    const row = await park();
    brokerRuns(row);
    failWakeOnce();
    await withLogsMuted(() => decide(row, 'approved'));
    expect((await reread(row)).toolCall.canonicalArgs).toBeUndefined();
  });

  it('a broker refusal is the ending, and it is retried like any other', async () => {
    const row = await park();
    broker.executeApprovedToolCall.mockRejectedValue(Object.assign(new Error('nope'), {
      code: 'grant_revoked', details: { recorded: true, outcome: 'refused', callId: 'tool_call_refused' },
    }));
    failWakeOnce();
    await withLogsMuted(() => decide(row, 'approved'));
    await sweep(pastGrace());
    const stored = await reread(row);
    expect(stored).toMatchObject({ toolCallEnding: 'refused', toolCallCode: 'grant_revoked', toolCallTrailId: 'tool_call_refused' });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
  });

  it('a broker code that is not a clean code does not reach the card on the live path', async () => {
    const row = await park();
    broker.executeApprovedToolCall.mockRejectedValue(Object.assign(new Error('nope'), {
      code: 'Vendor said: no', details: { recorded: true, outcome: 'failed', callId: 'tool_call_bad' },
    }));
    await decide(row, 'approved');
    expect(await reread(row)).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'broker_error' });
  });

  it('an unknown write whose broker trail also failed keeps the code and writes its own row', async () => {
    const row = await park();
    broker.executeApprovedToolCall.mockRejectedValue(Object.assign(new Error('did not run'), {
      code: 'approval_outcome_unknown', details: { recorded: false, outcome: 'failed' },
    }));
    await decide(row, 'approved');
    const stored = await reread(row);
    expect(stored).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'approval_outcome_unknown' });
    expect(trailFor(row)).toEqual([expect.objectContaining({
      outcome: 'failed', reason: 'approval_outcome_unknown', callId: stored.toolCallTrailId,
    })]);
    expect(AgentMessageService.postMessage.mock.calls[0][0].content).toContain('This call may have run.');
  });

  it('an unrecorded failure with any other code stays broker_error', async () => {
    const row = await park();
    broker.executeApprovedToolCall.mockRejectedValue(Object.assign(new Error('x'), {
      code: 'provider_error', details: { recorded: false, outcome: 'failed' },
    }));
    await decide(row, 'approved');
    expect(await reread(row)).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'broker_error' });
  });

  it('a write whose deadline fired takes the same path as a lost one: card, receipt, wake, no re-run', async () => {
    const row = await park();
    broker.executeApprovedToolCall.mockRejectedValue(Object.assign(new Error('did not run'), {
      code: 'approval_outcome_unknown', details: { recorded: true, outcome: 'failed', callId: 'tool_call_timed_out' },
    }));
    expect((await decide(row, 'approved')).body.approval).toMatchObject({ toolCallCode: 'approval_outcome_unknown' });
    const stored = await reread(row);
    expect(stored).toMatchObject({
      toolCallEnding: 'failed', toolCallCode: 'approval_outcome_unknown', toolCallTrailId: 'tool_call_timed_out',
    });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(trailFor(row)).toHaveLength(0); // the broker wrote it
    expect(await cardFor(row)).toMatchObject({ toolCallCode: 'approval_outcome_unknown' });
    expect(AgentMessageService.postMessage.mock.calls[0][0].content)
      .toContain('This call may have run. Check before approving it again.');
    const [event] = await eventsFor(row);
    expect(event.payload.content).toMatch(/may have run/i);
    await sweep(pastSettle());
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
  });

  it('a broker failure that wrote no trail keeps its ending and writes the trail on the retry', async () => {
    const row = await park();
    broker.executeApprovedToolCall.mockRejectedValue(new Error('boom'));
    failTrailOnce();
    const res = await withLogsMuted(() => decide(row, 'approved'));
    expect(res.status).toBe(200);
    let stored = await reread(row);
    expect(stored).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'broker_error' });
    expect(stored.toolCallTrailId).toBeTruthy();
    expect(trailFor(row)).toHaveLength(0);

    await sweep(pastGrace());
    stored = await reread(row);
    expect(trailFor(row)).toHaveLength(1);
    expect(trailFor(row)[0]).toMatchObject({ outcome: 'failed', reason: 'broker_error', callId: stored.toolCallTrailId });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
  });

  it('a call that ran but whose trail write failed stays run, and the retry writes the trail row', async () => {
    const row = await park();
    broker.executeApprovedToolCall.mockResolvedValue({
      callId: 'tool_call_unwritten',
      outcome: 'ok',
      result: {},
      trailUnwritten: {
        podId: 'grant-target-pod', installationId: 'install-1', durationMs: 1234, providerRef: 'refs/heads/seat/x',
      },
    });
    failTrailOnce();
    await withLogsMuted(() => decide(row, 'approved'));
    let stored = await reread(row);
    expect(stored).toMatchObject({
      toolCallEnding: 'ran',
      toolCallTrailId: 'tool_call_unwritten',
      toolCallTrailUnwritten: { installationId: 'install-1', durationMs: 1234 },
    });
    const ranAt = stored.executedAt;
    expect(trailFor(row)).toHaveLength(0);

    await sweep(pastGrace());
    stored = await reread(row);
    expect(trailFor(row)).toHaveLength(1);
    expect(trailFor(row)[0]).toMatchObject({
      callId: 'tool_call_unwritten',
      outcome: 'ok',
      at: ranAt,
      podId: 'grant-target-pod',
      installationId: 'install-1',
      durationMs: 1234,
      providerRef: 'refs/heads/seat/x',
    });
    expect(stored.toolCallTrailUnwritten).toBeUndefined();
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
  });

  it('after a clean run the trail write is not repeated', async () => {
    const row = await park();
    brokerRuns(row);
    failWakeOnce();
    await withLogsMuted(() => decide(row, 'approved'));
    await sweep(pastGrace());
    // The broker wrote the only trail row; the approval adds none of its own.
    expect(ToolCall.create).not.toHaveBeenCalled();
  });
});

describe('approve: a crash between the call and the marker', () => {
  it('a failed marker write leaves the caller told the truth, and the sweep reads the ending from the trail', async () => {
    const row = await park();
    brokerRuns(row);
    const save = jest.spyOn(ApprovalAction.prototype, 'save').mockRejectedValue(new Error('mongo down'));
    const res = await withLogsMuted(() => decide(row, 'approved'));
    save.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.approval).toMatchObject({ toolCallEnding: 'ran' });
    expect((await reread(row)).toolCallEnding).toBeUndefined();

    await sweepWhenDue(row);
    const stored = await reread(row);
    expect(stored).toMatchObject({ toolCallEnding: 'ran', toolCallTrailId: 'tool_call_ran' });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
    expect(await eventsFor(row)).toHaveLength(1);
    expect(receipts()).toBe(1);
  });

  it('a process death after the call recovers the ending from the trail and never calls the broker', async () => {
    const row = await crashedAfterFlip('approved', { resolvedAt: new Date(Date.now() - APPROVED_CALL_SETTLE_MS - MINUTE) });
    ToolCall.rows.set('tool_call_ran', { callId: 'tool_call_ran', approvalId: String(row._id), outcome: 'ok' });
    await sweep(new Date());
    const stored = await reread(row);
    expect(stored).toMatchObject({
      status: 'resolved', decision: 'approved', toolCallEnding: 'ran', toolCallTrailId: 'tool_call_ran', expiryRetryCount: 1,
    });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(stored.executedAt).toEqual(new Date('2026-11-05T10:00:00Z')); // the trail's time, not the sweep's
    expect(broker.executeApprovedToolCall).not.toHaveBeenCalled();
    expect(await cardFor(row)).toMatchObject({ toolCallEnding: 'ran' });
    const events = await eventsFor(row);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ ending: 'ran', approvedBy: { username: 'Dana' } });
    expect(receipts()).toBe(1);
  });

  it('a trail row for a failed call recovers as failed with its reason', async () => {
    const row = await crashedAfterFlip('approved', { resolvedAt: new Date(Date.now() - APPROVED_CALL_SETTLE_MS - MINUTE) });
    ToolCall.rows.set('tool_call_ran', {
      callId: 'tool_call_ran', approvalId: String(row._id), outcome: 'failed', reason: 'upstream_tool_error',
    });
    await sweep(new Date());
    expect(await reread(row)).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'upstream_tool_error', toolCallTrailId: 'tool_call_ran' });
  });

  it('no trail row means nobody knows: the row says so, the agent is told, and the call is not run', async () => {
    const row = await crashedAfterFlip('approved', { resolvedAt: new Date(Date.now() - APPROVED_CALL_SETTLE_MS - MINUTE) });
    await sweep(new Date());
    const stored = await reread(row);
    expect(stored).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'approval_outcome_unknown' });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(broker.executeApprovedToolCall).not.toHaveBeenCalled();
    expect(trailFor(row)).toHaveLength(1);
    expect(trailFor(row)[0]).toMatchObject({ outcome: 'failed', reason: 'approval_outcome_unknown', callId: stored.toolCallTrailId });
    expect(stored.executedAt).toBeUndefined();
    const [event] = await eventsFor(row);
    expect(event.payload).toMatchObject({ ending: 'failed', code: 'approval_outcome_unknown' });
    expect(event.payload.content).toMatch(/may have run/i);
    const [receipt] = AgentMessageService.postMessage.mock.calls[0];
    expect(receipt.content).toContain('This call may have run. Check before approving it again.');
    expect(receipt.content).not.toMatch(/failed/i);
  });

  it('a trail reason that is not a clean code does not reach the card', async () => {
    const row = await crashedAfterFlip('approved', { resolvedAt: new Date(Date.now() - APPROVED_CALL_SETTLE_MS - MINUTE) });
    ToolCall.rows.set('tool_call_ran', {
      callId: 'tool_call_ran', approvalId: String(row._id), outcome: 'failed', reason: 'Vendor said: no',
    });
    await sweep(new Date());
    expect(await reread(row)).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'broker_error' });
    expect(await cardFor(row)).toMatchObject({ toolCallCode: 'broker_error' });
  });

  it('a settle that loses to a live ending leaves it alone, on the row and on the card', async () => {
    const row = await crashedAfterFlip('approved', { resolvedAt: new Date(Date.now() - APPROVED_CALL_SETTLE_MS - MINUTE) });
    // The live save lands after the sweep read the trail and before it writes.
    ToolCall.findApprovedRun.mockImplementationOnce(async () => {
      await ApprovalAction.updateOne({ _id: row._id }, {
        $set: { toolCallEnding: 'ran', toolCallTrailId: 'tool_call_live', executedAt: new Date() },
      });
      return null;
    });
    await sweep(new Date());
    const stored = await reread(row);
    expect(stored).toMatchObject({ toolCallEnding: 'ran', toolCallTrailId: 'tool_call_live' });
    expect(stored.toolCallCode).toBeUndefined();
    expect(await cardFor(row)).toMatchObject({ toolCallEnding: 'ran', toolCallTrailId: 'tool_call_live' });
    expect(trailFor(row)).toHaveLength(0);
    // The attempt carries on with the stored ending, so the wake and receipt tell the truth.
    const events = await eventsFor(row);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ ending: 'ran', callId: 'tool_call_live' });
    expect(AgentMessageService.postMessage.mock.calls[0][0].content).toContain('· ran');
  });

  it('a live ending that lands mid-closure keeps its own retry: the sweep\'s done stamp does not land on it', async () => {
    const row = await crashedAfterFlip('approved', { resolvedAt: new Date(Date.now() - APPROVED_CALL_SETTLE_MS - MINUTE) });
    AgentMessageService.postMessage.mockImplementationOnce(async () => {
      await ApprovalAction.updateOne({ _id: row._id }, {
        $set: { toolCallEnding: 'ran', toolCallTrailId: 'tool_call_live' },
        $unset: { toolCallCode: 1, expirySideEffectsDoneAt: 1 },
      });
      return { success: true };
    });
    await sweep(new Date());
    const stored = await reread(row);
    expect(stored.toolCallEnding).toBe('ran');
    expect(stored.expirySideEffectsDoneAt ?? null).toBeNull();
  });

  it('a live ending that lands while the sweep is mid-closure wins the card', async () => {
    const row = await crashedAfterFlip('approved', { resolvedAt: new Date(Date.now() - APPROVED_CALL_SETTLE_MS - MINUTE) });
    // The sweep settled unknown; a live save lands while it posts the receipt.
    AgentMessageService.postMessage.mockImplementationOnce(async () => {
      await ApprovalAction.updateOne({ _id: row._id }, {
        $set: { toolCallEnding: 'ran', toolCallTrailId: 'tool_call_live' }, $unset: { toolCallCode: 1 },
      });
      return { success: true };
    });
    await sweep(new Date());
    expect(await cardFor(row)).toMatchObject({ toolCallEnding: 'ran', toolCallTrailId: 'tool_call_live' });
  });

  it('a call still running is not judged: the sweep leaves an unended approval alone until it settles', async () => {
    const row = await park();
    const { reached, finish } = holdBroker();
    const deciding = decide(row, 'approved');
    await reached;

    await sweep(pastGrace());
    await sweep(new Date(Date.now() + APPROVED_CALL_SETTLE_MS - MINUTE));
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBe(0);
    expect(stored.toolCallEnding).toBeUndefined();
    expect(ToolCall.findApprovedRun).not.toHaveBeenCalled();

    finish({ callId: 'tool_call_slow', outcome: 'ok', result: {} });
    await deciding;
    expect(await reread(row)).toMatchObject({ toolCallEnding: 'ran', expiryRetryCount: 0 });
  });

  it('a live call that outlasts the settle still lands its real ending over the unknown one', async () => {
    const row = await park();
    const { reached, finish } = holdBroker();
    const deciding = decide(row, 'approved');
    await reached;

    await sweep(pastSettle());
    expect(await reread(row)).toMatchObject({ toolCallCode: 'approval_outcome_unknown' });

    finish({ callId: 'tool_call_slow', outcome: 'ok', result: {} });
    await deciding;
    const stored = await reread(row);
    expect(stored).toMatchObject({ toolCallEnding: 'ran', toolCallTrailId: 'tool_call_slow' });
    expect(stored.toolCallCode).toBeUndefined();
    expect(await cardFor(row)).toMatchObject({ toolCallEnding: 'ran' });
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
  });

  it('a late live ending reopens the row, so a closure failing after the sweep stamped it is still retried', async () => {
    const row = await park();
    const { reached, finish } = holdBroker();
    const deciding = decide(row, 'approved');
    await reached;
    await sweep(pastSettle());
    expect((await reread(row)).expirySideEffectsDoneAt).toBeInstanceOf(Date);

    failCardOnce();
    finish({
      callId: 'tool_call_slow', outcome: 'ok', result: {}, trailUnwritten: { installationId: 'install-1', durationMs: 5 },
    });
    failTrailOnce();
    await withLogsMuted(() => deciding);
    let stored = await reread(row);
    expect(stored).toMatchObject({ toolCallEnding: 'ran', toolCallTrailId: 'tool_call_slow' });
    expect(stored.toolCallTrailUnwritten).toBeTruthy();
    expect(stored.expirySideEffectsDoneAt).toBeUndefined();

    await sweepWhenDue(row);
    stored = await reread(row);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(stored.toolCallTrailUnwritten).toBeUndefined();
    expect(await cardFor(row)).toMatchObject({ toolCallEnding: 'ran' });
    expect(trailFor(row).find((r) => r.callId === 'tool_call_slow')).toMatchObject({ outcome: 'ok' });
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
  });

  it('an unreadable trail settles nothing: the attempt fails and a later one reads it', async () => {
    const row = await crashedAfterFlip('approved', { resolvedAt: new Date(Date.now() - APPROVED_CALL_SETTLE_MS - MINUTE) });
    ToolCall.rows.set('tool_call_ran', { callId: 'tool_call_ran', approvalId: String(row._id), outcome: 'ok' });
    ToolCall.findApprovedRun.mockImplementationOnce(async () => { throw new Error('trail store down'); });
    await withLogsMuted(() => sweep(new Date()));
    let stored = await reread(row);
    expect(stored.toolCallEnding).toBeUndefined();
    expect(stored.expiryRetryCount).toBe(1);
    expect(await eventsFor(row)).toHaveLength(0);

    await sweepWhenDue(row);
    stored = await reread(row);
    expect(stored.toolCallEnding).toBe('ran');
    expect(stored.expiryRetryCount).toBe(2);
  });
});

describe('lease contention', () => {
  it('two sweeps at once: one claims the row and the other leaves it', async () => {
    const row = await park();
    brokerRuns(row);
    failWakeOnce();
    await withLogsMuted(() => decide(row, 'approved'));
    const at = pastGrace();
    await Promise.all([sweep(at), sweep(at)]);
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBe(1);
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(await eventsFor(row)).toHaveLength(1);
    expect(receipts()).toBe(1);
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
  });

  it('two sweeps at once on a crashed approval run the reconcile once', async () => {
    const row = await crashedAfterFlip('approved', { resolvedAt: new Date(Date.now() - APPROVED_CALL_SETTLE_MS - MINUTE) });
    ToolCall.rows.set('tool_call_ran', { callId: 'tool_call_ran', approvalId: String(row._id), outcome: 'ok' });
    const at = new Date();
    await Promise.all([sweep(at), sweep(at)]);
    expect((await reread(row)).expiryRetryCount).toBe(1);
    expect(ToolCall.findApprovedRun).toHaveBeenCalledTimes(1);
    expect(await eventsFor(row)).toHaveLength(1);
    expect(receipts()).toBe(1);
  });

  it('a stale wake lease from a crashed decide is taken over: at least once, not at most once', async () => {
    const row = await crashedAfterFlip('declined', {
      expiryEventClaimedAt: new Date(Date.now() - EXPIRY_WAKE_CLAIM_LEASE_MS - 1000),
    });
    await sweep(new Date());
    expect(await eventsFor(row)).toHaveLength(1);
    expect((await reread(row)).expiryEventSentAt).toBeInstanceOf(Date);
  });

  it('a fresh wake lease is not sent over, and the row stays incomplete', async () => {
    const row = await crashedAfterFlip('declined', { expiryEventClaimedAt: new Date(Date.now() - 10 * 1000) });
    await withLogsMuted(() => sweep(new Date()));
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect((await reread(row)).expirySideEffectsDoneAt).toBeUndefined();
  });

  it('a failed send releases its wake lease, so the next attempt need not wait it out', async () => {
    const row = await park();
    failWakeOnce();
    await withLogsMuted(() => decide(row, 'declined'));
    expect((await reread(row)).expiryEventClaimedAt).toBeUndefined();
  });

  it('a crash after the send but before the stamp finds the event and does not wake again', async () => {
    const row = await crashedAfterFlip('declined', {
      expiryEventClaimedAt: new Date(Date.now() - EXPIRY_WAKE_CLAIM_LEASE_MS - 1000),
    });
    await AgentEvent.create({
      agentName: 'alice', instanceId: 'default', podId, type: 'approval.resolved', payload: { approvalId: String(row._id) },
    });
    await sweep(new Date());
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect((await reread(row)).expirySideEffectsDoneAt).toBeInstanceOf(Date);
  });

  it('a stale receipt lease is taken over, a fresh one is not, and a stamped receipt is never re-sent', async () => {
    const base = {
      toolCallEnding: 'ran',
      toolCallTrailId: 'tool_call_ran',
      executedAt: new Date(Date.now() - 5 * MINUTE),
    };
    const stale = await crashedAfterFlip('approved', {
      ...base, toolCallReceiptClaimedAt: new Date(Date.now() - EXPIRY_WAKE_CLAIM_LEASE_MS - 1000),
    });
    await sweep(new Date());
    expect(receipts()).toBe(1);
    expect((await reread(stale)).toolCallReceiptPostedAt).toBeInstanceOf(Date);

    await ApprovalAction.deleteMany({});
    const fresh = await crashedAfterFlip('approved', {
      ...base, toolCallReceiptClaimedAt: new Date(Date.now() - 10 * 1000),
    });
    await withLogsMuted(() => sweep(new Date()));
    expect(receipts()).toBe(1);
    expect((await reread(fresh)).expirySideEffectsDoneAt).toBeUndefined();

    await ApprovalAction.deleteMany({});
    await crashedAfterFlip('approved', { ...base, toolCallReceiptPostedAt: new Date() });
    await sweep(new Date());
    expect(receipts()).toBe(1);
  });
});

describe('the cap, and the way back', () => {
  it('a card that never writes is capped; the wake and receipt that landed are not re-sent', async () => {
    const row = await park();
    brokerRuns(row);
    const write = jest.spyOn(Message, 'updateOne').mockRejectedValue(new Error('card store down'));
    await withLogsMuted(async ({ error }) => {
      await decide(row, 'approved');
      for (let i = 0; i < MAX_EXPIRY_RETRIES + 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sweepWhenDue(row);
      }
      const stored = await reread(row);
      expect(stored.expiryRetryCount).toBe(MAX_EXPIRY_RETRIES);
      expect(stored.expirySideEffectsDoneAt).toBeUndefined();
      expect(write).toHaveBeenCalledTimes(1 + MAX_EXPIRY_RETRIES);
      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
      expect(receipts()).toBe(1);
      expect(error.mock.calls.filter(([line]) => String(line).includes('gave up'))).toHaveLength(1);
    });
    write.mockRestore();
    expect(broker.executeApprovedToolCall).toHaveBeenCalledTimes(1);
  });

  it('the operator script lists a capped decision and requeues it with --apply', async () => {
    const row = await crashedAfterFlip('declined', {
      expiryRetryCount: MAX_EXPIRY_RETRIES, expiryRetryClaimedAt: new Date(Date.now() - 24 * 60 * MINUTE),
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const dry = await retryCappedScript.run([]);
    expect(dry.capped.map((r) => r.approvalId)).toEqual([String(row._id)]);
    expect((await reread(row)).expiryRetryCount).toBe(MAX_EXPIRY_RETRIES);

    expect(await retryCappedScript.run(['--apply'])).toMatchObject({ requeued: 1 });
    log.mockRestore();
    await sweep(new Date());
    expect((await reread(row)).expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(trailFor(row)).toHaveLength(1);
  });

  it('a capped row that finished is not listed', async () => {
    await crashedAfterFlip('declined', {
      expiryRetryCount: MAX_EXPIRY_RETRIES, expirySideEffectsDoneAt: new Date(),
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    expect((await retryCappedScript.run([])).capped).toHaveLength(0);
    log.mockRestore();
  });
});

describe('what the retry leaves alone', () => {
  it('a decision written before this change carries no count and is never re-selected', async () => {
    const row = await crashedAfterFlip('declined');
    await ApprovalAction.updateOne({ _id: row._id }, { $unset: { expiryRetryCount: 1 } });
    await sweep(pastSettle());
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBeUndefined();
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  it('a legacy action decision is not opted in', async () => {
    const row = await park({
      actionType: 'create_pod', params: { name: 'x' }, toolCall: undefined, toolCallSlot: undefined, 
    });
    await decide(row, 'declined');
    const stored = await reread(row);
    expect(stored.expiryRetryCount).toBeUndefined();
    expect(stored.expirySideEffectsDoneAt).toBeUndefined();
  });

  it('an expired row still takes the expiry path', async () => {
    const row = await park({ expiresAt: new Date(Date.now() - 1000) });
    failWakeOnce();
    await withLogsMuted(() => sweep(new Date()));
    await sweep(pastGrace());
    const stored = await reread(row);
    expect(stored).toMatchObject({ status: 'expired', toolCallEnding: 'expired', toolCallCode: 'approval_expired' });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(trailFor(row)[0]).toMatchObject({ reason: 'approval_expired' });
    expect(receipts()).toBe(0);
  });
});
