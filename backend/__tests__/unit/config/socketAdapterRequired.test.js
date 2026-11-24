/* eslint-disable global-require -- each case loads fresh modules */
/**
 * config/socket.ts: the Redis adapter turns on wherever REDIS_HOST is set, and
 * a process started with REQUIRE_SHARED_REDIS=1 stops serving when it can't
 * have it, at boot or later, instead of serving split from its siblings.
 */
const { EventEmitter: MockEventEmitter } = require('events');

const mockClients = [];
let mockConnectFails = false;
let mockConnectHangs = false;

jest.mock('redis', () => ({
  createClient: jest.fn(() => {
    const make = () => {
      const client = new MockEventEmitter();
      client.connect = jest.fn(async () => {
        if (mockConnectHangs) return new Promise(() => {}); // node-redis retrying forever
        if (mockConnectFails) throw new Error('ECONNREFUSED');
        return undefined;
      });
      client.disconnect = jest.fn(async () => {});
      client.duplicate = () => make();
      mockClients.push(client);
      return client;
    };
    return make();
  }),
}));
jest.mock('@socket.io/redis-adapter', () => ({ createAdapter: jest.fn(() => 'redis-adapter') }));

const ENV_KEYS = ['REDIS_HOST', 'AGENT_PROVISIONER_K8S', 'REQUIRE_SHARED_REDIS'];

const load = () => {
  let socket;
  let required;
  jest.isolateModules(() => {
    required = require('../../../config/sharedRedisRequired');
    socket = require('../../../config/socket');
  });
  required.resetSharedRedisRequiredForTests();
  return socket;
};

// disconnectSockets on the server itself is the cluster-wide call: through
// the adapter it would drop every other process's sockets too.
const fakeIo = () => {
  const agents = { local: { disconnectSockets: jest.fn() }, disconnectSockets: jest.fn() };
  return {
    adapter: jest.fn(),
    disconnectSockets: jest.fn(),
    local: { disconnectSockets: jest.fn() },
    agents,
    of: (name) => (name === '/agents' ? agents : null),
  };
};
const expectDroppedOwnSocketsOnly = (io) => {
  expect(io.local.disconnectSockets).toHaveBeenCalledWith(true);
  expect(io.agents.local.disconnectSockets).toHaveBeenCalledWith(true);
  expect(io.disconnectSockets).not.toHaveBeenCalled();
  expect(io.agents.disconnectSockets).not.toHaveBeenCalled();
};

describe('socket.io Redis adapter', () => {
  let saved;
  let kill;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    ENV_KEYS.forEach((k) => { delete process.env[k]; });
    mockClients.length = 0;
    mockConnectFails = false;
    mockConnectHangs = false;
    kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
    jest.restoreAllMocks();
  });

  test('turns on with REDIS_HOST alone (the VM sets no AGENT_PROVISIONER_K8S)', async () => {
    process.env.REDIS_HOST = 'redis';
    const io = fakeIo();
    await load().init(io);
    expect(io.adapter).toHaveBeenCalledWith('redis-adapter');
  });

  test('no Redis configured and not required: single-process mode, keeps serving', async () => {
    const io = fakeIo();
    await load().init(io);
    expect(io.adapter).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  test('a failed connect falls back locally on the primary process', async () => {
    process.env.REDIS_HOST = 'redis';
    mockConnectFails = true;
    const io = fakeIo();
    await load().init(io);
    expect(io.adapter).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  // A primary that boots during a Redis outage must not serve on its own
  // delivery path for the rest of its life: once Redis is up, a second process
  // would broadcast and revoke past it.
  test('a connect that never answers: the primary attaches the adapter after the deadline and keeps its clients retrying', async () => {
    process.env.REDIS_HOST = 'redis';
    mockConnectHangs = true;
    jest.useFakeTimers();
    try {
      const io = fakeIo();
      const done = load().init(io);
      await jest.advanceTimersByTimeAsync(15000);
      await done;
      expect(io.adapter).toHaveBeenCalledWith('redis-adapter');
      mockClients.forEach((client) => expect(client.disconnect).not.toHaveBeenCalled());
      expect(kill).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a connect that never answers stops a process that requires shared Redis, and ends its retry loop', async () => {
    process.env.REDIS_HOST = 'redis';
    process.env.REQUIRE_SHARED_REDIS = '1';
    mockConnectHangs = true;
    jest.useFakeTimers();
    try {
      const io = fakeIo();
      const done = load().init(io);
      await jest.advanceTimersByTimeAsync(15000);
      await done;
      expect(io.adapter).not.toHaveBeenCalled();
      mockClients.forEach((client) => expect(client.disconnect).toHaveBeenCalled());
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a failed connect stops a process that requires shared Redis', async () => {
    process.env.REDIS_HOST = 'redis';
    process.env.REQUIRE_SHARED_REDIS = '1';
    mockConnectFails = true;
    const io = fakeIo();
    await load().init(io);
    expect(io.adapter).not.toHaveBeenCalled();
    expectDroppedOwnSocketsOnly(io);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  test('a required process with no REDIS_HOST at all does not serve', async () => {
    process.env.REQUIRE_SHARED_REDIS = '1';
    await load().init(fakeIo());
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  test.each(['error', 'end'])('a later %s on the adapter clients drops the sockets and stops a required process', async (event) => {
    process.env.REDIS_HOST = 'redis';
    process.env.REQUIRE_SHARED_REDIS = '1';
    const io = fakeIo();
    await load().init(io);
    expect(io.adapter).toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();

    mockClients[1].emit(event, new Error('ECONNRESET'));
    expectDroppedOwnSocketsOnly(io);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  test('a later error on the primary is logged, and it keeps serving', async () => {
    process.env.REDIS_HOST = 'redis';
    const io = fakeIo();
    await load().init(io);
    mockClients[0].emit('error', new Error('ECONNRESET'));
    expect(kill).not.toHaveBeenCalled();
    expect(io.local.disconnectSockets).not.toHaveBeenCalled();
  });
});
