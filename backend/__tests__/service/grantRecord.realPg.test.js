/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * TASK-560: grants and brokered calls reach the pod's record through the
 * real broker, the real approval resolver and the real grant service, on real
 * MongoDB (grants, approvals, the board) and real PostgreSQL (tool_calls, the
 * chain). Only the vendor and the delivery side effects are stubbed: GitHub,
 * the seat-confinement and outsider-pod guards, card posting, sockets and
 * event delivery. None of them decides what the record says.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'grant-record-test-secret';

const mockGithub = {
  createIssue: jest.fn(),
  closeIssue: jest.fn(),
  listOpenIssues: jest.fn(),
  getIssue: jest.fn(),
};
jest.mock('../../services/githubAppService', () => mockGithub);
jest.mock('../../services/seatGrantConfinement', () => ({
  judgeSeatConfinement: jest.fn(async () => ({ refusal: null, scope: 'unbound' })),
}));
jest.mock('../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn(() => 'refused'),
}));
jest.mock('../../services/agentMessageService', () => ({
  postMessage: jest.fn(async () => ({ success: true, message: { _id: 'card-message' } })),
}));
jest.mock('../../config/socket', () => ({ getIO: jest.fn(() => null) }));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn(async () => ({})) }));

const express = require('express');
const request = require('supertest');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const Integration = require('../../models/Integration').default || require('../../models/Integration');
const RoomGrant = require('../../models/RoomGrant').default;
const ApprovalAction = require('../../models/ApprovalAction').default || require('../../models/ApprovalAction');
const { pool } = require('../../config/db-pg');
const { markWriteUnknown } = require('../../services/brokerWriteOutcome');
const ToolCall = require('../../models/ToolCall').default;
const AgentMessageService = require('../../services/agentMessageService');
const roomGrants = require('../../services/roomGrantService');
const { callTool } = require('../../services/toolBrokerService');
const approvals = require('../../services/approvalActionService');
const { recordGrantIssued } = require('../../services/brokerRecordService');
const { flushRecordWrites, humanActor, agentActor } = require('../../services/recordService');
const { verifyRecord, readRecord } = require('../../vendor/seats/src/record/format');
const { toOtlpJson } = require('../../vendor/seats/src/record/otel');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, setupPgDb, closePgDb, generateTestToken,
} = require('../utils/testUtils');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const flushAll = async () => {
  // Approval outcomes read the grant before they queue; let that settle first.
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  await flushRecordWrites();
};

