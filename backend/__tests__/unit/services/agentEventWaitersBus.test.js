/* eslint-disable global-require -- each process is a fresh module instance */
/**
 * services/agentEventWaiters.ts over the process bus: an enqueue on one backend
 * process wakes a held poll on another at once, not at its next recheck. Two
 * module instances stand in for two processes, over one fake broker.
 */
const { EventEmitter } = require('events');

const makeBroker = () => {
  const subscribers = new Map();
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
  return { makeClient, published };
};

const loadProcess = (broker, { enabled = true } = {}) => {
  let bus;
  let waiters;
  jest.isolateModules(() => {
    bus = require('../../../services/processBus');
    bus.setProcessBusForTests({ factory: broker.makeClient, enabled });
    waiters = require('../../../services/agentEventWaiters');
  });
  bus.startProcessBus();
  return waiters;
};

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

// A hold that would otherwise end only on its timeout: no recheck finds
// anything, and the client never leaves.
const hold = (waiters, agentName, instanceId) => waiters.waitForAgentEvent({
  agentName,
  instanceId,
  timeoutMs: 3000,
  recheckMs: 3000,
  hasPending: async () => false,
  onClose: () => () => {},
});

describe('agentEventWaiters across backend processes', () => {
  test('an enqueue on one process wakes the hold on another', async () => {
    const broker = makeBroker();
    const web = loadProcess(broker);
    const worker = loadProcess(broker);
    await flush();

    const held = hold(web, 'Scout', 'alpha');
    expect(web.waiterCount()).toBe(1);

    worker.notifyAgentEventWaiters('scout', 'alpha');
    await flush();

    await expect(held).resolves.toBe('woken');
    expect(web.waiterCount()).toBe(0);
    expect(broker.published).toHaveLength(1);
    expect(broker.published[0].channel).toBe('commonly:bus:agent-event-wake');
  });

  test("another identity's enqueue leaves the hold alone", async () => {
    const broker = makeBroker();
    const web = loadProcess(broker);
    const worker = loadProcess(broker);
    await flush();

    const held = hold(web, 'scout', 'alpha');
    worker.notifyAgentEventWaiters('scout', 'beta');
    worker.notifyAgentEventWaiters('other', 'alpha');
    await flush();
    expect(web.waiterCount()).toBe(1);

    web.endAllWaits();
    await expect(held).resolves.toBe('timeout');
  });

  test('an absent instanceId means default on both sides', async () => {
    const broker = makeBroker();
    const web = loadProcess(broker);
    const worker = loadProcess(broker);
    await flush();

    const held = hold(web, 'scout', 'default');
    worker.notifyAgentEventWaiters('scout', undefined);
    await flush();
    await expect(held).resolves.toBe('woken');
  });

  test('the local wake still happens with the bus off', async () => {
    const broker = makeBroker();
    const solo = loadProcess(broker, { enabled: false });
    await flush();

    const held = hold(solo, 'scout', 'alpha');
    solo.notifyAgentEventWaiters('scout', 'alpha');
    await expect(held).resolves.toBe('woken');
    expect(broker.published).toHaveLength(0);
  });
});
