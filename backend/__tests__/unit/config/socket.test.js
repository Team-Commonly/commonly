const mockCreateAdapter = jest.fn(() => 'redis-adapter');
const mockCreateClient = jest.fn();

jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: mockCreateAdapter,
}));

jest.mock('redis', () => ({
  createClient: mockCreateClient,
}));

// The backend source is TypeScript, while this legacy ESLint resolver only
// discovers JavaScript module extensions.
// eslint-disable-next-line import/no-unresolved, import/extensions
const socketConfig = require('../../../config/socket');

const makeRedisClient = () => {
  const handlers = {};
  const client = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn(),
    on: jest.fn((event, handler) => {
      handlers[event] = handler;
      return client;
    }),
  };

  return { client, handlers };
};

describe('Socket.IO Redis adapter', () => {
  const originalK8sMode = process.env.AGENT_PROVISIONER_K8S;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_PROVISIONER_K8S = '1';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    if (originalK8sMode === undefined) {
      delete process.env.AGENT_PROVISIONER_K8S;
    } else {
      process.env.AGENT_PROVISIONER_K8S = originalK8sMode;
    }
  });

  it('falls back to the in-memory adapter when Redis is unavailable at boot', async () => {
    const pub = makeRedisClient();
    const sub = makeRedisClient();
    pub.client.duplicate.mockReturnValue(sub.client);
    pub.client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    mockCreateClient.mockReturnValue(pub.client);
    const io = { adapter: jest.fn() };

    await expect(socketConfig.init(io)).resolves.toBeUndefined();

    expect(io.adapter).not.toHaveBeenCalled();
    expect(pub.client.disconnect).toHaveBeenCalledTimes(1);
    expect(sub.client.disconnect).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[socket.io] Continuing without Redis adapter; Redis will not be used until process restart',
    );
  });

  it('configures exponential reconnect backoff capped at ten seconds', async () => {
    const pub = makeRedisClient();
    const sub = makeRedisClient();
    pub.client.duplicate.mockReturnValue(sub.client);
    mockCreateClient.mockReturnValue(pub.client);
    const io = { adapter: jest.fn() };

    await socketConfig.init(io);

    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({
      socket: expect.objectContaining({
        connectTimeout: 5000,
        reconnectStrategy: expect.any(Function),
      }),
    }));
    const { reconnectStrategy } = mockCreateClient.mock.calls[0][0].socket;
    expect(reconnectStrategy(0)).toBe(100);
    expect(reconnectStrategy(1)).toBe(200);
    expect(reconnectStrategy(6)).toBe(6400);
    expect(reconnectStrategy(7)).toBe(10000);
    expect(reconnectStrategy(20)).toBe(10000);
    expect(io.adapter).toHaveBeenCalledWith('redis-adapter');
  });

  it('logs Redis errors only when the connection state changes', async () => {
    const pub = makeRedisClient();
    const sub = makeRedisClient();
    pub.client.duplicate.mockReturnValue(sub.client);
    mockCreateClient.mockReturnValue(pub.client);
    const io = { adapter: jest.fn() };

    await socketConfig.init(io);

    pub.handlers.error(new Error('first failure'));
    pub.handlers.error(new Error('repeated failure'));
    sub.handlers.error(new Error('same outage'));
    expect(console.error).toHaveBeenCalledTimes(1);

    pub.handlers.ready();
    expect(console.log).toHaveBeenCalledWith('[socket.io] Redis clients recovered');

    sub.handlers.error(new Error('new outage'));
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});
