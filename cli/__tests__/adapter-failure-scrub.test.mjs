/**
 * TASK-103 — the failure tail the codex and claude adapters raise.
 *
 * Both adapters reported LOUDLY before this (an earlier row
 * claimed otherwise: claude rejects on a non-zero exit and reports stdout
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
  test('a body from a real 429 that echoes the key ships NOTHING of the body', async () => {
    const { httpStatus, text } = await bodyFromRealServer(429, {
      error: { message: `insufficient_quota: key ${SECRET} has no budget` },
    });
    expect(httpStatus).toBe(429);
    // The body really does contain the credential — otherwise this test proves
    // nothing about the drop.
    expect(text).toContain(SECRET);

    const { status, detail } = scrubAdapterFailure(text, { credentials: [SECRET] });

    // Dropped WHOLE, not redacted: the keep-listed field echoed a handed value,
    // and exact-match redaction cannot see that same value base64'd or
    // percent-encoded (limit (a) in the file header). Emitting the rest of the
    // body was the defect.
    expect(detail).toBe('');
    expect(detail).not.toContain('has no budget');
    // Nothing in the body names a status, so none is invented (`classifySpawnFailure`
    // reads the wording instead, which is why the quota line survives at all —
    // but only when the body does not echo a credential).
    expect(status).toBeNull();
  });

  test('a body with no keep-listed field still reports the status it names', () => {
    const { status, detail } = scrubAdapterFailure(
      '{"error":{"type":"rate_limit_error","code":"429"}}',
    );

    expect(status).toBe(429);
    expect(detail).toBe('');
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
    expect(scrubAdapterFailure('GET /v1/models HTTP 200 | upstream closed the connection').status).toBeNull();
    expect(scrubAdapterFailure('warn | 200: ok | upstream closed the connection').status).toBeNull();
    // A bare 3-digit scan reads every one of these as 500. The classifier tests
    // the status field BEFORE the message, so a count misread as a status stands
    // the fleet down on a refusal that never happened.
    expect(scrubAdapterFailure('retrying: 500 tokens remaining').status).toBeNull();
    expect(scrubAdapterFailure('context_limit: {"max_tokens": 500}').status).toBeNull();
    expect(scrubAdapterFailure('overloaded, retry in 500 seconds').status).toBeNull();
  });

  test('a JSON string tail is prose, not a body to reduce', () => {
    // A terse gateway can answer with a bare JSON string. It parses, so the
    // keep-list finds no named field — but it is a whole-shape text with no
    // fields to reduce, and it keeps its wording, because the fallback is gated
    // on the SHAPE, not on "did it parse" and not on "did the keep-list return
    // null".
    expect(scrubAdapterFailure('"Too many requests, slow down"').detail).toContain('Too many requests');
  });

  test('a JSON ARRAY tail is structured data, so nothing of it is echoed', () => {
    // Measured: an array parsed, `keptRefusalDetail` found no named
    // field (there is no top-level `error`/`message` on a list), and the old
    // is-JSON-OBJECT gate excluded arrays — so the fallback treated upstream
    // structured data as prose and shipped it whole under exact-match alone. That
    // is precisely the case rule 1 exists for.
    const tail = '[{"error":{"message":"boom","api_key":"sk-live-ARRAYSECRET0123456789"}}]';
    const { status, detail } = scrubAdapterFailure(tail, { credentials: ['sk-live-ARRAYSECRET0123456789'] });
    expect(detail).toBe('');
    expect(detail).not.toContain('ARRAYSECRET');
    expect(detail).not.toContain('boom');
    expect(status).toBeNull();
  });

  test('an HTTP status LINE names its status — the most canonical shape there is', () => {
    // `HTTP/1.1 429 Too Many Requests` read as `status: null`, because
    // the named-shape gap cannot cross the `1` in `/1.1` (it is a WORD character).
    // A real status line classified as an unclassified runtime failure — the
    // misclassification this row exists to remove.
    expect(scrubAdapterFailure('HTTP/1.1 429 Too Many Requests').status).toBe(429);
    expect(scrubAdapterFailure('HTTP/2 503').status).toBe(503);
    expect(scrubAdapterFailure('HTTP/1.1 200 OK').status).toBeNull();
    // The shape is narrow on purpose: a path that merely looks like a version is
    // not a status line, and `HTTP 429` still works through the named shape.
    expect(scrubAdapterFailure('GET /v1.1/models responded 500').status).toBeNull();
    expect(scrubAdapterFailure('HTTP 429 Too Many Requests').status).toBe(429);
  });

  test('a status the tail NAMES is read wherever it sits', () => {
    expect(scrubAdapterFailure('upstream returned HTTP 503').status).toBe(503);
    expect(scrubAdapterFailure('response status: 429 from provider').status).toBe(429);
    expect(scrubAdapterFailure('error code=504 gateway timeout').status).toBe(504);
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

  test('an empty detail leaves no dangling separator in the message', () => {
    const err = adapterFailure('claude', '{"error":{"code":"429"}}', { exitCode: 1 });

    expect(err.message).toBe('claude exited with code 1 (upstream 429)');
  });

  test('a NON-JSON tail keeps its wording — that is the whole reason stdout is reported', () => {
    const err = adapterFailure('claude', `Claude usage limit reached. Reset at 11:40pm.`, { exitCode: 1 });

    expect(err.message).toContain('Claude usage limit reached');
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

    const err = await claude.spawn('hi', { environment: { model: 'test-model' },
      sessionId: null,
      runtimeToken: SECRET,
      _spawnImpl: impl,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain('upstream 429');
    // The body echoed the credential, so the body is dropped whole: the status is
    // the entire diagnostic, and the run loop's classifier is what acts on it.
    expect(err.message).not.toContain('insufficient_quota');
    // The point of attaching the status: the fleet stands down on the right
    // schedule instead of probing a refusing provider every 5s.
    expect(classifySpawnFailure(err)).not.toBe(SPAWN_FAILURE_CLASS.RUNTIME);
  });
});

// F235: the rejection comes before a public seat's witness, so what leaves the
// tail here is what protects a public seat too.
describe('claude adapter — a crashed turn\'s tool output names no status', () => {
  test('a tool result quoting a refusal does not reach the error', async () => {
    const tool = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'req_1 | 429: You exceeded your current quota, please check your plan and billing details.' }] },
    });
    const err = await claude.spawn('hi', {
      environment: { model: 'test-model' },
      sessionId: null,
      _spawnImpl: () => fakeChild({ stdout: `{"type":"system","subtype":"init"}\n${tool}\n`, stderr: '', code: 1 }),
    }).catch((e) => e);

    expect(err.message).toBe('claude exited with code 1');
    expect(err.status).toBeUndefined();
    expect(classifySpawnFailure(err)).toBe(SPAWN_FAILURE_CLASS.RUNTIME);
  });
});

// F178: the provider's own error code survives the keep-list as a dedicated
// field, so a caller can match on it instead of on prose.
describe('adapterFailure keeps the provider code', () => {
  test.each([
    ['a structured body', '404: {"error":{"message":"gone","code":"model_not_found"}}', 'model_not_found'],
    ['a top-level code', '400: {"code":"model_not_found","message":"gone"}', 'model_not_found'],
    ['a body embedded after a prose prefix', 'unexpected status 404 Not Found: {"error":{"message":"gone","code":"model_not_found"}}', 'model_not_found'],
  ])('from %s', (_label, text, code) => {
    expect(adapterFailure('codex', text).providerCode).toBe(code);
  });

  test.each([
    ['prose that quotes a code', 'HTTP 500: saw model_not_found in the log'],
    ['a numeric code', '429: {"error":{"message":"slow down","code":429}}'],
    ['a code outside the identifier charset', '400: {"error":{"message":"x","code":"a b <c>"}}'],
  ])('not from %s', (_label, text) => {
    expect(adapterFailure('codex', text)).not.toHaveProperty('providerCode');
  });

  test('drops a code that echoes a credential this spawn was handed', () => {
    const secret = 'sk-test-0123456789abcdef';
    expect(adapterFailure('codex', `400: {"error":{"message":"x","code":"${secret}"}}`, { credentials: [secret] }))
      .not.toHaveProperty('providerCode');
  });

  test('leaves the message, status and detail as before', () => {
    const error = adapterFailure('codex', '404: {"error":{"message":"gone","code":"model_not_found"}}', { exitCode: 1 });
    expect(error.message).toBe('codex exited with code 1 (upstream 404): gone');
    expect(error.status).toBe(404);
  });
});
