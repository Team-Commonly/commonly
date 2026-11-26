/**
 * An agent card's acting Buttons (catalogue revision 3). A click opens a
 * decision on the card's message and rules it through chooseDecision, so the
 * agent wakes with the same `decision.ruled` turn a decision card sends. Only a
 * choice the stored card offers is accepted, and only from a person in the pod.
 */

const mockDecision = {
  create: jest.fn(), findById: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
};
jest.mock('../../../models/DecisionRequest', () => mockDecision);
const mockPod = { findById: jest.fn() };
jest.mock('../../../models/Pod', () => mockPod);
const mockUser = { findById: jest.fn(), find: jest.fn() };
jest.mock('../../../models/User', () => mockUser);
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn() }));
const mockPGMessage = { create: jest.fn(), findById: jest.fn() };
jest.mock('../../../models/pg/Message', () => mockPGMessage);
jest.mock('../../../models/pg/Pod', () => ({ findById: jest.fn(async () => ({ id: 'pod-1' })) }));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: jest.fn() }));
jest.mock('../../../services/messageAgentDeliveryService', () => ({ deliverMessageToAgents: jest.fn(async () => ({})) }));
const mockEnqueue = jest.fn();
jest.mock('../../../services/agentEventService', () => ({ enqueue: (...args) => mockEnqueue(...args) }));
const mockRecordDecision = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  recordDecision: (...args) => mockRecordDecision(...args),
  resolve: jest.fn(async () => undefined),
}));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => ({ to: () => ({ emit: jest.fn() }) })) }));
jest.mock('../../../services/threadRootResolver', () => ({ resolveThreadRoot: jest.fn(async () => 612) }));

const rev3 = require('../../../config/uiCardCatalogueRevision.rev3.json');
const { chooseCardButton, cardChoiceState } = require('../../../services/decisionRequestService');

const chain = (value) => ({ select: () => ({ lean: async () => value }) });
const sorted = (value) => ({ lean: async () => value, sort: () => ({ lean: async () => value }) });
const CARD_SOURCE = 'root = Card("Ship it?", [Text("PR #4358 is green."), '
  + 'Button("Ship", Action(@ToAssistant("Ship")), "primary"), Button("Hold", Action(@ToAssistant("Hold")))])';
const cardMessage = (overrides = {}) => ({
  id: '700', pod_id: 'pod-1', user_id: 'agent-user-1', message_type: 'card', thread_root_id: '612',
  content: 'Ship it?\nPR #4358 is green. Reply ship or hold.',
  payload: { ...rev3, kind: 'ui', v: 1, lang: 'openui@1', source: CARD_SOURCE },
  ...overrides,
});
const users = {
  'human-1': { _id: 'human-1', username: 'Sam', isBot: false },
  'outsider-1': { _id: 'outsider-1', username: 'Ola', isBot: false },
  'agent-user-1': { _id: 'agent-user-1', isBot: true, botMetadata: { agentName: 'Release-Agent', instanceId: 'seat-1' } },
};

