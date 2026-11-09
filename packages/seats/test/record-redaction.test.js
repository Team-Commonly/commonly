import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEntry, canonicalLine, commitId, hashLine, isCommitment, readRecord, verifyRecord,
} from '../src/record/format.js';

const ENV = { runId: 'run-view-0001', podId: 'pod-a' };
const SALT = 'a'.repeat(32);
const at = (n) => `2026-11-06T12:00:0${n}.000Z`;
const grantLine = (prev, n, salt) => appendEntry(prev, {
  ...ENV, ts: at(n), kind: 'permission.decided', ...(salt ? { salt } : {}),
  data: { outcome: 'selected', toolCallId: 'tc-1', rule: { list: 'ask', pattern: null }, decidedBy: 'u-ben', decidedByRole: 'credential-owner' },
});
const toolLine = (prev, n, salt) => appendEntry(prev, {
  ...ENV, ts: at(n), kind: 'tool.update', actor: { type: 'agent', id: 'u-agent' }, ...(salt ? { salt } : {}), data: { toolCallId: 'tc-1', status: 'completed' },
});
// What a server serves in place of a stored line it withholds a field of.
const redact = (line, { hash, prev } = {}) => {
  const entry = JSON.parse(line);
  delete entry.salt;
  entry.actor = { type: 'human', id: 'redacted' };
  entry.data.decidedBy = 'redacted';
  return canonicalLine({
    ...entry,
    prev: prev === undefined ? entry.prev : prev,
    redaction: { fields: ['actor.id', 'data.decidedBy'], hash: hash === undefined ? hashLine(line) : hash },
  });
};
const text = (lines) => lines.map((line) => `${line}\n`).join('');

test('a salt is an optional envelope field, and a plain line is byte-identical without it', () => {
  const plain = toolLine(null, 1);
  assert.equal(Object.hasOwn(JSON.parse(plain), 'salt'), false);
  const salted = toolLine(null, 1, SALT);
  assert.equal(JSON.parse(salted).salt, SALT);
  assert.deepEqual(verifyRecord(text([salted])).errors, []);
  assert.throws(() => toolLine(null, 1, 'short'), /salt/);
  assert.deepEqual(verifyRecord(text([canonicalLine({ ...JSON.parse(salted), salt: 'nope' })])).errors.map((e) => e.detail), ['salt']);
});

test('a record with no redacted line reports exactly what it always did', () => {
  const lines = [toolLine(null, 1, SALT)];
  assert.deepEqual(Object.keys(verifyRecord(text(lines))).sort(), ['entries', 'errors', 'head', 'ok', 'settled']);
});

test('the chain runs through a salted redacted line: nothing fails, and the report says which line was taken on trust', () => {
  const one = toolLine(null, 1, SALT);
  const two = grantLine(one, 2, SALT);
  const three = toolLine(two, 3, SALT);
  const result = verifyRecord(text([one, redact(two), three]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.redacted, [2]);
  assert.deepEqual(result.unlinked, []);
  assert.equal(result.head, hashLine(three));
});

test('a stored edit under a redacted line still shows: its hash no longer matches the line after it', () => {
  const one = toolLine(null, 1, SALT);
  const two = grantLine(one, 2, SALT);
  const three = toolLine(two, 3, SALT);
  const edited = two.replace('u-ben', 'u-eve');
  const result = verifyRecord(text([one, redact(edited), three]));
  assert.deepEqual(result.errors.map(({ seq, reason }) => `${seq}:${reason}`), ['3:prev_mismatch']);
});

test('a line whose hash can be guessed at carries none, and the file still verifies, unlinked from there', () => {
  const one = toolLine(null, 1);
  const two = grantLine(one, 2);
  const three = toolLine(two, 3);
  const four = toolLine(three, 4, SALT);
  const five = toolLine(four, 5, SALT);
  const unlinkedThree = canonicalLine({ ...JSON.parse(three), prev: null, redaction: { fields: [], hash: null } });
  const resumed = (() => {
    const { salt: _salt, ...entry } = JSON.parse(four);
    return canonicalLine({ ...entry, prev: null, redaction: { fields: [], hash: hashLine(four) } });
  })();
  const result = verifyRecord(text([one, redact(two, { hash: null }), unlinkedThree, resumed, five]));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.redacted, [2, 3, 4]);
  assert.deepEqual(result.unlinked, [2, 3]);
  assert.equal(result.head, hashLine(five));
});

test('a line after an unlinked one that claims a link is reported, and a malformed marker is refused', () => {
  const one = toolLine(null, 1);
  const two = grantLine(one, 2);
  const three = toolLine(two, 3);
  assert.deepEqual(verifyRecord(text([one, redact(two, { hash: null }), three])).errors.map(({ seq, reason }) => `${seq}:${reason}`), ['3:prev_mismatch']);
  const bad = canonicalLine({ ...JSON.parse(one), redaction: { fields: 'all', hash: 'x' } });
  assert.deepEqual(verifyRecord(text([bad])).errors.map((e) => e.detail), ['redaction']);
});

// Section 9: the id lives beside the hashed bytes, so it can be deleted.
const committed = (prev, n, token) => appendEntry(prev, {
  ...ENV, ts: at(n), kind: 'permission.decided',
  data: { outcome: 'selected', toolCallId: 'tc-1', rule: { list: 'ask', pattern: null }, decidedBy: token, decidedByRole: 'credential-owner' },
});
const openLine = (line, openings) => canonicalLine({ ...JSON.parse(line), openings });

