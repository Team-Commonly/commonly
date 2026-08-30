/**
 * ADR-026 D6 on the WebSocket ack surface.
 *
 * This handler previously called acknowledge() with three arguments and
 * emitted `ack:success` regardless of the return value — the same lie the two
 * HTTP ack routes grew a 400 to prevent, on a surface that is live
 * (server.ts init(io)). Under Phase B every WS ack would take the
 * `return null` branch in acknowledge, the socket would report success, and
 * the event would quietly requeue and redeliver.
 *
 * It also matters for the migration's exit condition: while any WS driver
 * acks nonce-less, `ackNonceStats.withoutNonce` can never reach zero, and
 * that number is the stated gate for flipping the flag.
 */
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() },
}));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../../../models/AgentCredential', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  findById: jest.fn().mockResolvedValue(null),
}));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

const mockAcknowledge = jest.fn();
const mockIsSuperseded = jest.fn();
const mockIsRequired = jest.fn();
jest.mock('../../../services/agentEventService', () => ({
  acknowledge: (...a) => mockAcknowledge(...a),
  isSupersededDelivery: (...a) => mockIsSuperseded(...a),
  isDeliveryNonceRequired: (...a) => mockIsRequired(...a),
  list: jest.fn().mockResolvedValue([]),
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const agentWebSocketService = require('../../../services/agentWebSocketService');

// Drive the real registration path: init(io) → namespace.on('connection') →
// the socket's own 'ack' listener. Testing the handler any other way would
// test a copy of it.
const wireSocket = () => {
  const handlers = {};
  const emitted = [];
  const emit = jest.fn((event, body) => emitted.push({ event, body }));
  const socket = {
    agentKey: 'pixel:default',
    agentName: 'pixel',
    instanceId: 'default',
    agentUserId: null,
    subscribedPods: new Set(),
    join: jest.fn(),
    leave: jest.fn(),
    on: (event, fn) => { handlers[event] = fn; },
    emit,
  };

  let connectionHandler;
  agentWebSocketService.init({
    of: () => ({
      use: jest.fn(),
      on: (event, fn) => { if (event === 'connection') connectionHandler = fn; },
    }),
  });
  connectionHandler(socket);
  return { handlers, emitted, socket };
};

describe("the WS 'ack' handler tells the truth about refusals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentInstallation.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
    Pod.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
    mockIsRequired.mockReturnValue(false);
    mockIsSuperseded.mockResolvedValue(false);
    mockAcknowledge.mockResolvedValue({ _id: 'evt-1', status: 'acked' });
  });

  test('forwards the deliveryId as the fifth argument', async () => {
    const { handlers, emitted } = wireSocket();

    await handlers.ack({ eventId: 'evt-1', deliveryId: 'abc123' });

    expect(mockAcknowledge).toHaveBeenCalledWith('evt-1', 'pixel', 'default', null, 'abc123');
    expect(emitted.map((e) => e.event)).toContain('ack:success');
  });

  test('Phase B: a nonce-less ack is refused, and the socket is told', async () => {
    mockIsRequired.mockReturnValue(true);
    const { handlers, emitted } = wireSocket();

    await handlers.ack({ eventId: 'evt-1' });

    // The bug this pins: emitting ack:success here told the driver it had
    // acked while the event rolled into the requeue unhandled.
    expect(mockAcknowledge).not.toHaveBeenCalled();
    expect(emitted).toContainEqual(
      expect.objectContaining({ event: 'ack:error', body: expect.objectContaining({ code: 'delivery_id_required' }) }),
    );
  });

  test('a superseded delivery reports an error, not success', async () => {
    mockAcknowledge.mockResolvedValue(null);
    mockIsSuperseded.mockResolvedValue(true);
    const { handlers, emitted } = wireSocket();

    await handlers.ack({ eventId: 'evt-1', deliveryId: 'stale' });

    expect(emitted).toContainEqual(
      expect.objectContaining({ event: 'ack:error', body: expect.objectContaining({ code: 'stale_delivery' }) }),
    );
  });

  test('a vanished event stays idempotent success', async () => {
    mockAcknowledge.mockResolvedValue(null);
    mockIsSuperseded.mockResolvedValue(false);
    const { handlers, emitted } = wireSocket();

    await handlers.ack({ eventId: 'evt-1', deliveryId: 'gone' });

    expect(emitted.map((e) => e.event)).toContain('ack:success');
  });

  test('Phase A is unchanged for a nonce-less driver', async () => {
    const { handlers, emitted } = wireSocket();

    await handlers.ack({ eventId: 'evt-1' });

    expect(mockAcknowledge).toHaveBeenCalledWith('evt-1', 'pixel', 'default', null, null);
    expect(emitted.map((e) => e.event)).toContain('ack:success');
  });
});

describe('the WS event push path claims before it delivers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentInstallation.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
    Pod.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  });

  test('a pending event wakes its target through replay, not a raw namespace broadcast', () => {
    const { socket } = wireSocket();
    const replay = jest.spyOn(agentWebSocketService, 'replayPendingEvents').mockResolvedValue();
    socket.emit.mockClear();

    const delivered = agentWebSocketService.pushEvent({
      _id: 'evt-pending',
      agentName: 'pixel',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'message.created',
    });

    // replayPendingEvents calls list(), whose conditional claim mints the
    // nonce and emits that claimed event. This pairing is the D6 boundary.
    expect(delivered).toBe(true);
    expect(replay).toHaveBeenCalledWith(socket);
    expect(socket.emit).not.toHaveBeenCalledWith('event', expect.anything());
  });

  test('a native event that was born claimed preserves its existing nonce', () => {
    const { socket } = wireSocket();
    const replay = jest.spyOn(agentWebSocketService, 'replayPendingEvents').mockResolvedValue();
    socket.emit.mockClear();
    const event = {
      _id: 'evt-native',
      agentName: 'pixel',
      instanceId: 'default',
      deliveryId: 'native-delivery',
    };

    expect(agentWebSocketService.pushEvent(event)).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith('event', event);
    expect(replay).not.toHaveBeenCalled();
  });
});
