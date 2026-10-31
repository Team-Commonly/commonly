import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGrant, matchToolCall } from '../src/valet/grant.js';
import { createPermissionPolicy } from '../src/valet/permissions.js';
import * as seats from '../src/index.js';

const OPTIONS = [
  { optionId: 'opt-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'opt-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
  { optionId: 'opt-reject-always', name: 'Never', kind: 'reject_always' },
];
const request = (kind, title = 'a tool', options = OPTIONS) => ({
  sessionId: 's-1', toolCall: { toolCallId: `tc-${kind}`, title, kind }, options,
});
const recorder = () => { const events = []; return { events, emit: (type, data) => events.push({ type, data }) }; };

test('precedence is deny > ask > allow > default deny', () => {
  const grant = validateGrant({ tools: {
    allow: ['read', 'search', 'execute:git *', '*:open *'],
    ask: ['execute', 'edit:*.md'],
    deny: ['execute:git push*', 'read:*.env*', 'edit:secrets/*'],
  } });
  const table = [
    // [kind, title, decision, list, pattern]
    ['read', 'README.md', 'allow', 'allow', 'read'],
    ['read', 'config/.env.local', 'deny', 'deny', 'read:*.env*'],
    ['search', 'grep TODO', 'allow', 'allow', 'search'],
    ['execute', 'git status', 'ask', 'ask', 'execute'],
    ['execute', 'git push origin main', 'deny', 'deny', 'execute:git push*'],
    ['execute', 'npm test', 'ask', 'ask', 'execute'],
    ['edit', 'notes.md', 'ask', 'ask', 'edit:*.md'],
    ['edit', 'secrets/notes.md', 'deny', 'deny', 'edit:secrets/*'],
    ['edit', 'src/a.js', 'deny', 'default', null],
    ['fetch', 'open https://x', 'allow', 'allow', '*:open *'],
    ['delete', 'rm -rf /', 'deny', 'default', null],
    [undefined, 'mystery', 'deny', 'default', null],
    ['not-a-kind', 'open thing', 'allow', 'allow', '*:open *'],
  ];
  for (const [kind, title, decision, list, pattern] of table) {
    assert.deepEqual(matchToolCall(grant, { kind, title }), { decision, rule: { list, pattern } }, `${kind} ${title}`);
  }
  // A missing kind means ACP's `other`, and `other` can be granted like any kind.
  assert.equal(matchToolCall({ tools: { allow: ['other'] } }, { title: 'x' }).decision, 'allow');
  assert.equal(matchToolCall({}, { kind: 'read', title: 'x' }).decision, 'deny', 'an empty grant denies everything');
});

test('globs are anchored and treat regex characters literally', () => {
  const grant = { tools: { allow: ['execute:ls ?', 'read:a.b(c)'] } };
  assert.equal(matchToolCall(grant, { kind: 'execute', title: 'ls a' }).decision, 'allow');
  assert.equal(matchToolCall(grant, { kind: 'execute', title: 'ls ab' }).decision, 'deny');
  assert.equal(matchToolCall(grant, { kind: 'execute', title: 'xls a' }).decision, 'deny');
  assert.equal(matchToolCall(grant, { kind: 'read', title: 'a.b(c)' }).decision, 'allow');
  assert.equal(matchToolCall(grant, { kind: 'read', title: 'aXb(c)' }).decision, 'deny');
});

test('grant validation refuses unknown fields, bad names and bad patterns', () => {
  const bad = [
    [null, /must be an object/],
    [{ credential: [] }, /unknown field credential/],
    [{ network: { allow: ['api.x'] } }, /network rules are not enforced yet/],
    [{ tools: { allow: [], permit: [] } }, /unknown field tools\.permit/],
    [{ tools: { allow: 'read' } }, /tools\.allow must be an array/],
    [{ tools: { allow: ['write'] } }, /unknown tool kind "write"/],
    [{ tools: { deny: ['execute:'] } }, /empty title glob/],
    [{ tools: { ask: [''] } }, /non-empty string/],
    [{ credentials: [{ name: 'openai_key', from: 'env' }] }, /ENV_NAME/],
    [{ credentials: [{ name: '1KEY', from: 'env' }] }, /ENV_NAME/],
    [{ credentials: [{ name: 'KEY-X', from: 'env' }] }, /ENV_NAME/],
    [{ credentials: [{ name: 'HOME', from: 'env' }] }, /reserved/],
    [{ credentials: [{ name: 'PATH', from: 'env' }] }, /reserved/],
    [{ credentials: [{ name: 'XDG_CONFIG_HOME', from: 'env' }] }, /reserved/],
    [{ credentials: [{ name: 'KEY', from: 'keychain' }] }, /from must be one of/],
    [{ credentials: [{ name: 'KEY', from: 'env', value: 'sk-x' }] }, /unknown field credentials\[0\]\.value/],
    [{ credentials: [{ name: 'KEY', from: 'file' }] }, /absolute path/],
    [{ credentials: [{ name: 'KEY', from: 'file', ref: 'rel/key' }] }, /absolute path/],
    [{ credentials: [{ name: 'KEY', from: 'env', ref: 'lower' }] }, /ENV_NAME for from: env/],
    [{ credentials: [{ name: 'KEY', from: 'env' }, { name: 'KEY', from: 'resolver' }] }, /granted twice/],
  ];
  for (const [grant, message] of bad) assert.throws(() => validateGrant(grant), message, JSON.stringify(grant));
  const ok = validateGrant({ credentials: [{ name: 'OPENAI_API_KEY', from: 'resolver', ref: 'vault://k' }], tools: { allow: ['read'] } });
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.credentials[0]));
  assert.equal(validateGrant(ok), ok, 'a validated grant passes through');
});

