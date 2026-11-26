/**
 * ADR-037 §2: the four general decision-card extensions and the subject link,
 * enforced inside chooseDecision so every ruling path gets them: allowed
 * values, a required reason, deciderFallback 'none', the closed status, and a
 * stage check registered per subject type that fails closed when missing.
 */

const mockDecision = {
  create: jest.fn(), findById: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
};
jest.mock('../../../models/DecisionRequest', () => mockDecision);
const mockPod = { findById: jest.fn() };
jest.mock('../../../models/Pod', () => mockPod);
const mockUser = { findById: jest.fn(), find: jest.fn() };
jest.mock('../../../models/User', () => mockUser);
const mockPostMessage = jest.fn();
jest.mock('../../../services/agentMessageService', () => ({ postMessage: (...args) => mockPostMessage(...args) }));
const mockPGMessage = { create: jest.fn(), findById: jest.fn() };
jest.mock('../../../models/pg/Message', () => mockPGMessage);
jest.mock('../../../models/pg/Pod', () => ({ findById: jest.fn(async () => ({ id: 'pod-1' })) }));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: jest.fn() }));
jest.mock('../../../services/messageAgentDeliveryService', () => ({ deliverMessageToAgents: jest.fn(async () => ({})) }));
const mockEnqueue = jest.fn();
jest.mock('../../../services/agentEventService', () => ({ enqueue: (...args) => mockEnqueue(...args) }));
const mockResolveAttention = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  recordDecision: jest.fn(),
  resolve: (...args) => mockResolveAttention(...args),
}));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));
jest.mock('../../../services/threadRootResolver', () => ({ resolveThreadRoot: jest.fn(async () => 612) }));

const {
  chooseDecision, closeDecision, claimRulingLock, requestDecision,
} = require('../../../services/decisionRequestService');
const { registerDecisionSubject, unregisterDecisionSubject } = require('../../../services/decisionSubjectRegistry');

const userChain = (user) => ({ select: () => ({ lean: async () => user }) });
const podChain = (pod) => ({ select: () => ({ lean: async () => pod }) });

const card = (overrides = {}) => ({
  _id: 'decision-1', podId: 'pod-1', agentUserId: 'agent-1', agentName: 'kai', instanceId: 'default',
  decisionClass: 'implementation', title: 'Review the plan', question: 'Plan text',
  options: [{ label: 'Accept' }, { label: 'Refuse' }], status: 'pending', messageId: '700', threadRootId: '612',
  deciders: [{ userId: 'lee', username: 'lee' }], deciderFallback: 'none',
  allowedValues: [{ value: 'Accept', reasonRequired: true }, { value: 'Refuse', reasonRequired: true }],
  ...overrides,
});

const ruledAs = (row, value, reason) => ({
  ...row,
  status: 'ruled',
  ruling: {
    value, reason, byUserId: 'lee', byUsername: 'lee', at: new Date('2026-11-26T08:00:00.000Z'), messageId: '901',
  },
});

