// F637: ~140 daemons on one key each retried a 429 after 1-2 s, so the server's
// limiter never got a quiet minute. A 429 now defers both loops by at least a
// minute (or the server's Retry-After, if longer), and says once per stretch
// that more than one daemon may be running on this computer.
import {
  describe, expect, jest, test,
} from '@jest/globals';
import { createDaemonSupervisor } from '../src/lib/daemon-supervisor.js';

const record = {
  machineDbId: '507f1f77bcf86cd799439011',
  machineId: 'machine-a',
  machineName: 'Box A',
  instanceUrl: 'https://api.example.test',
  daemonToken: 'cm_daemon_secret',
};

const rateLimited = (retryAfterMs) => Object.assign(new Error('rate limit exceeded'), {
  status: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

const harness = () => {
  let clock = 1_000_000;
  const lines = [];
  let fail = null;
  const client = {
    get: jest.fn(async () => { if (fail) throw fail; return { agents: [] }; }),
    post: jest.fn(async () => { if (fail) throw fail; return { ok: true }; }),
  };
  const supervisor = createDaemonSupervisor({
    record,
    client,
    spawnChild: jest.fn(),
    loadToken: () => null,
    saveToken: jest.fn(),
    resolveAdapter: async () => 'claude',
    log: (line) => lines.push(line),
    now: () => clock,
    random: () => 0,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  return {
    supervisor,
    client,
    lines,
    advance: (ms) => { clock += ms; },
    failWith: (error) => { fail = error; },
  };
};

const NOTICE = "the server is rate-limiting this computer's daemon key; more than one Commonly daemon may be running on it";
const notices = (lines) => lines.filter((line) => line.includes(NOTICE));

describe('a 429 from the server', () => {
  test('defers both tick and heartbeat by at least 60 s, even when Retry-After is shorter', async () => {
    const h = harness();
    h.failWith(rateLimited(5_000));
    await h.supervisor.tick();
    expect(h.client.get).toHaveBeenCalledTimes(1);
    h.advance(59_000);
    await h.supervisor.tick();
    await h.supervisor.heartbeat();
    expect(h.client.get).toHaveBeenCalledTimes(1);
    expect(h.client.post).not.toHaveBeenCalled();
    h.advance(1_500);
    await h.supervisor.heartbeat();
    expect(h.client.post).toHaveBeenCalledTimes(1);
  });

  test('a Retry-After longer than a minute is honoured', async () => {
    const h = harness();
    h.failWith(rateLimited(120_000));
    await h.supervisor.heartbeat();
    h.advance(100_000);
    await h.supervisor.tick();
    expect(h.client.get).not.toHaveBeenCalled();
    h.advance(21_000);
    await h.supervisor.tick();
    expect(h.client.get).toHaveBeenCalledTimes(1);
  });

  test('a Retry-After of a day is capped at 10 minutes', async () => {
    const h = harness();
    h.failWith(rateLimited(86_400 * 1000));
    await h.supervisor.tick();
    h.advance(10 * 60_000 - 1_000);
    await h.supervisor.heartbeat();
    expect(h.client.post).not.toHaveBeenCalled();
    h.failWith(null);
    h.advance(1_500);
    await h.supervisor.heartbeat();
    await h.supervisor.tick();
    expect(h.client.post).toHaveBeenCalledTimes(1);
    expect(h.client.get).toHaveBeenCalledTimes(2);
  });

  test('a 429 with no Retry-After still waits 60 s', async () => {
    const h = harness();
    h.failWith(rateLimited());
    await h.supervisor.tick();
    h.advance(59_000);
    await h.supervisor.tick();
    expect(h.client.get).toHaveBeenCalledTimes(1);
  });

  test('logs the duplicate-daemon line once for consecutive 429s, and again after a success', async () => {
    const h = harness();
    h.failWith(rateLimited(1_000));
    await h.supervisor.tick();
    h.advance(61_000);
    await h.supervisor.heartbeat();
    h.advance(61_000);
    await h.supervisor.tick();
    expect(h.client.get).toHaveBeenCalledTimes(2);
    expect(notices(h.lines)).toHaveLength(1);

    h.failWith(null);
    h.advance(61_000);
    await h.supervisor.tick();
    expect(h.client.get).toHaveBeenCalledTimes(3);
    // The backoff reset: the next calls go straight through.
    await h.supervisor.heartbeat();
    await h.supervisor.tick();
    expect(h.client.get).toHaveBeenCalledTimes(4);

    h.failWith(rateLimited(1_000));
    await h.supervisor.tick();
    expect(notices(h.lines)).toHaveLength(2);
  });

  test('any other failure keeps the short reconnect backoff', async () => {
    const h = harness();
    h.failWith(Object.assign(new Error('boom'), { status: 502 }));
    await h.supervisor.tick();
    h.advance(2_500);
    await h.supervisor.tick();
    expect(h.client.get).toHaveBeenCalledTimes(2);
    expect(notices(h.lines)).toHaveLength(0);
  });
});
