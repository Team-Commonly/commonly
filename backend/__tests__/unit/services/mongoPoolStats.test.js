// F636: the prod Mongo pool sits at its 100-connection ceiling and a
// scheduler pass runs ~2 s slower in the serving process than alone. Nothing
// says whether queries wait for a free connection. These tests pin the
// opt-in pool stats log: what it counts from the driver's CMAP events, the
// FIFO wait approximation (per address), the exact line (never the address),
// per-interval reset vs running counts, that stop() detaches everything, and
// that a handler never throws into a query path.
const { EventEmitter } = require('events');
const {
  startMongoPoolStats,
  CMAP_EVENT_NAMES,
} = require('../../../services/mongoPoolStats');

const A = 'db-a.internal:27017';
const B = 'db-b.internal:27017';

const setup = (opts = {}) => {
  const client = new EventEmitter();
  let t = 0;
  const clock = { advance: (ms) => { t += ms; } };
  const lines = [];
  const stats = startMongoPoolStats(client, {
    intervalMs: 1000,
    now: () => t,
    log: (line) => lines.push(line),
    ...opts,
  });
  const ev = {
    start: (address = A) => client.emit('connectionCheckOutStarted', { address }),
    out: (address = A, id = 1) => client.emit('connectionCheckedOut', { address, connectionId: id }),
    fail: (address = A, reason = 'timeout') => client.emit('connectionCheckOutFailed', { address, reason }),
    back: (address = A, id = 1) => client.emit('connectionCheckedIn', { address, connectionId: id }),
    created: (address = A, id = 1) => client.emit('connectionCreated', { address, connectionId: id }),
    closed: (address = A, id = 1) => client.emit('connectionClosed', { address, connectionId: id, reason: 'idle' }),
  };
  return { client, clock, lines, stats, ev };
};

const field = (line, name) => {
  const m = line.match(new RegExp(`(?:^| )${name}=(\\d+)`));
  return m ? Number(m[1]) : undefined;
};