real('grant and broker lines on real PostgreSQL and MongoDB', () => {
  let app;
  let owner;
  let agent;
  let pod;

  beforeAll(async () => {
    await setupMongoDb();
    await setupPgDb();
    app = express();
    app.use(express.json());
    app.use('/api/pods', require('../../routes/podRecords'));
  });

  beforeEach(async () => {
    await clearMongoDb();
    const stamp = Date.now();
    owner = await User.create({ username: `grant-owner-${stamp}`, email: `grant-owner-${stamp}@test.com`, password: 'Password123!', verified: true });
    agent = await User.create({
      username: `grant-agent-${stamp}`, email: `grant-agent-${stamp}@agents.commonly.local`, password: 'Password123!',
      verified: true, isBot: true, botType: 'agent', botMetadata: { agentName: 'grant-agent', instanceId: 'default', ownerUserId: String(owner._id) },
    });
    pod = await Pod.create({ name: 'Grant pod', type: 'team', createdBy: owner._id, members: [owner._id, agent._id] });
    await Integration.create({
      podId: pod._id, type: 'github-app', status: 'connected', createdBy: owner._id, installationId: 'install-1',
      config: { installationId: 'install-1', owner: 'octo', repo: 'demo' },
      createdAt: new Date(Date.now() - 60_000),
    });
    mockGithub.createIssue.mockResolvedValue({ number: 1, title: 'x', html_url: 'https://github.com/octo/demo/issues/1' });
    mockGithub.closeIssue.mockResolvedValue({ number: 7, title: 'closed', html_url: 'https://github.com/octo/demo/issues/7', state: 'closed' });
    process.env.RECORD_V1_PODS = String(pod._id);
  });

  afterEach(async () => {
    await flushAll();
    await pool.query('DELETE FROM record_openings WHERE chain_id IN (SELECT id FROM record_chains WHERE pod_id = $1)', [String(pod._id)]);
    await pool.query('DELETE FROM record_lines WHERE chain_id IN (SELECT id FROM record_chains WHERE pod_id = $1)', [String(pod._id)]);
    await pool.query('DELETE FROM record_chains WHERE pod_id = $1', [String(pod._id)]);
    delete process.env.RECORD_V1_PODS;
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
    await closePgDb();
  });

  const mint = async (over = {}) => {
    const grant = await roomGrants.createGrant({
      connectionId: 'install-1', installationId: 'install-1', brokerId: 'commonly-grant-broker',
      target: { kind: 'pod', id: String(pod._id) }, tools: ['github.create_issue', 'github.close_issue'],
      writeMode: 'write-with-confirm', audience: [String(agent._id)],
      expiresAt: new Date(Date.now() + 86_400_000), ...over,
    });
    // What POST /api/grants does after the mint (its wiring is in grants.mint.test.js).
    recordGrantIssued(grant.toObject(), humanActor(owner._id));
    return grant;
  };
  const readPod = async () => {
    await flushAll();
    const res = await request(app).get(`/api/pods/${pod._id}/record`).set('Authorization', `Bearer ${generateTestToken(owner._id)}`);
    expect(res.status).toBe(200);
    expect(verifyRecord(res.text)).toMatchObject({ ok: true });
    return { text: res.text, lines: res.text ? readRecord(res.text) : [] };
  };
  const call = (grant, tool, args) => callTool({ grantId: grant.grantId, agentUserId: String(agent._id), tool, args });
  const kinds = (lines) => lines.map((l) => (l.kind === 'permission.decided' ? `decided:${l.data.approval || l.data.rule.list}` : l.kind));

  it('issue, attenuate, revoke cascade and expiry', async () => {
    const root = await mint();
    const child = await roomGrants.attenuateGrant({
      parentGrantId: root.grantId, tools: ['github.close_issue'], expiresAt: new Date(Date.now() + 3_600_000),
    });
    recordGrantIssued(child.toObject(), agentActor(agent));
    expect(await roomGrants.revokeGrant(root.grantId, String(owner._id))).toBe(2);
    const late = await mint();
    await RoomGrant.updateOne({ grantId: late.grantId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(roomGrants.assertGrantUsable({ grantId: late.grantId, agentUserId: String(agent._id), currentMemberIds: [String(agent._id)] }))
        .rejects.toMatchObject({ code: 'grant_expired' });
    }

    const { lines } = await readPod();
    expect(lines.map((l) => [l.kind, l.data.grantId || l.data.grantIds])).toEqual([
      ['grant.issued', root.grantId],
      ['grant.issued', child.grantId],
      ['grant.revoked', [root.grantId, child.grantId]],
      ['grant.issued', late.grantId],
      ['grant.revoked', [late.grantId]],
    ]);
    expect(lines[1]).toMatchObject({ actor: { type: 'agent', id: String(agent._id), owner: String(owner._id) }, data: { parentGrantId: root.grantId } });
    expect(lines[2]).toMatchObject({ actor: { type: 'human', id: String(owner._id) }, data: { reason: 'cascade' } });
    expect(lines[4]).toMatchObject({ actor: { type: 'system', id: 'commonly' }, data: { reason: 'expired' } });
  });

  it('B1 refused, B5 executed, B2 parked then B3 declined: one terminal decision per call', async () => {
    const grant = await mint({ writeMode: 'write', tools: ['github.close_issue', 'github.create_issue'] });
    await expect(call(grant, 'github.list_issues', {})).rejects.toMatchObject({ code: 'tool_not_allowed' });
    await call(grant, 'github.close_issue', { issueNumber: 7 });
    const parked = await call(grant, 'github.create_issue', { title: 'needs approval' }).catch((error) => error);
    expect(parked).toMatchObject({ code: 'approval_required' });
    const declined = await approvals.resolveApproval({ approvalId: parked.details.approvalId, callerUserId: String(owner._id), decision: 'declined' });
    expect(declined.status).toBe(200);

    const { lines, text } = await readPod();
    const calls = lines.filter((l) => l.kind !== 'grant.issued');
    expect(kinds(calls)).toEqual([
      'tool.call', 'permission.requested', 'decided:deny', 'tool.update',
      'tool.call', 'permission.requested', 'decided:allow', 'tool.update',
      'tool.call', 'permission.requested', 'decided:rejected', 'tool.update',
    ]);
    const parkedId = parked.details.callId;
    const forParked = calls.filter((l) => l.data.toolCallId === parkedId);
    expect(forParked.map((l) => l.kind)).toEqual(['tool.call', 'permission.requested', 'permission.decided', 'tool.update']);
    expect(forParked[1].data).toMatchObject({ askedOf: { id: String(owner._id), role: 'credential-owner' }, decisionCardId: parked.details.approvalId });
    expect(forParked[2]).toMatchObject({ actor: { type: 'human', id: String(owner._id) }, data: { decidedBy: String(owner._id), decidedByRole: 'credential-owner' } });
    // The declined call's own PG trail row (refused/approval_declined) did not add a second decision.
    expect(calls.filter((l) => l.kind === 'permission.decided')).toHaveLength(3);
    expect(text).not.toMatch(/argsDigest|sha256:/);
    expect(JSON.stringify(toOtlpJson(lines, { serviceName: 'commonly' }))).not.toMatch(/args_digest|argsDigest/);
  });

  it('B2 parked then B3 approved and run, and B4 timed out in the sweep', async () => {
    const grant = await mint();
    const first = await call(grant, 'github.create_issue', { title: 'approve me' }).catch((error) => error);
    const resolved = await approvals.resolveApproval({ approvalId: first.details.approvalId, callerUserId: String(owner._id), decision: 'approved' });
    expect(resolved.status).toBe(200);
    expect(mockGithub.createIssue).toHaveBeenCalledTimes(1);
    const second = await call(grant, 'github.create_issue', { title: 'let it lapse' }).catch((error) => error);
    await ApprovalAction.updateOne({ _id: second.details.approvalId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await approvals.sweepExpiredToolCallApprovals()).toBe(1);

    const { lines } = await readPod();
    const of = (id) => kinds(lines.filter((l) => l.data.toolCallId === id));
    expect(of(first.details.callId)).toEqual(['tool.call', 'permission.requested', 'decided:approved', 'tool.update']);
    expect(lines.filter((l) => l.data.toolCallId === first.details.callId).pop().data.status).toBe('completed');
    expect(of(second.details.callId)).toEqual(['tool.call', 'permission.requested', 'decided:timed_out', 'tool.update']);
    // The approved run wrote its own ok trail row in PG; it adds no line of its own.
    expect(lines.filter((l) => l.kind === 'tool.call')).toHaveLength(2);
  });

  it('F202: a retried expiry hits the derived trail id\'s primary key and leaves one refusal row', async () => {
    const grant = await mint();
    const parked = await call(grant, 'github.create_issue', { title: 'lapse twice' }).catch((error) => error);
    const approvalId = String(parked.details.approvalId);
    await ApprovalAction.updateOne({ _id: approvalId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const now = new Date();
    expect(await approvals.sweepExpiredToolCallApprovals(now)).toBe(1);
    // A crash after the trail row but before the marker: the retry inserts the same derived id.
    await ApprovalAction.updateOne({ _id: approvalId }, { $unset: { expirySideEffectsDoneAt: 1 } });
    await approvals.sweepExpiredToolCallApprovals(new Date(now.getTime() + approvals.EXPIRY_RETRY_GRACE_MS + 60 * 1000));

    const stored = await ApprovalAction.findById(approvalId).lean();
    expect(stored).toMatchObject({ expiryRetryCount: 1 });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    const { rows } = await pool.query(
      "SELECT call_id FROM tool_calls WHERE approval_id = $1 AND outcome = 'refused' AND reason = 'approval_expired'",
      [approvalId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].call_id).toBe(stored.toolCallTrailId);
    // The record dedupes on its own key, so the retry adds no second decision line.
    const { lines } = await readPod();
    expect(kinds(lines.filter((l) => l.data.toolCallId === parked.details.callId)))
      .toEqual(['tool.call', 'permission.requested', 'decided:timed_out', 'tool.update']);
  });

  it('a retried decline hits the derived trail id\'s primary key and leaves one refusal row', async () => {
    const grant = await mint();
    const parked = await call(grant, 'github.create_issue', { title: 'decline twice' }).catch((error) => error);
    const approvalId = String(parked.details.approvalId);
    await approvals.resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'declined' });
    // A crash after the trail row but before the marker.
    await ApprovalAction.updateOne({ _id: approvalId }, { $unset: { expirySideEffectsDoneAt: 1 } });
    await approvals.sweepExpiredToolCallApprovals(new Date(Date.now() + approvals.EXPIRY_RETRY_GRACE_MS + 60 * 1000));

    const stored = await ApprovalAction.findById(approvalId).lean();
    expect(stored).toMatchObject({ expiryRetryCount: 1 });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    const { rows } = await pool.query(
      "SELECT call_id FROM tool_calls WHERE approval_id = $1 AND outcome = 'refused' AND reason = 'approval_declined'",
      [approvalId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].call_id).toBe(stored.toolCallTrailId);
    // The record dedupes on its own key, so the retry adds no second decision line.
    await flushAll();
    const { lines } = await readPod();
    expect(kinds(lines.filter((l) => l.data.toolCallId === parked.details.callId)))
      .toEqual(['tool.call', 'permission.requested', 'decided:rejected', 'tool.update']);
  });

  it('a crash between the call and its marker recovers the ending from the real trail, and the call runs once', async () => {
    const grant = await mint();
    const parked = await call(grant, 'github.create_issue', { title: 'approve then die' }).catch((error) => error);
    const approvalId = String(parked.details.approvalId);
    await approvals.resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
    expect(mockGithub.createIssue).toHaveBeenCalledTimes(1);
    const before = await ApprovalAction.findById(approvalId).lean();
    // The broker's row is in the trail; the approval row never got its ending.
    await ApprovalAction.updateOne({ _id: approvalId }, {
      $unset: {
        toolCallEnding: 1, toolCallTrailId: 1, expirySideEffectsDoneAt: 1, executedAt: 1,
      },
    });
    await approvals.sweepExpiredToolCallApprovals(new Date(Date.now() + approvals.APPROVED_CALL_SETTLE_MS + 60 * 1000));

    const stored = await ApprovalAction.findById(approvalId).lean();
    expect(stored).toMatchObject({ toolCallEnding: 'ran', toolCallTrailId: before.toolCallTrailId, expiryRetryCount: 1 });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(mockGithub.createIssue).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query(
      "SELECT outcome FROM tool_calls WHERE approval_id = $1 AND outcome <> 'pending_approval'",
      [approvalId],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['ok']);
  });

  // A GitHub write held open past the settle: the sweep ends it unknown, then
  // the real answer lands. Real trail, real record, real card row.
  const slowCall = async (title) => {
    const grant = await mint();
    const parked = await call(grant, 'github.create_issue', { title }).catch((error) => error);
    const approvalId = String(parked.details.approvalId);
    let finish;
    mockGithub.createIssue.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const deciding = approvals.resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
    for (let i = 0; i < 100 && !finish; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    await approvals.sweepExpiredToolCallApprovals(new Date(Date.now() + approvals.APPROVED_CALL_SETTLE_MS + 60 * 1000));
    return {
      grant, parked, approvalId, deciding, land: () => finish({ number: 1, title: 'x', html_url: 'https://github.com/octo/demo/issues/1' }),
    };
  };
  const receiptsFor = (approvalId) => AgentMessageService.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.metadata?.approvalId === approvalId && message.metadata?.source === 'approval-tool-call');

  it('a call that outlasts the settle: the row and card correct, the record and receipt stay, both trail rows count', async () => {
    AgentMessageService.postMessage.mockClear();
    const {
      grant, parked, approvalId, deciding, land,
    } = await slowCall('slow one');
    let stored = await ApprovalAction.findById(approvalId).lean();
    expect(stored).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'approval_outcome_unknown' });
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);

    land();
    const res = await deciding;
    expect(res.body.approval).toMatchObject({ toolCallEnding: 'ran' });
    stored = await ApprovalAction.findById(approvalId).lean();
    expect(stored).toMatchObject({ toolCallEnding: 'ran' });
    expect(stored.toolCallCode).toBeUndefined();
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(mockGithub.createIssue).toHaveBeenCalledTimes(1);

    // The receipt said what was known when it went out, and is not sent again.
    const receipts = receiptsFor(approvalId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].content).toContain('This call may have run. Check before approving it again.');

    // The chain is append-only: one update, carrying no status, never `failed`.
    const { lines } = await readPod();
    const updates = lines.filter((l) => l.kind === 'tool.update' && l.data.toolCallId === parked.details.callId);
    expect(updates).toHaveLength(1);
    expect(updates[0].data.status).toBeUndefined();
    expect(updates[0].data.title).toMatch(/outcome unknown/i);

    // The sweep's row and the broker's both stand, so the one call counts twice.
    const { rows } = await pool.query(
      "SELECT outcome, reason FROM tool_calls WHERE approval_id = $1 AND outcome <> 'pending_approval' ORDER BY occurred_at",
      [approvalId],
    );
    expect(rows.map((r) => r.outcome).sort()).toEqual(['failed', 'ok']);
    expect(rows.find((r) => r.outcome === 'failed').reason).toBe('approval_outcome_unknown');
    await expect(ToolCall.countsForGrant(grant.grantId)).resolves.toMatchObject({ ok: 1, failed: 1, total: 2 });
  });

  it('a closure failing after the sweep stamped the row is retried, and the unwritten ok row lands dated', async () => {
    const { approvalId, deciding, land } = await slowCall('slow two');
    const write = jest.spyOn(ToolCall, 'create')
      .mockRejectedValueOnce(new Error('trail store down')) // the broker's own row
      .mockRejectedValueOnce(new Error('trail store down')); // the approval's first try
    land();
    await deciding;
    write.mockRestore();
    let stored = await ApprovalAction.findById(approvalId).lean();
    expect(stored).toMatchObject({ toolCallEnding: 'ran' });
    expect(stored.toolCallTrailUnwritten).toMatchObject({ installationId: 'install-1' });
    expect(stored.expirySideEffectsDoneAt).toBeUndefined();

    await approvals.sweepExpiredToolCallApprovals(new Date(Date.now() + 3 * 60 * 60 * 1000));
    stored = await ApprovalAction.findById(approvalId).lean();
    expect(stored.expirySideEffectsDoneAt).toBeInstanceOf(Date);
    expect(stored.toolCallTrailUnwritten).toBeUndefined();
    const { rows } = await pool.query(
      "SELECT call_id, occurred_at, installation_id, duration_ms, pod_id FROM tool_calls WHERE approval_id = $1 AND outcome = 'ok'",
      [approvalId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ call_id: stored.toolCallTrailId, installation_id: 'install-1', pod_id: String(pod._id) });
    expect(Number(rows[0].duration_ms)).toBeGreaterThanOrEqual(0);
    expect(new Date(rows[0].occurred_at)).toEqual(stored.executedAt);
  });

  it('a write whose deadline fired ends unknown on the real trail and record; a pre-flight one stays failed', async () => {
    const decideWith = async (rejection, title) => {
      const grant = await mint();
      const parked = await call(grant, 'github.create_issue', { title }).catch((error) => error);
      const approvalId = String(parked.details.approvalId);
      mockGithub.createIssue.mockRejectedValueOnce(rejection);
      await approvals.resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
      const { rows } = await pool.query(
        "SELECT outcome, reason FROM tool_calls WHERE approval_id = $1 AND outcome <> 'pending_approval'",
        [approvalId],
      );
      const { lines } = await readPod();
      return {
        rows,
        row: await ApprovalAction.findById(approvalId).lean(),
        update: lines.filter((l) => l.kind === 'tool.update' && l.data.toolCallId === parked.details.callId).pop(),
      };
    };

    const sent = await decideWith(markWriteUnknown(new Error('timeout')), 'timed out write');
    expect(sent.row).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'approval_outcome_unknown' });
    expect(sent.rows).toEqual([{ outcome: 'failed', reason: 'approval_outcome_unknown' }]);
    expect(sent.update.data.status).toBeUndefined();
    expect(sent.update.data.title).toMatch(/outcome unknown/i);

    const unsent = await decideWith(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }), 'timed out preflight');
    expect(unsent.row).toMatchObject({ toolCallEnding: 'failed', toolCallCode: 'broker_error' });
    expect(unsent.update.data.status).toBe('failed');
  });

  it('findApprovedRun reads the resolved row of one approval, never the parked one or another approval', async () => {
    const grant = await mint();
    const parked = await call(grant, 'github.create_issue', { title: 'parked only' }).catch((error) => error);
    const approvalId = String(parked.details.approvalId);
    // Parked and undecided: only the pending_approval row exists.
    await expect(ToolCall.findApprovedRun(grant.grantId, approvalId)).resolves.toBeNull();
    await approvals.resolveApproval({ approvalId, callerUserId: String(owner._id), decision: 'approved' });
    const stored = await ApprovalAction.findById(approvalId).lean();
    await expect(ToolCall.findApprovedRun(grant.grantId, approvalId)).resolves.toEqual({
      callId: stored.toolCallTrailId, outcome: 'ok', reason: null, at: expect.any(Date),
    });
    await expect(ToolCall.findApprovedRun(grant.grantId, '507f1f77bcf86cd799439011')).resolves.toBeNull();
    await expect(ToolCall.findApprovedRun('another-grant', approvalId)).resolves.toBeNull();
  });

  it('the pod chain keeps the task route\'s gate: outsiders 404, admin non-members 403', async () => {
    await mint();
    await flushAll();
    const stamp = Date.now();
    const outsider = await User.create({ username: `out-${stamp}`, email: `out-${stamp}@test.com`, password: 'Password123!', verified: true });
    const admin = await User.create({ username: `adm-${stamp}`, email: `adm-${stamp}@test.com`, password: 'Password123!', verified: true, role: 'admin' });
    const get = (user) => request(app).get(`/api/pods/${pod._id}/record`).set('Authorization', `Bearer ${generateTestToken(user._id)}`);
    expect(await get(outsider)).toMatchObject({ status: 404, body: { error: 'record_not_found' } });
    expect(await get(admin)).toMatchObject({ status: 403, body: { error: 'record_requires_membership' } });
    expect((await get(owner)).headers['x-record-entries']).toBe('1');
  });

  it('a seat grant writes nothing to any chain, even with the record on everywhere', async () => {
    // With the pilot gate open, only the pod-target rule stands between a seat
    // grant and a chain keyed by the seat's id.
    process.env.RECORD_V1_PODS = '*';
    await roomGrants.createGrant({
      connectionId: 'install-1', installationId: 'install-1', brokerId: 'commonly-grant-broker',
      target: { kind: 'seat', id: String(agent._id) }, tools: ['github.close_issue'], writeMode: 'write',
      audience: [String(agent._id)], expiresAt: new Date(Date.now() + 86_400_000),
    });
    const seat = await RoomGrant.findOne({ 'target.kind': 'seat' });
    await call(seat, 'github.close_issue', { issueNumber: 7 }).catch(() => {});
    await flushAll();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM record_chains WHERE pod_id = ANY($1)', [[String(pod._id), String(agent._id)]]);
    expect(rows[0].n).toBe(0);
  });
});
