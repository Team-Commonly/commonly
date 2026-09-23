/**
 * Claim-decline recovery is intentionally a service boundary: it joins the
 * PostgreSQL claim row to the original Mongo delivery cohort. A claim-only
 * unit test cannot prove that a decline reaches exactly one other seat.
 */

const mockEventFind = jest.fn();
jest.mock('../../../models/AgentEvent', () => ({ find: (...args) => mockEventFind(...args) }));

const mockInstallationFindOne = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: (...args) => mockInstallationFindOne(...args) },
}));

const mockEnqueue = jest.fn();
jest.mock('../../../services/agentEventService', () => ({ enqueue: (...args) => mockEnqueue(...args) }));

const mockRelease = jest.fn();
jest.mock('../../../services/messageClaimService', () => ({ release: (...args) => mockRelease(...args) }));

const { release, enqueueNextDeclineHandoff } = require('../../../services/messageClaimHandoffService');

const sourceEvent = (agentName, instanceId = 'default', payload = {}) => ({
  agentName,
  instanceId,
  payload: {
    messageId: 'message-1',
    content: `wake for ${agentName}`,
    wakeOnMessage: true,
    senderIsHuman: true,
    ...payload,
  },
});

const sourceEvents = (events) => {
  const lean = jest.fn().mockResolvedValue(events);
  const sort = jest.fn().mockReturnValue({ lean });
  mockEventFind.mockReturnValue({ sort });
  return { sort, lean };
};

const activeInstallation = (value = { _id: 'install-1' }) => ({
  lean: jest.fn().mockResolvedValue(value),
});

describe('messageClaimHandoffService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnqueue.mockResolvedValue({ _id: 'new-event' });
  });

  test('a human decline re-offers the original payload to exactly one next, active seat', async () => {
    sourceEvents([
      sourceEvent('seat-a'),
      sourceEvent('seat-b'),
      sourceEvent('seat-c'),
    ]);
    mockInstallationFindOne.mockReturnValue(activeInstallation());
    mockRelease.mockResolvedValue({
      released: true,
      podId: 'pod-1',
      state: 'declined',
      declinedBy: ['seat-a:default'],
    });

    const result = await release({
      messageId: 'message-1', agentName: 'seat-a', outcome: 'declined',
    });

    expect(mockEventFind).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'pod-1',
      type: 'message.posted',
      'payload.messageId': 'message-1',
      'payload.wakeOnMessage': true,
      'payload.senderIsHuman': true,
      'payload.claimHandoff': { $exists: false },
    }));
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'seat-b',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'message.posted',
      payload: expect.objectContaining({
        content: 'wake for seat-b',
        senderIsHuman: true,
        claimHandoff: { attempt: 1 },
      }),
    }));
    expect(result).toMatchObject({ handoff: { queued: true, agentName: 'seat-b' } });
  });

  test('a refusal re-offers the human wake to the next seat, exactly like a decline', async () => {
    // TASK-099's kernel half (corrected ruling 71194/71195/71210). The refuser
    // is in `declinedBy`, which is what keeps the chain finite — without it the
    // handoff would hand the message straight back to the seat whose route just
    // refused it.
    sourceEvents([sourceEvent('seat-a'), sourceEvent('seat-b')]);
    mockInstallationFindOne.mockReturnValue(activeInstallation());
    mockRelease.mockResolvedValue({
      released: true,
      podId: 'pod-1',
      state: 'refused',
      reason: 'upstream-refused',
      status: 429,
      declinedBy: ['seat-a:default'],
    });

    const result = await release({
      messageId: 'message-1', agentName: 'seat-a', outcome: 'refused',
      reason: 'upstream-refused', status: 429,
    });

    expect(mockRelease).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'refused', reason: 'upstream-refused', status: 429,
    }));
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'seat-b' }));
    expect(result).toMatchObject({ handoff: { queued: true, agentName: 'seat-b' } });
  });

  test('a refusal on an agent-authored wake queues nothing — terminal by that fact alone', async () => {
    // The routing predicate IS the source-event filter (`senderIsHuman: true`),
    // not a second copy of "is this a human wake" in the route. An agent wake
    // finds no source events, so the refusal closes and nothing is fanned out.
    sourceEvents([]);
    mockRelease.mockResolvedValue({
      released: true,
      podId: 'pod-1',
      state: 'refused',
      reason: 'delivery-refused',
      declinedBy: ['seat-a:default'],
    });

    const result = await release({
      messageId: 'message-1', agentName: 'seat-a', outcome: 'refused', reason: 'delivery-refused',
    });

    // The query is where "human wake" is decided, for a refusal as much as for
    // a decline: one definition, in the place that holds the evidence.
    expect(mockEventFind).toHaveBeenCalledWith(expect.objectContaining({
      'payload.senderIsHuman': true,
      'payload.wakeOnMessage': true,
    }));
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ handoff: { queued: false, reason: 'no_remaining_wake_target' } });
  });

  test('a completion is still terminal: no handoff lookup at all', async () => {
    sourceEvents([sourceEvent('seat-b')]);
    mockRelease.mockResolvedValue({ released: true, podId: 'pod-1' });

    const result = await release({
      messageId: 'message-1', agentName: 'seat-a', outcome: 'completed',
    });

    expect(mockEventFind).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ released: true, podId: 'pod-1' });
  });

  test('five prior declines exhaust their original five-seat cohort instead of looping', async () => {
    sourceEvents([
      sourceEvent('seat-a'), sourceEvent('seat-b'), sourceEvent('seat-c'),
      sourceEvent('seat-d'), sourceEvent('seat-e'),
    ]);

    const result = await enqueueNextDeclineHandoff({
      messageId: 'message-1',
      podId: 'pod-1',
      declinedBy: [
        'seat-a:default', 'seat-b:default', 'seat-c:default',
        'seat-d:default', 'seat-e:default',
      ],
    });

    expect(result).toEqual({ queued: false, reason: 'no_remaining_wake_target' });
    expect(mockInstallationFindOne).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('preserves instance-id casing when excluding a prior decliner', async () => {
    sourceEvents([sourceEvent('seat-a', 'Blue'), sourceEvent('seat-b', 'default')]);
    mockInstallationFindOne.mockReturnValue(activeInstallation());

    const result = await enqueueNextDeclineHandoff({
      messageId: 'message-1', podId: 'pod-1', declinedBy: ['seat-a:Blue'],
    });

    expect(result).toMatchObject({ queued: true, agentName: 'seat-b' });
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'seat-b', instanceId: 'default',
    }));
  });

  test('an inactive or wake-disabled original target is skipped rather than revived', async () => {
    sourceEvents([sourceEvent('seat-a'), sourceEvent('seat-b'), sourceEvent('seat-c')]);
    mockInstallationFindOne
      .mockReturnValueOnce(activeInstallation(null))
      .mockReturnValueOnce(activeInstallation({ _id: 'install-c' }));

    const result = await enqueueNextDeclineHandoff({
      messageId: 'message-1', podId: 'pod-1', declinedBy: ['seat-a:default'],
    });

    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'seat-c' }));
    expect(result).toMatchObject({ queued: true, agentName: 'seat-c' });
  });

  test('bot and pre-stamp wake events are never selected for a human decline', async () => {
    sourceEvents([]);

    const result = await enqueueNextDeclineHandoff({
      messageId: 'message-1', podId: 'pod-1', declinedBy: ['seat-a:default'],
    });

    expect(result).toEqual({ queued: false, reason: 'no_remaining_wake_target' });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