describe('startMongoPoolStats', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('counts checkouts, waits, percentiles, peaks and failures by reason', () => {
    const { clock, lines, stats, ev } = setup();
    ev.created(A, 1); ev.created(A, 2);
    // three checkouts start together; they are served in order at 0, 10, 300 ms
    ev.start(); ev.start(); ev.start();
    ev.out(A, 1); // wait 0
    clock.advance(10);
    ev.out(A, 2); // wait 10
    clock.advance(290);
    ev.out(A, 3); // wait 300
    ev.back(A, 1); ev.back(A, 2);
    // one start that fails after 50 ms (counted as failed, not as a checkout)
    ev.start();
    clock.advance(50);
    ev.fail(A, 'timeout');
    ev.start();
    ev.fail(A, 'connectionError');
    ev.start();
    ev.fail(A, 'timeout');

    jest.advanceTimersByTime(1000);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(field(line, 'checkouts')).toBe(3);
    expect(field(line, 'waited')).toBe(2);
    expect(field(line, 'p50')).toBe(10);
    expect(field(line, 'p95')).toBe(300);
    expect(field(line, 'max')).toBe(300);
    expect(field(line, 'maxCheckedOut')).toBe(3);
    expect(field(line, 'maxWaiting')).toBe(3);
    expect(field(line, 'failed')).toBe(3);
    expect(line).toContain('failedReasons=connectionError:1,timeout:2');
    expect(field(line, 'created')).toBe(2);
    expect(field(line, 'open')).toBe(2);
    expect(field(line, 'servers')).toBe(1);
    stats.stop();
  });

  it('keeps a separate FIFO per address', () => {
    const { clock, lines, stats, ev } = setup();
    ev.start(A); // t=0
    clock.advance(100);
    ev.start(B); // t=100
    ev.out(B); // B waited 0, not 100 (A's start must not be shifted)
    clock.advance(400);
    ev.out(A); // A waited 500
    jest.advanceTimersByTime(1000);
    const line = lines[0];
    expect(field(line, 'checkouts')).toBe(2);
    expect(field(line, 'waited')).toBe(1);
    expect(field(line, 'max')).toBe(500);
    expect(field(line, 'p50')).toBe(0);
    expect(field(line, 'servers')).toBe(2);
    stats.stop();
  });

  it('emits an exact numbers-only line that never names an address', () => {
    const { clock, lines, stats, ev } = setup();
    ev.created(A, 1);
    ev.start(); clock.advance(7); ev.out();
    jest.advanceTimersByTime(1000);
    expect(lines[0]).toBe(
      '[mongo-pool] checkouts=1 waited=1 waitMs p50=7 p95=7 max=7 maxCheckedOut=1 maxWaiting=1'
      + ' failed=0 created=1 closed=0 open=1 servers=1 dropped=0',
    );
    expect(lines[0]).not.toContain('db-a');
    expect(lines[0]).not.toContain('27017');
    stats.stop();
  });

  it('resets the interval counters but carries the running counts', () => {
    const { lines, stats, ev } = setup();
    ev.created(A, 1); ev.created(A, 2); ev.created(A, 3);
    ev.closed(A, 3);
    ev.start(); ev.out(A, 1);
    ev.start(); ev.out(A, 2);
    ev.start(); // still waiting at the interval end
    jest.advanceTimersByTime(1000);
    expect(field(lines[0], 'checkouts')).toBe(2);
    expect(field(lines[0], 'open')).toBe(2);

    jest.advanceTimersByTime(1000);
    const second = lines[1];
    expect(field(second, 'checkouts')).toBe(0);
    expect(field(second, 'created')).toBe(0);
    expect(field(second, 'closed')).toBe(0);
    expect(field(second, 'p95')).toBe(0);
    // two connections are still checked out and one checkout still waits
    expect(field(second, 'maxCheckedOut')).toBe(2);
    expect(field(second, 'maxWaiting')).toBe(1);
    expect(field(second, 'open')).toBe(2);
    stats.stop();
  });

  it('stop() removes every listener and the timer', () => {
    const { client, lines, stats } = setup();
    CMAP_EVENT_NAMES.forEach((name) => expect(client.listenerCount(name)).toBe(1));
    stats.stop();
    CMAP_EVENT_NAMES.forEach((name) => expect(client.listenerCount(name)).toBe(0));
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(lines).toHaveLength(0);
  });

  it('listens to the driver 5.9 CMAP event names', () => {
    expect([...CMAP_EVENT_NAMES].sort()).toEqual([
      'connectionCheckOutFailed',
      'connectionCheckOutStarted',
      'connectionCheckedIn',
      'connectionCheckedOut',
      'connectionClosed',
      'connectionCreated',
    ]);
  });

  it('never throws on a malformed event', () => {
    const { client, lines, stats } = setup();
    expect(() => {
      CMAP_EVENT_NAMES.forEach((name) => {
        client.emit(name);
        client.emit(name, null);
        client.emit(name, 42);
        client.emit(name, { address: { toString() { throw new Error('boom'); } } });
      });
    }).not.toThrow();
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    expect(lines[0]).toMatch(/^\[mongo-pool\] /);
    stats.stop();
  });

  it('caps each FIFO and counts the dropped start times', () => {
    const { lines, stats, ev } = setup({ maxQueue: 5 });
    for (let i = 0; i < 8; i += 1) ev.start();
    jest.advanceTimersByTime(1000);
    expect(field(lines[0], 'dropped')).toBe(3);
    expect(field(lines[0], 'maxWaiting')).toBe(8);
    stats.stop();
  });

  it('unrefs the interval timer so it never holds the process open', () => {
    jest.useRealTimers();
    const spy = jest.spyOn(global, 'setInterval');
    const { stats } = setup();
    const timer = spy.mock.results[0].value;
    expect(timer.hasRef()).toBe(false);
    stats.stop();
  });

  it('counts a checkout on an empty queue but adds no wait sample', () => {
    const { lines, stats, ev } = setup();
    ev.out(); // in flight before stats started: no start time to pair with
    jest.advanceTimersByTime(1000);
    const line = lines[0];
    expect(field(line, 'checkouts')).toBe(1);
    expect(field(line, 'waited')).toBe(0);
    expect(field(line, 'p50')).toBe(0);
    expect(field(line, 'max')).toBe(0);
    stats.stop();
  });

  it('self-corrects once the queue empties after an in-flight end pairs with a newer start', () => {
    const { clock, lines, stats, ev } = setup();
    ev.start(); // t=0, a new checkout
    clock.advance(100);
    ev.out(); // an end for a checkout started before stats: mispaired, wait 100
    clock.advance(10);
    ev.out(); // the new checkout's own end: queue is empty, no sample
    jest.advanceTimersByTime(1000);
    expect(field(lines[0], 'checkouts')).toBe(2);
    expect(field(lines[0], 'max')).toBe(100);

    ev.start();
    clock.advance(30);
    ev.out();
    ev.start();
    clock.advance(2);
    ev.out();
    jest.advanceTimersByTime(1000);
    const second = lines[1];
    expect(field(second, 'checkouts')).toBe(2);
    expect(field(second, 'waited')).toBe(1);
    expect(field(second, 'p50')).toBe(2);
    expect(field(second, 'p95')).toBe(30);
    expect(field(second, 'max')).toBe(30);
    expect(field(second, 'maxWaiting')).toBe(1);
    stats.stop();
  });

  it('defaults to a 10,000-entry cap and a 60 s interval', () => {
    const { lines, stats, ev } = setup({ intervalMs: undefined, maxQueue: undefined });
    for (let i = 0; i < 10001; i += 1) ev.start();
    jest.advanceTimersByTime(59999);
    expect(lines).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(field(lines[0], 'dropped')).toBe(1);
    stats.stop();
  });
});