test('allow selects allow_once and never allow_always', async () => {
  const trace = recorder();
  const decide = createPermissionPolicy({ tools: { allow: ['read'] } }, { trace });
  assert.deepEqual(await decide(request('read')), { outcome: 'selected', optionId: 'opt-once' });
  // Only allow_always offered: an allow rule still must not pick it.
  const onlyAlways = [OPTIONS[0], OPTIONS[2]];
  assert.deepEqual(await decide(request('read', 'x', onlyAlways)), { outcome: 'selected', optionId: 'opt-reject' });
  assert.deepEqual(await decide(request('read', 'x', [OPTIONS[0]])), { outcome: 'cancelled' });
  assert.deepEqual(trace.events[0], { type: 'permission.decided', data: {
    outcome: 'selected', optionId: 'opt-once', kind: 'allow_once', toolCallId: 'tc-read', rule: { list: 'allow', pattern: 'read' },
  } });
});

test('deny selects reject_once, or cancelled when there is no reject_once option', async () => {
  const trace = recorder();
  const decide = createPermissionPolicy({ tools: { deny: ['execute'] } }, { trace });
  assert.deepEqual(await decide(request('execute')), { outcome: 'selected', optionId: 'opt-reject' });
  assert.deepEqual(await decide(request('execute', 'x', [OPTIONS[0], OPTIONS[1], OPTIONS[3]])), { outcome: 'cancelled' });
  assert.deepEqual(await decide(request('edit')), { outcome: 'selected', optionId: 'opt-reject' }, 'default deny');
  assert.deepEqual(await decide({}), { outcome: 'cancelled' }, 'a malformed request is denied, not thrown');
  assert.deepEqual(trace.events.map((e) => [e.data.outcome, e.data.rule.list]), [
    ['selected', 'deny'], ['cancelled', 'deny'], ['selected', 'default'], ['cancelled', 'default']]);
});

const BEN = { by: 'u-ben', role: 'credential-owner' };

test('ask: approved allows once, rejected denies, and approve sees the tool call and rule', async () => {
  const seen = [];
  const trace = recorder();
  let verdict = { approved: true, ...BEN };
  const decide = createPermissionPolicy({ tools: { ask: ['execute'] } }, {
    trace, approve: async (input) => { seen.push(input); return verdict; },
  });
  const req = request('execute', 'npm test');
  assert.deepEqual(await decide(req), { outcome: 'selected', optionId: 'opt-once' });
  verdict = { approved: false, ...BEN };
  assert.deepEqual(await decide(req), { outcome: 'selected', optionId: 'opt-reject' });
  verdict = { approved: 'yes', ...BEN };
  assert.deepEqual(await decide(req), { outcome: 'selected', optionId: 'opt-reject' }, 'only literal true approves');
  assert.deepEqual(seen[0], { toolCall: req.toolCall, grantRule: { list: 'ask', pattern: 'execute' } });
  assert.deepEqual(trace.events.map((e) => [e.data.kind, e.data.approval, e.data.decidedBy]), [
    ['allow_once', 'approved', 'u-ben'], ['reject_once', 'rejected', 'u-ben'], ['reject_once', 'failed', 'policy']]);
});

test('ask: no answer in time denies; a throwing or missing approver denies', async () => {
  const trace = recorder();
  const started = Date.now();
  const slow = createPermissionPolicy({ tools: { ask: ['edit'] } }, {
    trace, approveTimeoutMs: 30, approve: () => new Promise(() => {}),
  });
  assert.deepEqual(await slow(request('edit')), { outcome: 'selected', optionId: 'opt-reject' });
  assert.ok(Date.now() - started < 1000);
  const throwing = createPermissionPolicy({ tools: { ask: ['edit'] } }, { trace, approve: () => { throw new Error('card service down'); } });
  assert.deepEqual(await throwing(request('edit')), { outcome: 'selected', optionId: 'opt-reject' });
  const none = createPermissionPolicy({ tools: { ask: ['edit'] } }, { trace });
  assert.deepEqual(await none(request('edit')), { outcome: 'selected', optionId: 'opt-reject' });
  assert.deepEqual(trace.events.map((e) => e.data.approval), ['timed_out', 'failed', 'failed']);
});

test('ask: a cancelled run answers a pending ask with cancelled', async () => {
  const controller = new AbortController();
  const trace = recorder();
  const decide = createPermissionPolicy({ tools: { ask: ['fetch'] } }, {
    trace, signal: controller.signal, approveTimeoutMs: 10_000, approve: () => new Promise(() => {}),
  });
  const pending = decide(request('fetch'));
  setTimeout(() => controller.abort(), 5);
  assert.deepEqual(await pending, { outcome: 'cancelled' });
  assert.equal(trace.events[0].data.approval, 'aborted');
});

test('the valet API is exported from the package entry', () => {
  for (const name of ['validateGrant', 'matchToolCall', 'prepareRunEnv', 'createPermissionPolicy', 'TOOL_KINDS', 'BASE_ENV_ALLOWLIST']) {
    assert.ok(name in seats, name);
  }
});
