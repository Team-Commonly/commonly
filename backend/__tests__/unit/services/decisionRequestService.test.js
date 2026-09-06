/**
 * Agent-authored decisions deliberately use normal chat replies as their
 * return transport. These tests pin the source provenance, exact value, and
 * the compare-and-set that prevents two browser tabs from waking the asker
 * with contradictory rulings.
 */

const mockDecision = {
  create: jest.fn(), findById: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
};
jest.mock('../../../models/DecisionRequest', () => mockDecision);

const mockPod = { findById: jest.fn() };
jest.mock('../../../models/Pod', () => mockPod);

const mockUser = { findById: jest.fn() };
jest.mock('../../../models/User', () => mockUser);

const mockPostMessage = jest.fn();
jest.mock('../../../services/agentMessageService', () => ({ postMessage: (...args) => mockPostMessage(...args) }));

const mockPGMessage = { create: jest.fn(), findById: jest.fn() };
jest.mock('../../../models/pg/Message', () => mockPGMessage);

const mockPGPod = { findById: jest.fn() };
jest.mock('../../../models/pg/Pod', () => mockPGPod);

const mockSyncPod = jest.fn();
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: (...args) => mockSyncPod(...args) }));

const mockDeliver = jest.fn();
jest.mock('../../../services/messageAgentDeliveryService', () => ({ deliverMessageToAgents: (...args) => mockDeliver(...args) }));

const mockEnqueue = jest.fn();
jest.mock('../../../services/agentEventService', () => ({ enqueue: (...args) => mockEnqueue(...args) }));

const mockRecordDecision = jest.fn();
const mockResolveAttention = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  recordDecision: (...args) => mockRecordDecision(...args),
  resolve: (...args) => mockResolveAttention(...args),
}));

const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => ({ to: mockTo })) }));

const mockResolveThreadRoot = jest.fn();
jest.mock('../../../services/threadRootResolver', () => ({ resolveThreadRoot: (...args) => mockResolveThreadRoot(...args) }));

const {
  requestDecision, chooseDecision, normalizeOptions, normalizeDecisionClass, DecisionRequestError,
} = require('../../../services/decisionRequestService');

const userChain = (user) => ({ select: () => ({ lean: async () => user }) });
const podChain = (pod) => ({ select: () => ({ lean: async () => pod }) });

const source = () => ({
  podId: 'pod-1', agentUserId: 'agent-user-1', agentName: 'release-agent', instanceId: 'seat-1',
  displayName: 'Release Agent', decisionClass: 'implementation', title: 'Choose the release train', question: 'Which rollout should I run?',
  options: [
    { label: 'Canary', description: 'Small cohort.', recommended: true },
    { label: 'Fast lane', description: 'Ship once green.' },
  ],
  threadRootId: '612', context: 'The branch is green.',
});

const pending = (overrides = {}) => ({
  _id: 'decision-1', podId: 'pod-1', agentUserId: 'agent-user-1', agentName: 'release-agent', instanceId: 'seat-1', decisionClass: 'implementation',
  title: 'Choose the release train', question: 'Which rollout should I run?',
  options: [{ label: 'Canary', recommended: true }, { label: 'Fast lane' }], status: 'pending',
  messageId: '700', threadRootId: '612', ...overrides,
});

