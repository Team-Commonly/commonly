/**
 * TASK-103 — the failure tail the codex and claude adapters raise.
 *
 * Both adapters reported LOUDLY before this (Vera 71177 corrected an earlier row
 * that claimed otherwise: claude rejects on a non-zero exit and reports stdout
 * with it, codex rejects on `turnFailedMessage` even at exit 0). What they did
 * NOT do was the two things pi's refusal log learned in #1823/#1827:
 *
 *   1. the text was the raw tail, so a body echoing a credential this spawn was
 *      handed went into an error message — and for codex's `turn.failed` branch
 *      the run loop posts that message as the agent's reply, into a pod;
 *   2. no status was attached, so the circuit breaker keyed on regex alone
 *      against a provider that had already answered 429.
 *
 * The 429 bodies here come from a real local HTTP server rather than a string
 * invented for the test. The provider-side leg is NOT measured: the `claude`
 * binary is not installed on this machine, and the adapter's contract is what is
 * under test, not the provider's wording. See the PR for that disclosure.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import http from 'http';

import { adapterFailure, scrubAdapterFailure } from '../src/lib/upstream-refusal.js';
import { classifySpawnFailure, SPAWN_FAILURE_CLASS } from '../src/lib/spawn-retry.js';

const SECRET = 'sk-litellm-abcdef123456';

// Mock child_process the way the adapter suites do: `spawnSync` is only used by
// detect(), and `spawn` is replaced by the `_spawnImpl` seam.
const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: jest.fn(),
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;

const fakeChild = ({ stdout = '', stderr = '', code = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  }, 0);
  return proc;
};

/** Answer one request with `status` and return the body a 429 actually carried. */
const bodyFromRealServer = async (status, body) => {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: '{}',
    });
    return { httpStatus: res.status, text: await res.text() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

describe('the shared reader — scrubAdapterFailure', () => {
  test('a body from a real 429 that echoes the key keeps nothing of the key', async () => {
    const { httpStatus, text } = await bodyFromRealServer(429, {
      error: { message: `insufficient_quota: key ${SECRET} has no budget` },
    });
    expect(httpStatus).toBe(429);
    // The body really does contain the credential — otherwise this test proves
    // nothing about redaction.
    expect(text).toContain(SECRET);

    const { status, detail } = scrubAdapterFailure(text, { credentials: [SECRET] });

    expect(detail).not.toContain(SECRET);
    expect(detail).toContain('[redacted]');
    // Nothing in the body names a status, so none is invented (`classifySpawnFailure`
    // reads the wording instead, which is why the quota line survives at all).
    expect(status).toBeNull();
  });

  test('a status named mid-tail is read — claude joins stderr and stdout with " | "', () => {
    const { status, detail } = scrubAdapterFailure(
      `warn: retrying | 429: {"message":"rate limit exceeded"}`,
    );

    expect(status).toBe(429);
    expect(detail).toContain('rate limit exceeded');
  });

  test('a timestamp, a count, or a 2xx is not read as a status', () => {
    expect(scrubAdapterFailure('2026-09-23T04:00:00Z ERROR exceeded 1234 tokens').status).toBeNull();
    // A tail that logged a successful probe on the way to the failure is the
    // realistic version of this: `200` is three digits and is not a refusal.
    expect(scrubAdapterFailure('2026-09-23T04:00:00Z GET /v1/models 200 in 1234ms').status).toBeNull();
  });

  test('the keep-list applies to a JSON body: one named field, not the blob', () => {
    const { status, detail } = scrubAdapterFailure('429: {"error":{"message":"quota exceeded"},"extra":"noise"}');

    expect(status).toBe(429);
    expect(detail).toBe('quota exceeded');
  });
});

describe('the error the adapters raise — adapterFailure', () => {
  test('carries the status as a FIELD, which is what the classifier reads first', () => {
    const err = adapterFailure('claude', 'warn | 429: too many requests', { exitCode: 1 });

    expect(err.status).toBe(429);
    expect(err.message).toContain('claude exited with code 1 (upstream 429)');
    expect(classifySpawnFailure(err)).toBe(SPAWN_FAILURE_CLASS.RATE_LIMIT);
  });

  test('a quota wording with no status still classifies as QUOTA, not RUNTIME', () => {
    const err = adapterFailure('claude', 'Claude usage limit reached. Reset at 11:40pm.', { exitCode: 1 });

    expect(err.status).toBeUndefined();
    expect(classifySpawnFailure(err)).toBe(SPAWN_FAILURE_CLASS.QUOTA);
  });

  test('a credential in the tail never reaches the message', () => {
    const err = adapterFailure('codex', `turn failed: rejected key ${SECRET}`, {
      credentials: [SECRET],
    });

    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain('[redacted]');
  });

  test('the caller can keep its own length budget', () => {
    const err = adapterFailure('codex', 'x'.repeat(200), { limit: 20 });

    expect(err.message).toBe(`codex: ${'x'.repeat(20)}`);
  });
});

describe('claude adapter — the tail goes through the reader', () => {
  test('a 429 stdout tail is status-named and scrubbed, and the wording survives', async () => {
    const { impl } = {
      impl: () => fakeChild({
        stdout: `429: {"error":{"message":"insufficient_quota for key ${SECRET}"}}`,
        stderr: 'warn: retrying',
        code: 1,
      }),
    };

    const err = await claude.spawn('hi', {
      sessionId: null,
      runtimeToken: SECRET,
      _spawnImpl: impl,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain('upstream 429');
    expect(err.message).toContain('insufficient_quota');
    // The point of attaching the status: the fleet stands down on the right
    // schedule instead of probing a refusing provider every 5s.
    expect(classifySpawnFailure(err)).not.toBe(SPAWN_FAILURE_CLASS.RUNTIME);
  });
});