describe('decision-card extensions (ADR-037 §2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser.findById.mockReturnValue(userChain({ _id: 'lee', username: 'lee', isBot: false }));
    mockPod.findById.mockImplementation(() => podChain({ members: ['lee', 'sam'], type: 'team' }));
    mockPGMessage.create.mockResolvedValue({ id: '901' });
    mockPGMessage.findById.mockResolvedValue({ id: '901' });
    mockEnqueue.mockResolvedValue({});
    mockResolveAttention.mockResolvedValue(undefined);
  });
  afterEach(() => unregisterDecisionSubject('test_subject'));

  test('a value outside allowedValues is refused with value_not_allowed, before any write', async () => {
    mockDecision.findById.mockResolvedValue(card());
    const result = await chooseDecision({
      decisionId: 'decision-1', callerUserId: 'lee', value: 'Maybe later', reason: 'why not',
    });
    expect(result).toMatchObject({ status: 400, body: { code: 'value_not_allowed', allowedValues: ['Accept', 'Refuse'] } });
    expect(mockDecision.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockPGMessage.create).not.toHaveBeenCalled();
  });

  test.each([[undefined], [''], ['   ']])('a missing or empty reason (%p) is refused with reason_required', async (reason) => {
    mockDecision.findById.mockResolvedValue(card());
    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'lee', value: 'Accept', reason });
    expect(result).toMatchObject({ status: 400, body: { code: 'reason_required' } });
    expect(mockDecision.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockPGMessage.create).not.toHaveBeenCalled();
  });

  test('an allowed value with its reason is ruled: the reason is stored, posted and sent on decision.ruled', async () => {
    const row = card();
    mockDecision.findById.mockResolvedValue(row);
    mockDecision.findOneAndUpdate
      .mockResolvedValueOnce({ ...row, rulingLock: { token: 't' } })
      .mockResolvedValueOnce(ruledAs(row, 'Accept', 'Plan covers the migration'));

    const result = await chooseDecision({
      decisionId: 'decision-1', callerUserId: 'lee', value: 'accept', reason: '  Plan covers the migration ',
    });
    expect(result.status).toBe(200);
    expect(result.body.decision.ruling).toMatchObject({ value: 'Accept', reason: 'Plan covers the migration' });
    // The canonical value is stored, with the trimmed reason.
    expect(mockDecision.findOneAndUpdate.mock.calls[1][1].$set.ruling).toMatchObject({
      value: 'Accept', reason: 'Plan covers the migration',
    });
    expect(mockPGMessage.create.mock.calls[0][2]).toBe('Accept: Plan covers the migration');
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: 'decision.ruled',
      payload: expect.objectContaining({ pick: 'Accept', reason: 'Plan covers the migration' }),
    }));
  });

  test("deciderFallback 'none': once the named decider leaves, nobody else may rule", async () => {
    mockDecision.findById.mockResolvedValue(card());
    // lee left; sam, a member who could rule a default card, is refused.
    mockPod.findById.mockImplementation(() => podChain({ members: ['sam'], type: 'team' }));
    mockUser.findById.mockReturnValue(userChain({ _id: 'sam', username: 'sam', isBot: false }));
    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'sam', value: 'Accept', reason: 'ok' });
    expect(result).toMatchObject({ status: 403, body: { code: 'not_a_decider' } });

    // The default fallback still lets any member rule a card whose deciders left.
    const row = card({ deciderFallback: undefined, allowedValues: undefined });
    mockDecision.findById.mockResolvedValue(row);
    mockDecision.findOneAndUpdate
      .mockResolvedValueOnce({ ...row, rulingLock: { token: 't' } })
      .mockResolvedValueOnce(ruledAs(row, 'Accept'));
    expect((await chooseDecision({ decisionId: 'decision-1', callerUserId: 'sam', value: 'Accept' })).status).toBe(200);
  });

  test('a closed card is refused with 409 decision_closed', async () => {
    mockDecision.findById.mockResolvedValue(card({ status: 'closed' }));
    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'lee', value: 'Accept', reason: 'ok' });
    expect(result).toMatchObject({ status: 409, body: { code: 'decision_closed' } });
    expect(mockDecision.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a card closed while its lock was being taken is refused decision_closed, not "being ruled"', async () => {
    mockDecision.findById
      .mockResolvedValueOnce(card())
      .mockResolvedValueOnce(card({ status: 'closed' }));
    mockDecision.findOneAndUpdate.mockResolvedValueOnce(null);
    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'lee', value: 'Accept', reason: 'ok' });
    expect(result).toMatchObject({ status: 409, body: { code: 'decision_closed' } });
  });

  test('a subject type with no registered check fails closed with subject_check_missing', async () => {
    mockDecision.findById.mockResolvedValue(card({ subject: { type: 'unregistered_kind', id: 'x', stage: 'plan' } }));
    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'lee', value: 'Accept', reason: 'ok' });
    expect(result).toMatchObject({ status: 409, body: { code: 'subject_check_missing' } });
    expect(mockDecision.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockPGMessage.create).not.toHaveBeenCalled();
  });

  test('a registered check that says the subject moved on refuses subject_stage_mismatch', async () => {
    const checkStage = jest.fn(async () => false);
    registerDecisionSubject('test_subject', { checkStage });
    mockDecision.findById.mockResolvedValue(card({ subject: { type: 'test_subject', id: 'r1', stage: 'plan' } }));
    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'lee', value: 'Accept', reason: 'ok' });
    expect(result).toMatchObject({ status: 409, body: { code: 'subject_stage_mismatch' } });
    expect(checkStage).toHaveBeenCalled();
    expect(mockPGMessage.create).not.toHaveBeenCalled();
  });

  test('a check that throws counts as a mismatch, and one that flips under the lock releases it', async () => {
    registerDecisionSubject('test_subject', { checkStage: jest.fn(async () => { throw new Error('pg down'); }) });
    const row = card({ subject: { type: 'test_subject', id: 'r1', stage: 'plan' } });
    mockDecision.findById.mockResolvedValue(row);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await chooseDecision({ decisionId: 'decision-1', callerUserId: 'lee', value: 'Accept', reason: 'ok' })).body.code)
      .toBe('subject_stage_mismatch');

    const flips = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    registerDecisionSubject('test_subject', { checkStage: flips });
    mockDecision.findOneAndUpdate.mockResolvedValueOnce({ ...row, rulingLock: { token: 't' } });
    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'lee', value: 'Accept', reason: 'ok' });
    expect(result.body.code).toBe('subject_stage_mismatch');
    expect(mockPGMessage.create).not.toHaveBeenCalled();
    expect(mockDecision.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'decision-1', status: 'pending' }),
      { $unset: { rulingLock: 1 } },
    );
  });

  test('the on-ruled hook runs after the ruling is final, and adds to decision.ruled without overriding it', async () => {
    const onRuled = jest.fn(async () => ({ handBack: { id: 'r1', status: 'plan_accepted' }, pick: 'forged' }));
    registerDecisionSubject('test_subject', { checkStage: async () => true, onRuled });
    const row = card({ subject: { type: 'test_subject', id: 'r1', stage: 'plan' } });
    mockDecision.findById.mockResolvedValue(row);
    mockDecision.findOneAndUpdate
      .mockResolvedValueOnce({ ...row, rulingLock: { token: 't' } })
      .mockResolvedValueOnce(ruledAs(row, 'Accept', 'fine'));
    await chooseDecision({ decisionId: 'decision-1', callerUserId: 'lee', value: 'Accept', reason: 'fine' });
    expect(onRuled).toHaveBeenCalledWith(expect.objectContaining({ status: 'ruled' }));
    const { payload } = mockEnqueue.mock.calls[0][0];
    expect(payload).toMatchObject({ pick: 'Accept', reason: 'fine', handBack: { id: 'r1', status: 'plan_accepted' } });
  });

  test('a failing on-ruled hook never undoes the ruling', async () => {
    registerDecisionSubject('test_subject', {
      checkStage: async () => true, onRuled: async () => { throw new Error('pg down'); },
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const row = card({ subject: { type: 'test_subject', id: 'r1', stage: 'plan' } });
    mockDecision.findById.mockResolvedValue(row);
    mockDecision.findOneAndUpdate
      .mockResolvedValueOnce({ ...row, rulingLock: { token: 't' } })
      .mockResolvedValueOnce(ruledAs(row, 'Accept', 'fine'));
    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'lee', value: 'Accept', reason: 'fine' });
    expect(result.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  test('closeDecision closes only a pending card and resolves its attention', async () => {
    mockDecision.findOneAndUpdate.mockResolvedValueOnce({ _id: 'decision-1', status: 'closed' });
    await expect(closeDecision('decision-1')).resolves.toBe(true);
    expect(mockDecision.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'decision-1', status: 'pending' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'closed' }) }),
      { new: true },
    );
    expect(mockResolveAttention).toHaveBeenCalledWith('decision_request', 'decision-1');
    mockDecision.findOneAndUpdate.mockResolvedValueOnce(null);
    await expect(closeDecision('decision-1')).resolves.toBe(false);
  });

  // Review note 3: a ruling holding a live lock is mid-post; closing under it
  // would strand a posted ruling reply on a closed card.
  test('closeDecision leaves a card whose ruling lock is live, and takes one whose lock expired', async () => {
    mockDecision.findOneAndUpdate.mockResolvedValueOnce(null);
    await closeDecision('decision-1');
    const [filter] = mockDecision.findOneAndUpdate.mock.calls[0];
    expect(filter.$or).toEqual([
      { rulingLock: { $exists: false } },
      { 'rulingLock.expiresAt': { $lt: expect.any(Date) } },
    ]);
    expect(mockResolveAttention).not.toHaveBeenCalled();
  });

  test('closeDecision with a lock token closes only under that token', async () => {
    mockDecision.findOneAndUpdate.mockResolvedValueOnce({ _id: 'decision-1', status: 'closed' });
    await expect(closeDecision('decision-1', { lockToken: 'withdraw-token' })).resolves.toBe(true);
    const [filter, update] = mockDecision.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'decision-1', status: 'pending', 'rulingLock.token': 'withdraw-token' });
    expect(update).toMatchObject({ $set: { status: 'closed' }, $unset: { rulingLock: 1 } });
    expect(mockResolveAttention).toHaveBeenCalledWith('decision_request', 'decision-1');
  });

  test('claimRulingLock takes the same claim a ruling takes, and says why when it cannot', async () => {
    mockDecision.findOneAndUpdate.mockResolvedValueOnce({ _id: 'decision-1' });
    const claimed = await claimRulingLock('decision-1');
    expect(claimed.token).toEqual(expect.any(String));
    const [filter, update] = mockDecision.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: 'decision-1', status: 'pending' });
    expect(filter.$or).toEqual([
      { rulingLock: { $exists: false } },
      { 'rulingLock.expiresAt': { $lt: expect.any(Date) } },
    ]);
    expect(update.$set.rulingLock).toMatchObject({ token: claimed.token, expiresAt: expect.any(Date) });
    const leanChain = (row) => ({ select: () => ({ lean: async () => row }) });
    for (const [row, state] of [
      [{ status: 'ruled' }, 'ruled'], [{ status: 'closed' }, 'closed'], [{ status: 'pending' }, 'locked'], [null, 'missing'],
    ]) {
      mockDecision.findOneAndUpdate.mockResolvedValueOnce(null);
      mockDecision.findById.mockReturnValueOnce(leanChain(row));
      await expect(claimRulingLock('decision-1')).resolves.toEqual({ state });
    }
  });

  test('requestDecision stores the internal extensions and keeps the kernel source label', async () => {
    mockPostMessage.mockResolvedValue({ success: true, message: { _id: '700' } });
    mockUser.find.mockReturnValue(userChain([{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'lee', isBot: false }]));
    mockPod.findById.mockImplementation(() => podChain({ members: ['aaaaaaaaaaaaaaaaaaaaaaaa'], type: 'team' }));
    mockDecision.create.mockImplementation(async (row) => ({ ...row, _id: 'decision-1' }));
    await requestDecision({
      podId: 'pod-1', agentUserId: 'agent-1', agentName: 'kai', decisionClass: 'implementation',
      title: 'Plan review', question: 'Plan', options: [{ label: 'Accept' }, { label: 'Refuse' }],
      deciderUserIds: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
      internal: {
        allowedValues: [{ value: 'Accept', reasonRequired: true }, { value: 'Refuse', reasonRequired: true }],
        deciderFallback: 'none',
        subject: { type: 'hand_back', id: 'r1', stage: 'plan' },
        metadata: { kind: 'hand-back', handBackId: 'r1', source: 'forged' },
      },
    });
    expect(mockPostMessage.mock.calls[0][0].metadata).toEqual({
      kind: 'hand-back', handBackId: 'r1', source: 'decision-request',
    });
    expect(mockDecision.create).toHaveBeenCalledWith(expect.objectContaining({
      deciderFallback: 'none',
      subject: { type: 'hand_back', id: 'r1', stage: 'plan' },
      allowedValues: [{ value: 'Accept', reasonRequired: true }, { value: 'Refuse', reasonRequired: true }],
    }));
  });
});
