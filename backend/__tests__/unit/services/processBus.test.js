/* eslint-disable global-require -- each process is a fresh module instance */
/**
 * services/processBus.ts: cross-process signals. Two module instances stand in
 * for two backend processes (each draws its own origin), over one fake broker.
 */
const { EventEmitter } = require('events');

const makeBroker = () => {
  const subscribers = new Map(); // channel -> Set<listener>
  const published = [];
  const makeClient = () => {
    const client = new EventEmitter();
    client.isReady = false;
    client.connect = jest.fn(async () => { client.isReady = true; client.emit('ready'); });
    client.publish = jest.fn(async (channel, message) => {
      published.push({ channel, message });
      (subscribers.get(channel) || new Set()).forEach((listener) => listener(message));
    });
    client.subscribe = jest.fn(async (channel, listener) => {
      if (!subscribers.has(channel)) subscribers.set(channel, new Set());
      subscribers.get(channel).add(listener);
    });
    client.duplicate = () => makeClient();
    return client;
  };
  return { makeClient, published, subscribers };
};

const loadProcess = (broker, { enabled = true } = {}) => {
  let bus;
  jest.isolateModules(() => {
    bus = require('../../../services/processBus');
  });
  bus.setProcessBusForTests({ factory: broker.makeClient, enabled });
  return bus;
};

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe('processBus', () => {
  afterEach(() => {
    delete process.env.REQUIRE_SHARED_REDIS;
    jest.restoreAllMocks();
  });

  test('a message reaches every other process, never the one that sent it', async () => {
    const broker = makeBroker();
    const a = loadProcess(broker);
    const b = loadProcess(broker);
    const onA = jest.fn();
    const onB = jest.fn();
    a.subscribe('cache-clear', onA);
    b.subscribe('cache-clear', onB);
    a.startProcessBus();
    b.startProcessBus();
    await flush();

    a.publish('cache-clear', { id: 'x1' });
    await flush();

    expect(onB).toHaveBeenCalledWith({ id: 'x1' });
    expect(onA).not.toHaveBeenCalled();
    expect(broker.published[0].channel).toBe('commonly:bus:cache-clear');
  });

  test('a channel subscribed after the bus connected is listened to', async () => {
    const broker = makeBroker();
    const a = loadProcess(broker);
    const b = loadProcess(broker);
    a.startProcessBus();
    b.startProcessBus();
    await flush();
    const onB = jest.fn();
    b.subscribe('late', onB);
    await flush();

    a.publish('late', { n: 1 });
    await flush();
    expect(onB).toHaveBeenCalledWith({ n: 1 });
  });

  test('off: subscribe only registers and publish sends nothing, so no Redis client is made', async () => {
    const broker = makeBroker();
    const factory = jest.fn(broker.makeClient);
    let bus;
    jest.isolateModules(() => { bus = require('../../../services/processBus'); });
    bus.setProcessBusForTests({ factory, enabled: false });
    bus.subscribe('x', jest.fn());
    bus.startProcessBus();
    bus.publish('x', { a: 1 });
    await flush();
    expect(factory).not.toHaveBeenCalled();
    expect(broker.published).toHaveLength(0);
  });

  test('before startProcessBus (a script importing the module) nothing connects', async () => {
    const broker = makeBroker();
    const factory = jest.fn(broker.makeClient);
    let bus;
    jest.isolateModules(() => { bus = require('../../../services/processBus'); });
    bus.setProcessBusForTests({ factory, enabled: true });
    bus.subscribe('x', jest.fn());
    bus.publish('x');
    await flush();
    expect(factory).not.toHaveBeenCalled();
  });

  test('a handler that throws does not stop the others', async () => {
    const broker = makeBroker();
    const a = loadProcess(broker);
    const b = loadProcess(broker);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const after = jest.fn();
    b.subscribe('c', () => { throw new Error('boom'); });
    b.subscribe('c', after);
    a.startProcessBus();
    b.startProcessBus();
    await flush();
    a.publish('c');
    await flush();
    expect(after).toHaveBeenCalled();
  });

  test('a lost connection stops a process that requires shared Redis, and only that one', async () => {
    const broker = makeBroker();
    let bus;
    let required;
    jest.isolateModules(() => {
      required = require('../../../config/sharedRedisRequired');
      bus = require('../../../services/processBus');
    });
    bus.setProcessBusForTests({ factory: broker.makeClient, enabled: true });
    required.resetSharedRedisRequiredForTests();
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    bus.startProcessBus();
    await flush();

    // Not required: an error is logged, the process keeps serving.
    process.env.REQUIRE_SHARED_REDIS = '0';
    expect(required.sharedRedisLost('test', new Error('x'))).toBe(false);
    expect(kill).not.toHaveBeenCalled();

    process.env.REQUIRE_SHARED_REDIS = '1';
    expect(required.sharedRedisLost('test', new Error('ECONNRESET'))).toBe(true);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    // Once.
    expect(required.sharedRedisLost('test again')).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('sharedRedisRequired', () => {
  test('runs the lost hooks before the shutdown signal', () => {
    let required;
    jest.isolateModules(() => { required = require('../../../config/sharedRedisRequired'); });
    const order = [];
    required.onSharedRedisLost(() => order.push('hook'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    required.sharedRedisLost('test', undefined, {
      env: { REQUIRE_SHARED_REDIS: '1' },
      kill: () => order.push('kill'),
    });
    expect(order).toEqual(['hook', 'kill']);
  });
});