describe('DecisionRequestService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPGPod.findById.mockResolvedValue({ id: 'pod-1' });
    mockSyncPod.mockResolvedValue({ id: 'pod-1' });
    mockPostMessage.mockResolvedValue({ success: true, message: { _id: '700' } });
    mockDecision.create.mockImplementation(async (row) => ({ ...row, _id: 'decision-1' }));
    mockResolveThreadRoot.mockResolvedValue(612);
    mockPGMessage.create.mockResolvedValue({ id: '901' });
    mockPGMessage.findById.mockResolvedValue({ id: '901', userId: { username: 'Sam' } });
    mockDeliver.mockResolvedValue({});
    mockEnqueue.mockResolvedValue({ _id: 'event-1' });
    mockRecordDecision.mockResolvedValue(undefined);
    mockResolveAttention.mockResolvedValue(undefined);
  });

  test('derives the asking agent from runtime input and posts a replyable source before queue visibility', async () => {
    const result = await requestDecision(source());

    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'release-agent', instanceId: 'seat-1', podId: 'pod-1', threadRootId: '612',
      metadata: { source: 'decision-request' },
    }));
    expect(mockPostMessage.mock.calls[0][0].content).toContain('Choose the release train');
    expect(mockDecision.create).toHaveBeenCalledWith(expect.objectContaining({
      agentUserId: 'agent-user-1', agentName: 'release-agent', instanceId: 'seat-1', decisionClass: 'implementation',
      messageId: '700', status: 'pending',
    }));
    expect(result).toEqual({ decisionId: 'decision-1', messageId: '700', threadRootId: '612', status: 'pending' });
  });

  test('rejects malformed choices before it writes the source message', async () => {
    await expect(requestDecision({ ...source(), options: [{ label: 'Only choice' }] }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_options' });
    await expect(requestDecision({ ...source(), options: [{ label: 'Same' }, { label: 'same' }] }))
      .rejects.toMatchObject({ status: 400, code: 'duplicate_options' });
    await expect(requestDecision({ ...source(), options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }))
      .rejects.toMatchObject({ status: 400, code: 'multiple_recommended' });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test('normalizes only a valid 2–4 option shape', () => {
    expect(normalizeOptions([{ label: 'A' }, { label: 'B', description: 'why' }]))
      .toEqual([{ label: 'A' }, { label: 'B', description: 'why' }]);
    expect(() => normalizeOptions(Array.from({ length: 5 }, (_, index) => ({ label: `Choice ${index}` }))))
      .toThrow(DecisionRequestError);
  });

  test('requires an advisory decision class and rejects consent-shaped classes', async () => {
    expect(normalizeDecisionClass('strategy')).toBe('strategy');
    expect(() => normalizeDecisionClass('approval')).toThrow(DecisionRequestError);
    await expect(requestDecision({ ...source(), decisionClass: 'credential_use' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_decision_class' });
  });

  test('one human member posts an exact threaded ruling and queues one typed wake for the asking agent', async () => {
    const row = pending();
    mockDecision.findById.mockResolvedValue(row);
    mockUser.findById.mockReturnValue(userChain({ _id: 'human-1', username: 'Sam', isBot: false }));
    mockPod.findById.mockImplementation(() => podChain({ createdBy: 'human-1', members: ['human-1'], type: 'team' }));
    mockDecision.findOneAndUpdate
      .mockResolvedValueOnce({ ...row, rulingLock: { token: 'lock' } })
      .mockResolvedValueOnce({
        ...row,
        status: 'ruled',
        ruling: {
          value: 'Hold for customer evidence',
          byUserId: 'human-1',
          byUsername: 'Sam',
          at: new Date('2026-09-06T08:00:00.000Z'),
          messageId: '901',
        },
      });

    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'human-1', value: 'Hold for customer evidence' });

    expect(result).toMatchObject({ status: 200, body: { ok: true, decision: { ruling: { value: 'Hold for customer evidence', by: 'Sam' } } } });
    expect(mockPGMessage.create).toHaveBeenCalledWith(
      'pod-1', 'human-1', 'Hold for customer evidence', 'text', '700', null, 612,
    );
    expect(mockResolveThreadRoot).toHaveBeenCalledWith({
      podId: 'pod-1', replyToMessageId: '700', threadRootId: '612',
    });
    expect(mockDeliver).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'pod-1', podType: 'team', userId: 'human-1', replyToMessageId: '700',
      suppressImplicitReply: true,
      suppressImplicitReplyTarget: { agentName: 'release-agent', instanceId: 'seat-1' },
    }));
    expect(mockTo).toHaveBeenCalledWith('pod_pod-1');
    expect(mockEmit).toHaveBeenCalledWith('newMessage', expect.objectContaining({
      pod_id: 'pod-1', replyTo: null,
    }));
    expect(mockDecision.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockDecision.findOneAndUpdate.mock.calls[1][1].$set.ruling.value)
      .toBe('Hold for customer evidence');
    expect(mockEnqueue).toHaveBeenCalledWith({
      agentName: 'release-agent',
      instanceId: 'seat-1',
      podId: 'pod-1',
      type: 'decision.ruled',
      payload: {
        decisionId: 'decision-1',
        pick: 'Hold for customer evidence',
        ruledBy: { userId: 'human-1', username: 'Sam' },
        ruledAt: '2026-09-06T08:00:00.000Z',
        rulingMessageId: '901',
        podId: 'pod-1',
      },
    });
    expect(mockEnqueue.mock.invocationCallOrder[0])
      .toBeGreaterThan(mockDecision.findOneAndUpdate.mock.invocationCallOrder[1]);
    expect(mockResolveAttention).toHaveBeenCalledWith('decision_request', 'decision-1');
  });

  test('falls back to the ordinary implicit-reply wake when the typed queue is unavailable', async () => {
    const row = pending();
    mockDecision.findById.mockResolvedValue(row);
    mockUser.findById.mockReturnValue(userChain({ _id: 'human-1', username: 'Sam', isBot: false }));
    mockPod.findById.mockImplementation(() => podChain({ createdBy: 'human-1', members: ['human-1'], type: 'team' }));
    mockDecision.findOneAndUpdate
      .mockResolvedValueOnce({ ...row, rulingLock: { token: 'lock' } })
      .mockResolvedValueOnce({
        ...row,
        status: 'ruled',
        ruling: {
          value: 'Canary', byUserId: 'human-1', byUsername: 'Sam',
          at: new Date('2026-09-06T08:00:00.000Z'), messageId: '901',
        },
      });
    mockEnqueue.mockRejectedValueOnce(new Error('queue unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(chooseDecision({ decisionId: 'decision-1', callerUserId: 'human-1', value: 'Canary' }))
      .resolves.toMatchObject({ status: 200, body: { ok: true } });

    expect(mockDeliver).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'pod-1', podType: 'team', userId: 'human-1', replyToMessageId: '700',
    }));
    expect(mockDeliver.mock.calls[0][0]).not.toHaveProperty('suppressImplicitReply');
    warn.mockRestore();
  });

  test('keeps the ordinary reply wake when finalization races after the visible reply', async () => {
    const row = pending();
    mockDecision.findById.mockResolvedValue(row);
    mockUser.findById.mockReturnValue(userChain({ _id: 'human-1', username: 'Sam', isBot: false }));
    mockPod.findById.mockImplementation(() => podChain({ createdBy: 'human-1', members: ['human-1'], type: 'team' }));
    mockDecision.findOneAndUpdate
      .mockResolvedValueOnce({ ...row, rulingLock: { token: 'lock' } })
      .mockResolvedValueOnce(null);

    await expect(chooseDecision({ decisionId: 'decision-1', callerUserId: 'human-1', value: 'Canary' }))
      .rejects.toMatchObject({ status: 409, code: 'ruling_finalize_conflict' });

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockDeliver).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'pod-1', podType: 'team', userId: 'human-1', replyToMessageId: '700',
    }));
    expect(mockDeliver.mock.calls[0][0]).not.toHaveProperty('suppressImplicitReply');
  });

  test('a second tab sees the standing ruling and cannot create another wake', async () => {
    const ruled = pending({ status: 'ruled', ruling: { value: 'Canary', byUsername: 'Sam', at: new Date(), messageId: '901' } });
    mockDecision.findById.mockResolvedValue(ruled);
    const result = await chooseDecision({ decisionId: 'decision-1', callerUserId: 'human-2', value: 'Fast lane' });
    expect(result).toMatchObject({ status: 409, body: { decision: { ruling: { value: 'Canary', by: 'Sam' } } } });
    expect(mockPGMessage.create).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('refuses a bot caller before it reads pod membership or claims the decision', async () => {
    mockDecision.findById.mockResolvedValue(pending());
    mockUser.findById.mockReturnValue(userChain({ _id: 'bot-1', username: 'bot', isBot: true }));
    await expect(chooseDecision({ decisionId: 'decision-1', callerUserId: 'bot-1', value: 'Canary' }))
      .resolves.toEqual({ status: 403, body: { error: 'Only a human can rule on this decision' } });
    expect(mockPod.findById).not.toHaveBeenCalled();
    expect(mockDecision.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('refuses a non-member caller before claiming the decision', async () => {
    mockDecision.findById.mockResolvedValue(pending());
    mockUser.findById.mockReturnValue(userChain({ _id: 'stranger', username: 'Stranger', isBot: false }));
    mockPod.findById.mockReturnValue(podChain({ createdBy: 'owner', members: ['member'], type: 'team' }));
    await expect(chooseDecision({ decisionId: 'decision-1', callerUserId: 'stranger', value: 'Canary' }))
      .resolves.toEqual({ status: 403, body: { error: 'Only human pod members can rule on this decision' } });
    expect(mockDecision.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
