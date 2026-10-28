import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FAILURE_KINDS, RunFailure } from '../src/failures.js';
import {
  EXIT_OK, EXIT_FAILED, EXIT_USAGE, FAILURE_EXIT_CODES, UNNAMED_FAILURE,
  exitCodeForKind, exitCodeOf, failureLine, exitCodeTable,
} from '../src/exit-codes.js';
import {
  kindOfAdapterError, isMissingBinary, CONTENT_REFUSED_RE, NOT_AUTHENTICATED_RE, MISSING_BINARY_RE,
} from '../src/failure-text.js';
import * as seats from '../src/index.js';

// The guard the README promises: a new failure kind cannot ship without a code.
test('every FAILURE_KINDS key has an exit code', () => {
  const missing = Object.keys(FAILURE_KINDS).filter((kind) => !Object.hasOwn(FAILURE_EXIT_CODES, kind));
  assert.deepEqual(missing, [], `give these kinds an exit code in src/exit-codes.js: ${missing.join(', ')}`);
});

test('no exit code names a kind that does not exist', () => {
  const orphans = Object.keys(FAILURE_EXIT_CODES).filter((kind) => !Object.hasOwn(FAILURE_KINDS, kind));
  assert.deepEqual(orphans, []);
});

test('codes are distinct, clear of 0-2, and clear of the shell\'s own range', () => {
  const codes = Object.values(FAILURE_EXIT_CODES);
  assert.equal(new Set([...codes, EXIT_OK, EXIT_FAILED, EXIT_USAGE]).size, codes.length + 3);
  for (const [kind, code] of Object.entries(FAILURE_EXIT_CODES)) {
    assert.ok(Number.isInteger(code), kind);
    assert.ok(code > EXIT_USAGE, `${kind} takes ${code}, inside 0-2`);
    // 126/127 are the shell's; 128+n is "killed by signal n". Only cancelled
    // sits there, at the Ctrl-C code a shell itself reports.
    assert.ok(code < 126 || (kind === 'cancelled' && code === 130), `${kind} takes ${code}`);
  }
});

test('the codes the README documents are fixed: a code is a contract', () => {
  assert.deepEqual({ ...FAILURE_EXIT_CODES }, {
    stuck: 10, timeout: 11, exited: 12, protocol: 13, refusal: 14, refusal_dropped: 15,
    refusal_retry_loop: 16, provider_unavailable: 17, max_tokens: 18, max_turn_requests: 19,
    credential_denied: 20, unsupported: 21, not_installed: 22, not_authenticated: 23,
    quota: 24, provider_unsupported: 25, capacity: 26, cancelled: 130,
  });
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_FAILED, 1);
  assert.equal(EXIT_USAGE, 2);
});

test('the named kinds the brief asked for each have their own code', () => {
  for (const kind of ['refusal_retry_loop', 'provider_unavailable', 'refusal_dropped', 'not_installed', 'not_authenticated']) {
    assert.ok(Object.hasOwn(FAILURE_KINDS, kind), kind);
    assert.notEqual(exitCodeForKind(kind), EXIT_FAILED, kind);
  }
});

test('exitCodeOf maps a settled run, whatever shape its failure takes', () => {
  assert.equal(exitCodeOf({ outcome: 'ok' }), 0);
  assert.equal(exitCodeOf({ outcome: 'stuck', failure: new RunFailure('stuck', 'quiet') }), 10);
  assert.equal(exitCodeOf({ outcome: 'failed', failure: { kind: 'refusal' } }), 14);
  assert.equal(exitCodeOf({ outcome: 'cancelled', failure: new RunFailure('cancelled') }), 130);
  assert.equal(exitCodeOf({ outcome: 'failed', failure: new Error('bare') }), EXIT_FAILED);
  assert.equal(exitCodeOf({ outcome: 'failed', failure: { kind: 'no-such-kind' } }), EXIT_FAILED);
  assert.equal(exitCodeOf({ outcome: 'failed' }), EXIT_FAILED);
  assert.equal(exitCodeForKind(null), EXIT_FAILED);
  assert.equal(exitCodeForKind('toString'), EXIT_FAILED, 'a prototype key is not a kind');
});