test('a commitment passes for an id token, and differs per salt and per id', () => {
  const token = commitId('u-ben', SALT);
  assert.equal(isCommitment(token), true);
  assert.equal(isCommitment('u-ben'), false);
  assert.notEqual(token, commitId('u-ben', 'b'.repeat(32)));
  assert.notEqual(token, commitId('u-eve', SALT));
  assert.throws(() => commitId('u-ben', 'short'), /salt/);
  const line = committed(null, 1, token);
  assert.equal(JSON.parse(line).actor.id, token);
  assert.deepEqual(verifyRecord(text([line])).errors, []);
});

test('with no opening the line is the stored bytes, and the check is whole, not partial', () => {
  const one = committed(null, 1, commitId('u-ben', SALT));
  const two = toolLine(one, 2);
  const result = verifyRecord(text([one, two]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.partial, undefined);
  assert.equal(result.head, hashLine(two));
});

test('an opened line verifies against the stored bytes, and reads as the id', () => {
  const token = commitId('u-ben', SALT);
  const one = committed(null, 1, token);
  const two = toolLine(one, 2);
  const served = text([openLine(one, { [token]: { id: 'u-ben', salt: SALT } }), two]);
  const result = verifyRecord(served);
  assert.deepEqual(result.errors, []);
  assert.equal(result.partial, undefined);
  const [entry] = readRecord(served);
  assert.equal(entry.data.decidedBy, 'u-ben');
  assert.equal(entry.actor.id, 'u-ben');
  assert.equal(entry.openings, undefined);
});

test('an opening that does not match its commitment is reported, and a malformed one refused', () => {
  const token = commitId('u-ben', SALT);
  const one = committed(null, 1, token);
  assert.deepEqual(verifyRecord(text([openLine(one, { [token]: { id: 'u-eve', salt: SALT } })])).errors.map(({ seq, reason }) => `${seq}:${reason}`), ['1:bad_opening']);
  assert.deepEqual(verifyRecord(text([openLine(one, { [token]: { id: 'u-ben' } })])).errors.map((e) => e.detail), ['openings']);
});

test('an opening for a commitment not on the line is reported; one on the line is not', () => {
  const token = commitId('u-ben', SALT);
  const other = commitId('u-eve', 'b'.repeat(32));
  const one = committed(null, 1, token);
  assert.deepEqual(verifyRecord(text([openLine(one, { [token]: { id: 'u-ben', salt: SALT } })])).errors, []);
  assert.deepEqual(verifyRecord(text([openLine(one, { [other]: { id: 'u-eve', salt: 'b'.repeat(32) } })])).errors.map(({ seq, reason }) => `${seq}:${reason}`), ['1:stray_opening']);
});

test('an edit under an opened line still shows at the next line', () => {
  const token = commitId('u-ben', SALT);
  const one = committed(null, 1, token);
  const two = toolLine(one, 2);
  const edited = openLine(one.replace('tc-1', 'tc-9'), { [token]: { id: 'u-ben', salt: SALT } });
  assert.deepEqual(verifyRecord(text([edited, two])).errors.map(({ seq, reason }) => `${seq}:${reason}`), ['2:prev_mismatch']);
});

test('a plain line written by a seat keeps its id and verifies as it always did', () => {
  const plain = grantLine(null, 1);
  assert.equal(JSON.parse(plain).data.decidedBy, 'u-ben');
  assert.deepEqual(Object.keys(verifyRecord(text([plain]))).sort(), ['entries', 'errors', 'head', 'ok', 'settled']);
});

test('a salt is a string: an array that prints like one is refused by the writer and the reader', () => {
  const salted = toolLine(null, 1, SALT);
  assert.deepEqual(verifyRecord(text([salted])).errors, []);
  assert.throws(() => toolLine(null, 1, [SALT]), /salt must be 32 lowercase hex/);
  assert.throws(() => commitId('u-ben', [SALT]), /salt must be 32 lowercase hex/);
  const entry = JSON.parse(salted);
  const array = canonicalLine({ ...entry, salt: [SALT] });
  assert.deepEqual(verifyRecord(text([array])).errors.map((e) => e.detail), ['salt']);
});

test('an opening whose salt is an array is malformed, and is not checked as an opening', () => {
  const token = commitId('u-ben', SALT);
  const opened = openLine(committed(null, 1, token), { [token]: { id: 'u-ben', salt: [SALT] } });
  assert.deepEqual(verifyRecord(text([opened])).errors.map((e) => e.detail), ['openings']);
});

test('a line with openings that cannot be serialized is reported, and the check carries on', () => {
  const token = commitId('u-ben', SALT);
  const one = committed(null, 1, token);
  const opened = JSON.stringify({ ...JSON.parse(one), openings: { [token]: { id: 'u-ben', salt: SALT } } }).replace('"tc-1"', '1e999');
  const two = toolLine(one, 2);
  const result = verifyRecord(text([opened, two]));
  assert.equal(result.errors.filter((e) => e.seq === 1 && e.reason === 'not_canonical').length, 1);
  assert.equal(result.entries, 2);
});
