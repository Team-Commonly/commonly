jest.mock('../../../models/AgentEvent', () => ({
  create: jest.fn(),
  countDocuments: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../../../services/agentDigestFoldService', () => ({
  foldExpiredDigests: jest.fn().mockResolvedValue(0),
  readFoldedDigest: jest.fn().mockResolvedValue(null),
  settleFoldedDigest: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../models/AgentMemory', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn(),
}));

jest.mock('../../../services/agentMemoryService', () => ({
  buildMemoryDigestBundle: jest.fn(() => ({})),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
}));

jest.mock('../../../models/Integration', () => ({}));

jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(),
}));

const AgentEvent = require('../../../models/AgentEvent');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentIdentityService = require('../../../services/agentIdentityService');
const AgentEventService = require('../../../services/agentEventService');

describe('AgentEventService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentEvent.countDocuments.mockResolvedValue(1);
  });

  test('persists a decision.ruled outcome on the asking agent\'s external queue', async () => {
    AgentInstallation.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    const payload = {
      decisionId: 'decision-1',
      pick: 'Canary',
      ruledBy: { userId: 'human-1', username: 'Sam' },
      ruledAt: '2026-09-06T08:00:00.000Z',
      rulingMessageId: '901',
      podId: 'pod-1',
    };
    AgentEvent.create.mockResolvedValue({
      _id: 'event-1',
      agentName: 'openclaw',
      instanceId: 'wren',
      podId: 'pod-1',
      type: 'decision.ruled',
      payload,
      status: 'pending',
      attempts: 0,
    });

    await expect(AgentEventService.enqueue({
      agentName: 'openclaw', instanceId: 'wren', podId: 'pod-1', type: 'decision.ruled', payload,
    })).resolves.toMatchObject({ _id: 'event-1', type: 'decision.ruled', payload });

    expect(AgentEvent.create).toHaveBeenCalledWith({
      agentName: 'openclaw',
      instanceId: 'wren',
      podId: 'pod-1',
      type: 'decision.ruled',
      payload,
    });
  });

  test('list mutates pending → delivered, captures memoryRevisionAtDelivery, injects digest bundle, normalizes messageId', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    const { buildMemoryDigestBundle } = require('../../../services/agentMemoryService');

    AgentEvent.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: jest.fn().mockResolvedValue([{ _id: 'evt-1' }]),
          }),
        }),
      }),
    });

    AgentMemory.findOne.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue({
          revision: 7,
          lastSeenRevision: 5,
          sections: { /* shape-only */ },
        }),
      }),
    });

    buildMemoryDigestBundle.mockReturnValue({
      memoryRevision: 7,
      memoryDigest: [{ takeaway: 'a' }, { takeaway: 'b' }],
      cyclesDigest: [{ ts: new Date(), content: 'c' }],
      longTermDigest: 'durable',
    });

    AgentEvent.findOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'evt-1',
        agentName: 'openclaw',
        instanceId: 'liz',
        podId: 'pod-1',
        type: 'chat.mention',
        status: 'delivered',
        memoryRevisionAtDelivery: 7,
        payload: { messageId: 1800, content: 'hi' },
      }),
    });

    const events = await AgentEventService.list({
      agentName: 'openclaw',
      instanceId: 'liz',
      podId: 'pod-1',
      limit: 5,
    });

    // ADR-012 §3: claim mutates with the right shape — gated on status pending,
    // sets status: 'delivered' + memoryRevisionAtDelivery atomically.
    expect(AgentEvent.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'evt-1', status: 'pending' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'delivered',
          memoryRevisionAtDelivery: 7,
        }),
      }),
      { new: true },
    );

    expect(buildMemoryDigestBundle).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 7, lastSeenRevision: 5 }),
      5,
    );

    expect(events).toHaveLength(1);
    // ADR-012 §10.2: payload spreads digest bundle alongside existing fields.
    expect(events[0].payload).toEqual(expect.objectContaining({
      content: 'hi',
      messageId: '1800',
      memoryRevision: 7,
      memoryDigest: [{ takeaway: 'a' }, { takeaway: 'b' }],
      cyclesDigest: expect.any(Array),
      longTermDigest: 'durable',
    }));
  });

  test('list chooses one pod before claiming a batch, so a driver never receives mixed private context', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    const query = (rows) => ({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: jest.fn().mockResolvedValue(rows) }),
        }),
      }),
    });
    // The oldest row selects pod-a. The second query deliberately contains
    // only pod-a candidates even though the authenticated installation scope
    // covers pod-b too.
    AgentEvent.find
      .mockReturnValueOnce(query([{ _id: 'head', podId: 'pod-a' }]))
      .mockReturnValueOnce(query([{ _id: 'head' }, { _id: 'same-pod' }]))
      .mockReturnValueOnce(query([]));
    AgentEvent.countDocuments.mockResolvedValue(2);
    AgentMemory.findOne.mockReturnValue({
      select: () => ({ lean: jest.fn().mockResolvedValue({ revision: 1, lastSeenRevision: 0 }) }),
    });
    AgentEvent.findOneAndUpdate
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue({
          _id: 'head', agentName: 'inbox', instanceId: 'default', podId: 'pod-a',
          type: 'message.posted', payload: {}, status: 'delivered',
        }),
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue({
          _id: 'same-pod', agentName: 'inbox', instanceId: 'default', podId: 'pod-a',
          type: 'chat.mention', payload: {}, status: 'delivered',
        }),
      });

    const page = await AgentEventService.listInboxPage({
      agentName: 'inbox', instanceId: 'default', podIds: ['pod-a', 'pod-b'], limit: 10,
    });

    expect(AgentEvent.find).toHaveBeenNthCalledWith(1, expect.objectContaining({
      $and: expect.arrayContaining([
        expect.objectContaining({ podId: { $in: ['pod-a', 'pod-b'] } }),
        { podId: { $exists: true, $ne: null } },
        { deliveryMode: { $ne: 'digest' } },
      ]),
    }));
    expect(AgentEvent.find).toHaveBeenNthCalledWith(2, expect.objectContaining({ podId: 'pod-a' }));
    expect(page.inboxCount).toBe(2);
    expect(page.events.map((event) => event.podId)).toEqual(['pod-a', 'pod-a']);
  });

  test('listInboxPage excludes malformed no-pod rows when selecting its one-pod head', async () => {
    const query = (rows) => ({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: jest.fn().mockResolvedValue(rows) }),
        }),
      }),
    });
    AgentEvent.find.mockReturnValue(query([]));

    const page = await AgentEventService.listInboxPage({
      agentName: 'inbox', instanceId: 'default', podIds: ['pod-a', 'pod-b'], limit: 10,
    });

    expect(page).toEqual({ events: [], inboxCount: 0 });
    expect(AgentEvent.find).toHaveBeenCalledTimes(1);
    expect(AgentEvent.find).toHaveBeenCalledWith({
      $and: [
        {
          agentName: 'inbox',
          instanceId: 'default',
          status: 'pending',
          // F52: a native turn queued for the runner lease holder.
          inProcessQueued: { $ne: true },
          podId: { $in: ['pod-a', 'pod-b'] },
        },
        { podId: { $exists: true, $ne: null } },
        { deliveryMode: { $ne: 'digest' } },
      ],
    });
    expect(AgentEvent.countDocuments).not.toHaveBeenCalled();
    expect(AgentEvent.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('digest-only inbox stays pending; a later wake claims it in the same pod', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    const { readFoldedDigest } = require('../../../services/agentDigestFoldService');
    const query = (rows) => ({
      sort: () => ({ limit: () => ({ select: () => ({ lean: jest.fn().mockResolvedValue(rows) }) }) }),
    });
    AgentEvent.find.mockReturnValueOnce(query([]));
    expect(await AgentEventService.listInboxPage({ agentName: 'inbox', podId: 'pod-a' }))
      .toEqual({ events: [], inboxCount: 0 });
    expect(AgentEvent.findOneAndUpdate).not.toHaveBeenCalled();

    AgentEvent.find
      .mockReturnValueOnce(query([{ _id: 'wake', podId: 'pod-a' }]))
      .mockReturnValueOnce(query([{ _id: 'wake' }]))
      .mockReturnValueOnce(query([{ _id: 'digest' }]));
    AgentEvent.countDocuments.mockResolvedValue(2);
    AgentMemory.findOne.mockReturnValue({
      select: () => ({ lean: jest.fn().mockResolvedValue({ revision: 1, lastSeenRevision: 0 }) }),
    });
    AgentEvent.findOneAndUpdate
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({
        _id: 'wake', agentName: 'inbox', instanceId: 'default', podId: 'pod-a',
        type: 'chat.mention', status: 'delivered', payload: {},
      }) })
      .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({
        _id: 'digest', podId: 'pod-a', type: 'message.posted', deliveryMode: 'digest',
        status: 'delivered', payload: { messageId: '42' },
      }) });
    readFoldedDigest.mockResolvedValueOnce({ unreadCount: 3, lastEventIds: ['older-1'], revision: 4 });
    AgentEvent.updateOne
      .mockResolvedValueOnce({ modifiedCount: 1 }) // the wake's digest snapshot
      .mockResolvedValueOnce({ modifiedCount: 1 }); // the folded rollup it carries
    const page = await AgentEventService.listInboxPage({ agentName: 'inbox', podId: 'pod-a' });
    expect(page.events.map((event) => event._id)).toEqual(['wake', 'digest']);
    expect(page.inboxCount).toBe(2);
    // A wake that carried digest records when it read it, so its ack settles
    // the pod's backlog up to that moment.
    expect(AgentEvent.updateOne).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ _id: 'wake', status: 'delivered' }),
      { $set: { digestSnapshotAt: expect.any(Date) } });
    expect(page.events[0].digestSnapshotAt).toEqual(expect.any(Date));
    expect(page.events[0].payload.digestRollup).toEqual({ unreadCount: 3, lastEventIds: ['older-1'] });
    expect(page.events[1].payload.digestRollup).toBeUndefined();
    expect(AgentEvent.find).toHaveBeenNthCalledWith(3, expect.objectContaining({
      podId: 'pod-a', deliveryMode: { $ne: 'digest' },
    }));
    expect(AgentEvent.find).toHaveBeenNthCalledWith(4, expect.objectContaining({
      podId: 'pod-a', deliveryMode: 'digest',
    }));
  });

  test('a sibling winning the wake leaves its digest companion unclaimed', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    const query = (rows) => ({
      sort: () => ({ limit: () => ({ select: () => ({ lean: jest.fn().mockResolvedValue(rows) }) }) }),
    });
    AgentEvent.find
      .mockReturnValueOnce(query([{ _id: 'wake', podId: 'pod-a' }]))
      .mockReturnValueOnce(query([{ _id: 'wake' }]))
      .mockReturnValueOnce(query([{ _id: 'digest' }]));
    AgentMemory.findOne.mockReturnValue({
      select: () => ({ lean: jest.fn().mockResolvedValue({ revision: 1, lastSeenRevision: 0 }) }),
    });
    AgentEvent.findOneAndUpdate.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const page = await AgentEventService.listInboxPage({ agentName: 'inbox', podId: 'pod-a' });
    expect(page.events).toEqual([]);
    expect(AgentEvent.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('listInboxPage preserves its pre-claim count when a sibling wins every candidate', async () => {
    const query = (rows) => ({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: jest.fn().mockResolvedValue(rows) }),
        }),
      }),
    });
    AgentEvent.find
      .mockReturnValueOnce(query([{ _id: 'head', podId: 'pod-a' }]))
      .mockReturnValueOnce(query([]));
    AgentEvent.countDocuments.mockResolvedValue(3);

    const page = await AgentEventService.listInboxPage({
      agentName: 'inbox', instanceId: 'default', podIds: ['pod-a', 'pod-b'], limit: 10,
    });

    expect(page).toEqual({ events: [], inboxCount: 3 });
    expect(AgentEvent.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('legacy list preserves its cross-pod replay contract', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    const query = (rows) => ({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: jest.fn().mockResolvedValue(rows) }),
        }),
      }),
    });
    AgentEvent.find.mockReturnValue(query([{ _id: 'pod-a-event' }, { _id: 'pod-b-event' }]));
    AgentMemory.findOne.mockReturnValue({
      select: () => ({ lean: jest.fn().mockResolvedValue({ revision: 1, lastSeenRevision: 0 }) }),
    });
    AgentEvent.findOneAndUpdate
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue({
          _id: 'pod-a-event', agentName: 'inbox', instanceId: 'default', podId: 'pod-a',
          type: 'message.posted', payload: {}, status: 'delivered',
        }),
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue({
          _id: 'pod-b-event', agentName: 'inbox', instanceId: 'default', podId: 'pod-b',
          type: 'message.posted', payload: {}, status: 'delivered',
        }),
      });

    const events = await AgentEventService.list({
      agentName: 'inbox', instanceId: 'default', podIds: ['pod-a', 'pod-b'], limit: 10,
    });

    expect(AgentEvent.find).toHaveBeenCalledTimes(3);
    expect(AgentEvent.find).toHaveBeenNthCalledWith(1, expect.objectContaining({
      podId: { $in: ['pod-a', 'pod-b'] },
    }));
    expect(AgentEvent.find).toHaveBeenNthCalledWith(2, expect.objectContaining({
      podId: 'pod-a', deliveryMode: 'digest',
    }));
    expect(AgentEvent.find).toHaveBeenNthCalledWith(3, expect.objectContaining({
      podId: 'pod-b', deliveryMode: 'digest',
    }));
    expect(events.map((event) => event.podId)).toEqual(['pod-a', 'pod-b']);
  });

  test('list returns [] when no candidates are pending (no envelope read)', async () => {
    const AgentMemory = require('../../../models/AgentMemory');

    AgentEvent.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });

    const events = await AgentEventService.list({
      agentName: 'openclaw',
      instanceId: 'liz',
      podId: 'pod-1',
      limit: 5,
    });

    expect(events).toEqual([]);
    // No memory read should fire when there's nothing to claim.
    expect(AgentMemory.findOne).not.toHaveBeenCalled();
  });

  test('list: lost-race candidate produces null update; result is filtered out', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    const { buildMemoryDigestBundle } = require('../../../services/agentMemoryService');

    AgentEvent.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: jest.fn().mockResolvedValue([{ _id: 'won' }, { _id: 'lost' }]),
          }),
        }),
      }),
    });

    AgentMemory.findOne.mockReturnValue({
      select: () => ({
        lean: jest.fn().mockResolvedValue({ revision: 1, lastSeenRevision: 0, sections: {} }),
      }),
    });
    buildMemoryDigestBundle.mockReturnValue({});

    AgentEvent.findOneAndUpdate
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue({
          _id: 'won', agentName: 'a', instanceId: 'i', podId: 'p', type: 't', payload: {},
          status: 'delivered', memoryRevisionAtDelivery: 1,
        }),
      })
      .mockReturnValueOnce({
        // The losing candidate: another poller already flipped it; status-gate
        // returns null.
        lean: jest.fn().mockResolvedValue(null),
      });

    const events = await AgentEventService.list({
      agentName: 'a', instanceId: 'i', podId: 'p', limit: 5,
    });

    expect(events.map((e) => e._id)).toEqual(['won']);
  });

  test('acknowledge: status-gated delivered → acked + bumps lastSeenRevision via $max', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    const { settleFoldedDigest } = require('../../../services/agentDigestFoldService');
    AgentIdentityService.getAgentTypeConfig.mockReturnValue({ runtime: 'moltbot' });
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-1',
      agentName: 'pixel',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'heartbeat',
      payload: {},
      status: 'acked',
      attempts: 1,
      memoryRevisionAtDelivery: 7,
      digestRollupRevision: 4,
    });

    await AgentEventService.acknowledge('evt-1', 'pixel', 'default', { outcome: 'no_action' });

    expect(AgentEvent.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'evt-1',
        agentName: 'pixel',
        instanceId: 'default',
        status: { $in: ['pending', 'delivered'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'acked' }),
      }),
      { new: true },
    );

    expect(AgentMemory.updateOne).toHaveBeenCalledWith(
      { agentName: 'pixel', instanceId: 'default' },
      { $max: { lastSeenRevision: 7 } },
    );
    expect(settleFoldedDigest).toHaveBeenCalledWith(
      { agentName: 'pixel', instanceId: 'default', podId: 'pod-1' }, 4,
    );
  });

  test('acknowledge: dup ack returns null without bumping lastSeenRevision', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    AgentIdentityService.getAgentTypeConfig.mockReturnValue({ runtime: 'moltbot' });
    // findOneAndUpdate returns null because status was already 'acked'.
    AgentEvent.findOneAndUpdate.mockResolvedValue(null);

    const result = await AgentEventService.acknowledge('evt-1', 'pixel', 'default', { outcome: 'no_action' });

    expect(result).toBeNull();
    expect(AgentMemory.updateOne).not.toHaveBeenCalled();
  });

  test('acknowledge: skips bump when memoryRevisionAtDelivery is null/0', async () => {
    const AgentMemory = require('../../../models/AgentMemory');
    AgentIdentityService.getAgentTypeConfig.mockReturnValue({ runtime: 'moltbot' });
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'evt-2',
      agentName: 'pixel',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'heartbeat',
      payload: {},
      status: 'acked',
      attempts: 1,
      memoryRevisionAtDelivery: null,
    });

    await AgentEventService.acknowledge('evt-2', 'pixel', 'default', { outcome: 'no_action' });

    expect(AgentMemory.updateOne).not.toHaveBeenCalled();
  });
});