describe('an agent card\'s acting Buttons', () => {
  let stored;
  beforeEach(() => {
    jest.clearAllMocks();
    stored = null;
    mockPGMessage.findById.mockImplementation(async (id) => (id === '700' ? cardMessage() : { id: '901', userId: { username: 'Sam' } }));
    mockPGMessage.create.mockResolvedValue({ id: '901' });
    mockUser.findById.mockImplementation((id) => chain(users[id] || null));
    mockPod.findById.mockImplementation(() => chain({ members: ['human-1', 'agent-user-1'], type: 'team' }));
    mockEnqueue.mockResolvedValue({ _id: 'event-1' });
    // The upsert opens the row once; the CAS claim and ruling then move it.
    mockDecision.findOneAndUpdate.mockImplementation(async (filter, update) => {
      if (update.$setOnInsert) {
        stored = stored || { _id: 'decision-1', createdAt: new Date(), ...update.$setOnInsert };
        return stored;
      }
      if (update.$set?.rulingLock) { stored = { ...stored, rulingLock: update.$set.rulingLock }; return stored; }
      if (update.$set?.status === 'ruled') { stored = { ...stored, ...update.$set }; return stored; }
      return null;
    });
    mockDecision.findOne.mockImplementation(() => sorted(stored));
    mockDecision.findById.mockImplementation(async () => stored);
  });

  test('a person\'s click opens a decision on the card and wakes its agent with the choice', async () => {
    const result = await chooseCardButton({ messageId: '700', callerUserId: 'human-1', value: 'Ship' });

    expect(result).toMatchObject({ status: 200, body: { ok: true, decision: { ruling: { value: 'Ship', by: 'Sam' } } } });
    expect(mockDecision.findOneAndUpdate.mock.calls[0][0]).toEqual({ cardMessageId: '700' });
    expect(mockDecision.findOne).toHaveBeenCalledWith({ cardMessageId: '700' });
    expect(mockDecision.findOneAndUpdate.mock.calls[0][1].$setOnInsert).toMatchObject({
      podId: 'pod-1', agentUserId: 'agent-user-1', agentName: 'release-agent', instanceId: 'seat-1',
      title: 'Ship it?', options: [{ label: 'Ship' }, { label: 'Hold' }], status: 'pending', messageId: '700', threadRootId: '612',
    });
    // The card is the ask: no attention item is queued for it.
    expect(mockRecordDecision).not.toHaveBeenCalled();
    expect(mockPGMessage.create).toHaveBeenCalledWith('pod-1', 'human-1', 'Ship', 'text', '700', null, 612);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'release-agent', instanceId: 'seat-1', podId: 'pod-1', type: 'decision.ruled',
      payload: expect.objectContaining({ decisionId: 'decision-1', pick: 'Ship', options: ['Ship', 'Hold'], pickIsOption: true }),
    }));
  });

  test('a second click sees the standing choice and wakes nobody again', async () => {
    await chooseCardButton({ messageId: '700', callerUserId: 'human-1', value: 'Ship' });
    mockEnqueue.mockClear();

    const again = await chooseCardButton({ messageId: '700', callerUserId: 'human-1', value: 'Hold' });

    expect(again).toMatchObject({ status: 409, body: { decision: { ruling: { value: 'Ship' } } } });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(await cardChoiceState({ messageId: '700', callerUserId: 'human-1' }))
      .toMatchObject({ status: 200, body: { decision: { ruling: { value: 'Ship', by: 'Sam' } } } });
  });

  test('a first click that loses the insert race rules the row the other click opened', async () => {
    stored = { _id: 'decision-other', createdAt: new Date(), status: 'pending', messageId: '700',
      cardMessageId: '700', podId: 'pod-1', agentUserId: 'agent-user-1', agentName: 'release-agent',
      instanceId: 'seat-1', title: 'Ship it?', options: [{ label: 'Ship' }, { label: 'Hold' }] };
    const upsert = mockDecision.findOneAndUpdate.getMockImplementation();
    mockDecision.findOneAndUpdate.mockImplementation(async (filter, update) => {
      if (update.$setOnInsert) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      return upsert(filter, update);
    });

    const result = await chooseCardButton({ messageId: '700', callerUserId: 'human-1', value: 'Ship' });

    expect(result).toMatchObject({ status: 200, body: { decision: { ruling: { value: 'Ship' } } } });
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ decisionId: 'decision-other' }),
    }));
  });

  test('an upsert error other than a duplicate key is not swallowed', async () => {
    mockDecision.findOneAndUpdate.mockRejectedValueOnce(new Error('connection reset'));
    await expect(chooseCardButton({ messageId: '700', callerUserId: 'human-1', value: 'Ship' })).rejects.toThrow('connection reset');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('a value the card does not offer is refused before anything is written', async () => {
    for (const value of ['ship', '', undefined]) {
      const result = await chooseCardButton({ messageId: '700', callerUserId: 'human-1', value });
      expect(result).toMatchObject({ status: 400, body: { code: 'not_a_card_choice' } });
    }
    expect(mockDecision.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test.each([
    ['a bot', 'agent-user-1', 403],
    ['someone outside the pod', 'outsider-1', 403],
    ['an unknown user', 'nobody', 403],
  ])('%s cannot choose, and nothing is written', async (_name, callerUserId, status) => {
    const result = await chooseCardButton({ messageId: '700', callerUserId, value: 'Ship' });
    expect(result.status).toBe(status);
    expect(mockDecision.findOneAndUpdate).not.toHaveBeenCalled();
    expect((await cardChoiceState({ messageId: '700', callerUserId })).status).toBe(status);
  });

  test.each([
    ['a plain text message', { message_type: 'text', payload: null }],
    ['a card with no acting buttons', { payload: { ...cardMessage().payload, source: 'root = Text("hi")' } }],
    ['a card that no longer validates', { payload: { ...cardMessage().payload, catalogHash: 'sha256:forged' } }],
    ['a card from a person', { user_id: 'human-1' }],
  ])('%s offers nothing to choose', async (_name, overrides) => {
    mockPGMessage.findById.mockResolvedValue(cardMessage(overrides));
    const result = await chooseCardButton({ messageId: '700', callerUserId: 'human-1', value: 'Ship' });
    expect(result.status).toBe(404);
    expect(mockDecision.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a message id that is not one is refused without a read', async () => {
    expect((await chooseCardButton({ messageId: '7a', callerUserId: 'human-1', value: 'Ship' })).status).toBe(404);
    expect(mockPGMessage.findById).not.toHaveBeenCalled();
  });
});