test('failureLine is `<prog>: <kind>: <meaning>`, and names an unnamed failure plainly', () => {
  for (const [kind, { meaning }] of Object.entries(FAILURE_KINDS)) {
    assert.equal(failureLine(kind), `jellymoon: ${kind}: ${meaning}`);
    assert.doesNotMatch(failureLine(kind), /\n/);
  }
  assert.equal(failureLine(null), `jellymoon: failed: ${UNNAMED_FAILURE.meaning}`);
  assert.equal(failureLine('constructor'), `jellymoon: failed: ${UNNAMED_FAILURE.meaning}`);
  assert.equal(failureLine('stuck', { prog: 'x' }), `x: stuck: ${FAILURE_KINDS.stuck.meaning}`);
});

test('the exit-code table lists every code once, in order, with its meaning', () => {
  const table = exitCodeTable();
  assert.deepEqual(table.map((row) => row.code), [...table.map((row) => row.code)].sort((a, b) => a - b));
  assert.deepEqual(table.slice(0, 3).map((row) => row.name), ['ok', 'failed', 'usage']);
  for (const kind of Object.keys(FAILURE_KINDS)) {
    const row = table.find((entry) => entry.name === kind);
    assert.equal(row?.code, FAILURE_EXIT_CODES[kind], kind);
    assert.equal(row.meaning, FAILURE_KINDS[kind].meaning, kind);
  }
});

test('the README exit-code table matches the source, row for row', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const documented = [...readme.matchAll(/^\| (\d+) \| `([a-z_]+)` \| (.+) \|$/gm)]
    .map(([, code, name, meaning]) => ({ code: Number(code), name, meaning }));
  assert.deepEqual(documented, exitCodeTable());
});

test('kindOfAdapterError names a bare adapter Error only where its text names a kind', () => {
  const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT', syscall: 'spawn codex' });
  assert.equal(isMissingBinary(enoent), true);
  assert.equal(kindOfAdapterError(enoent), 'not_installed');
  // An ENOENT for a file the CLI opened is not a missing CLI.
  const fileMissing = Object.assign(new Error('ENOENT: no such file, open /x'), { code: 'ENOENT', syscall: 'open' });
  assert.equal(isMissingBinary(fileMissing), false);
  assert.equal(kindOfAdapterError(fileMissing), null);

  assert.equal(kindOfAdapterError(new Error('codex turn failed: This content was flagged for possible cybersecurity risk.')), 'refusal');
  assert.equal(kindOfAdapterError(Object.assign(new Error('claude exited 1'), { stderr: 'Error: not logged in' })), 'not_authenticated');
  assert.equal(kindOfAdapterError(Object.assign(new Error('provider said no'), { status: 401 })), 'not_authenticated');
  assert.equal(kindOfAdapterError(new Error('opencode: 403 Forbidden')), 'not_authenticated');
  assert.equal(kindOfAdapterError(new Error('goose adapter: timed out after 900000ms')), 'timeout');
  // A refusal wins over an auth word in the same text.
  assert.equal(kindOfAdapterError(new Error('403: content_policy_violation')), 'refusal');
  assert.equal(kindOfAdapterError(new Error('claude exited with code 1')), null);
  assert.equal(kindOfAdapterError(null), null);
});

test('the run loop and the standalone runner read the same wordings', () => {
  assert.equal(seats.CONTENT_REFUSED_RE, CONTENT_REFUSED_RE);
  assert.equal(seats.NOT_AUTHENTICATED_RE, NOT_AUTHENTICATED_RE);
  assert.equal(seats.MISSING_BINARY_RE, MISSING_BINARY_RE);
  assert.equal(seats.exitCodeOf, exitCodeOf);
});
