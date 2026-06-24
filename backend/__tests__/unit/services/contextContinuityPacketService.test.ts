// @ts-nocheck

const {
  CONTEXT_CONTINUITY_PACKET_SCHEMA,
  buildContextContinuityPacket,
  memorySectionsFromDigestBundle,
} = require('../../../services/contextContinuityPacketService');

describe('contextContinuityPacketService', () => {
  it('builds the stable commonly.ccp.v1 envelope', () => {
    const packet = buildContextContinuityPacket({
      event: {
        _id: 'evt-1',
        type: 'chat.mention',
        agentName: 'OpenClaw',
        instanceId: 'liz',
        podId: 'pod-1',
        createdAt: new Date('2026-06-24T00:00:00Z'),
        deliveredAt: new Date('2026-06-24T00:00:03Z'),
        payload: { trigger: 'mention', messageId: 42 },
      },
      memoryRevision: 7,
      memoryRevisionAtDelivery: 7,
      lastSeenRevision: 5,
      memorySections: ['system_exchanges'],
    });

    expect(packet).toEqual({
      schema: CONTEXT_CONTINUITY_PACKET_SCHEMA,
      contextId: 'cap-event:evt-1',
      owner: {
        agentName: 'openclaw',
        instanceId: 'liz',
        podId: 'pod-1',
      },
      provenance: {
        source: 'cap.event',
        eventId: 'evt-1',
        eventType: 'chat.mention',
        trigger: 'mention',
        createdAt: '2026-06-24T00:00:00.000Z',
        deliveredAt: '2026-06-24T00:00:03.000Z',
      },
      freshness: {
        memoryRevision: 7,
        memoryRevisionAtDelivery: 7,
        lastSeenRevision: 5,
        status: 'stale',
      },
      refs: {
        messageId: '42',
        memorySections: ['system_exchanges'],
      },
    });
  });

  it('extracts safe payload refs without copying content or memory bodies', () => {
    const packet = buildContextContinuityPacket({
      event: {
        _id: 'evt-2',
        type: 'agent.ask',
        agentName: 'codex',
        instanceId: 'default',
        podId: 'pod-2',
        payload: {
          content: 'do not copy me',
          longTermDigest: 'do not copy memory',
          memoryDigest: [{ takeaway: 'do not copy digest entry' }],
          requestId: 'ask-1',
          taskId: 'task-1',
          threadId: 'thread-1',
          replyToMessageId: 'msg-parent',
          summaryId: 'sum-1',
          integrationId: 'int-1',
        },
      },
    });

    expect(packet.refs).toEqual({
      replyToMessageId: 'msg-parent',
      threadId: 'thread-1',
      taskId: 'task-1',
      requestId: 'ask-1',
      summaryId: 'sum-1',
      integrationId: 'int-1',
    });
    expect(JSON.stringify(packet)).not.toContain('do not copy me');
    expect(JSON.stringify(packet)).not.toContain('do not copy memory');
    expect(JSON.stringify(packet)).not.toContain('do not copy digest entry');
  });

  it('marks freshness stale when the delivery snapshot is behind current memory', () => {
    const packet = buildContextContinuityPacket({
      event: {
        _id: 'evt-3',
        agentName: 'openclaw',
        instanceId: 'pixel',
        podId: 'pod-3',
        payload: {},
      },
      memoryRevision: 9,
      memoryRevisionAtDelivery: 7,
      lastSeenRevision: 6,
    });

    expect(packet.freshness).toEqual({
      memoryRevision: 9,
      memoryRevisionAtDelivery: 7,
      lastSeenRevision: 6,
      status: 'stale',
    });
  });

  it('marks freshness valid when the agent has seen the current memory revision', () => {
    const packet = buildContextContinuityPacket({
      event: {
        _id: 'evt-valid',
        agentName: 'openclaw',
        instanceId: 'pixel',
        podId: 'pod-valid',
        payload: {},
      },
      memoryRevision: 9,
      memoryRevisionAtDelivery: 9,
      lastSeenRevision: 9,
    });

    expect(packet.freshness).toEqual({
      memoryRevision: 9,
      memoryRevisionAtDelivery: 9,
      lastSeenRevision: 9,
      status: 'valid',
    });
  });

  it('marks freshness unknown when lastSeenRevision is missing', () => {
    const packet = buildContextContinuityPacket({
      event: {
        _id: 'evt-unknown',
        agentName: 'openclaw',
        instanceId: 'pixel',
        podId: 'pod-unknown',
        payload: {},
      },
      memoryRevision: 9,
      memoryRevisionAtDelivery: 9,
    });

    expect(packet.freshness).toEqual({
      memoryRevision: 9,
      memoryRevisionAtDelivery: 9,
      status: 'unknown',
    });
  });

  it('omits freshness when no memory snapshot is supplied', () => {
    const packet = buildContextContinuityPacket({
      event: {
        _id: 'evt-4',
        type: 'heartbeat',
        agentName: 'openclaw',
        instanceId: 'default',
        podId: 'pod-4',
        payload: {},
      },
    });

    expect(packet.owner).toEqual({
      agentName: 'openclaw',
      instanceId: 'default',
      podId: 'pod-4',
    });
    expect(packet.freshness).toBeUndefined();
    expect(packet.refs).toBeUndefined();
  });

  it('deduplicates memory section refs from digest bundle presence', () => {
    const sections = memorySectionsFromDigestBundle({
      memoryDigest: [{ takeaway: 'x' }],
      cyclesDigest: [{ content: 'cycle' }],
      longTermDigest: 'memory',
      recentDailyDigest: [{ date: '2026-06-24', content: 'daily' }],
    });

    expect(sections).toEqual(['system_exchanges', 'cycles', 'long_term', 'daily']);
  });
});
