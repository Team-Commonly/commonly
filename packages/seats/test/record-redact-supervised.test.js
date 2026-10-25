/**
 * A credential value the valet resolves for a supervised run never reaches
 * the record, even when the agent repeats it. The value travels the real
 * path: prepareRunEnv is called with the spawn ctx the supervisor hands the
 * adapter, so it registers the value through the supervisor's trace wrapper,
 * and the store scrubs it before a line is hashed or written.
 *
 * Everything is local and keyless: the fake provider answers on 127.0.0.1 and
 * the "credential" is a fake value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseRun } from '../src/supervisor.js';
import { createTraceStore } from '../src/trace/store.js';
import { prepareRunEnv } from '../src/valet/env.js';
import { createPermissionPolicy } from '../src/valet/permissions.js';
import { toOtlpJson } from '../src/record/otel.js';
import { runFailure } from '../src/failures.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

const CANARY = 'sk-test-CANARY-7f3a91c2d4e5b6a8';
const KEY_NAME = 'FAKE_PROVIDER_KEY';
const GRANT = { credentials: [{ name: KEY_NAME, from: 'resolver' }], tools: { allow: ['read'], ask: ['fetch'] } };
const AGENT = { type: 'agent', id: 'u-agent-redact', owner: 'u-owner-redact', name: 'Redact test agent' };
const OWNER = { id: 'u-owner-redact', role: 'agent-owner' };
// The kinds the adapter writes itself, naming its actor. permission.* are the valet's.
const AGENT_KINDS = new Set(['agent.message_chunk', 'tool.call', 'tool.update', 'result.reported']);

// The store's redaction is exact-match on known values (docs/record-v1.md §3,
// rule 1): a value the agent transforms, such as base64, is not claimed and
// is not asserted here. The canary is all unreserved characters, so its
// URL-encoded and JSON-escaped forms are the value itself; the check names
// them anyway so a change of canary cannot quietly drop them.
const FORMS = Object.freeze({
  raw: CANARY,
  urlEncoded: encodeURIComponent(CANARY),
  jsonEscaped: JSON.stringify(CANARY).slice(1, -1),
});
const assertAbsent = (text, where) => {
  for (const [form, value] of Object.entries(FORMS)) {
    assert.equal(text.includes(value), false, `the ${form} credential value appears in ${where}`);
  }
};

const allFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => join(d.parentPath ?? d.path, d.name));

/** The text an OpenAI-style SSE stream carried, one string per content delta. */
const sseDeltas = async (response) => {
  const body = await response.text();
  return body.split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content)
    .filter((text) => typeof text === 'string' && text.length > 0);
};

/**
 * An adapter that does what a CLI adapter does with a granted key: asks the
 * valet for its env, calls the provider with it, and streams what comes back.
 * The provider is scripted to echo the key, so the key lands in agent text, a
 * tool result, the question the valet's permission policy records, and the
 * final result.
 */
const echoingAdapter = ({ baseURL, envRoot, fail, seen }) => ({
  name: 'echo-fake',
  providerKeyEnv: KEY_NAME,
  async spawn(prompt, ctx) {
    const prepared = await prepareRunEnv({
      grant: GRANT, resolveSecret: async () => CANARY, root: envRoot, ctx, require: [KEY_NAME],
    });
    try {
      const key = prepared.env[KEY_NAME];
      seen.key = key;
      const as = { actor: AGENT };
      ctx.trace.emit('turn.prompt_sent', { chars: prompt.length });
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'fake-model', stream: true, messages: [{ role: 'user', content: `[[reply:the key is ${key}]]` }] }),
      });
      const deltas = await sseDeltas(response);
      seen.reply = deltas.join('');
      // Force the known value across record writes, including one-character deltas.
      for (const delta of deltas) for (const text of delta) ctx.trace.emit('agent.message_chunk', { text }, as);
      ctx.trace.emit('tool.call', {
        toolCallId: 'tc-1', title: `printenv ${KEY_NAME}`, kind: 'execute', status: 'pending', surface: 'native',
      }, as);
      ctx.trace.emit('tool.update', { toolCallId: 'tc-1', status: 'completed', title: `${KEY_NAME}=${key}` }, as);
      const decide = createPermissionPolicy(GRANT, {
        trace: ctx.trace, askedOf: OWNER, approve: async () => ({ approved: true, by: OWNER.id, role: OWNER.role }),
      });
      const answer = await decide({
        toolCall: { toolCallId: 'tc-2', title: `Send ${key} to the deploy hook?`, kind: 'fetch', rawInput: { token: key } },
        options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }],
      });
      seen.answer = answer;
      if (fail) throw runFailure('exited', `the CLI exited after printing ${key}`);
      ctx.trace.emit('agent.message_chunk', { text: `Done. I used ${key}.` }, as);
      ctx.trace.emit('result.reported', { status: 'done', refs: [{ type: 'note', id: `used-${key}` }] }, as);
      return { text: seen.reply };
    } finally {
      await prepared.cleanup();
    }
  },
});

const withHarness = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-redact-sup-'));
  const fake = await startFakeProvider();
  try {
    const traceRoot = join(root, 'trace');
    return await fn({ fake, root, traceRoot, store: createTraceStore({ root: traceRoot }) });
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
};

for (const fail of [false, true]) {
  test(`a granted credential the agent echoes never reaches the record or its export (${fail ? 'failed' : 'ok'} run)`, () => withHarness(async ({
    fake, root, traceRoot, store,
  }) => {
    const seen = {};
    const out = await superviseRun({
      adapter: echoingAdapter({ baseURL: fake.baseURL, envRoot: root, fail, seen }),
      prompt: 'deploy it',
      store,
      policy: { stallMs: 0, timeoutMs: 0 },
    });

    // Positive controls: the value really reached the run and the agent really repeated it.
    assert.equal(seen.key, CANARY, 'the valet resolved the planted value into the run env');
    assert.ok(seen.reply.includes(CANARY), 'the provider echoed the value back as agent text');
    assert.deepEqual(fake.requests.map((r) => r.authorization), ['present']);
    assert.equal(out.outcome, fail ? 'failed' : 'ok');
    if (fail) assert.ok(out.failure.detail.includes(CANARY), 'the failure the run settled on quoted the value');

    // Every byte the store wrote: the run file and the index.
    const files = allFiles(traceRoot);
    assert.deepEqual(files.map((f) => f.slice(traceRoot.length + 1)).sort(), ['index.jsonl', `runs/${out.runId}.jsonl`]);
    const bytes = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    assertAbsent(bytes, 'the record files');

    const entries = store.readRun(out.runId);
    // The export reads what the store hands back, so it is checked on its own,
    // before anything else about those entries.
    const otlp = JSON.stringify(toOtlpJson(entries));
    assertAbsent(otlp, 'the OTLP export');
    assert.ok(otlp.includes('[redacted]'), 'positive control: a scrubbed field reached the export');
    assert.ok(otlp.includes('seats.question'), 'positive control: the permission question reached the export');
    assert.ok(otlp.includes('Send [redacted] to the deploy hook?'), 'the exported question is the scrubbed one');

    const byKind = (kind) => entries.filter((e) => e.kind === kind);
    // Each place the value was planted holds the marker instead, so its absence above is a scrub, not a drop.
    assert.ok(byKind('agent.message_chunk').some((e) => e.data.text.includes('[redacted]')), 'agent text was scrubbed');
    assert.equal(byKind('tool.update')[0].data.title, `${KEY_NAME}=[redacted]`, 'the tool result was scrubbed');
    const [asked] = byKind('permission.requested');
    assert.equal(asked.data.question, 'Send [redacted] to the deploy hook?', 'the permission question was scrubbed');
    assert.deepEqual(asked.data.askedOf, OWNER);
    assert.match(asked.data.argsDigest, /^sha256:[0-9a-f]{64}$/, 'the arguments are recorded as a digest only');
    assert.deepEqual(seen.answer, { outcome: 'selected', optionId: 'allow' });
    const [settled] = byKind('run.settled');
    if (fail) {
      assert.equal(settled.data.failure.detail, 'the CLI exited after printing [redacted]', 'the final failure was scrubbed');
      const indexRow = readFileSync(join(traceRoot, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((r) => r.outcome);
      assert.equal(indexRow.failure.detail, 'the CLI exited after printing [redacted]', 'the index row was scrubbed');
    } else {
      assert.equal(byKind('result.reported')[0].data.refs[0].id, 'used-[redacted]', 'the final result was scrubbed');
      assert.ok(byKind('agent.message_chunk').some((e) => e.data.text === 'Done. I used [redacted].'));
    }
    assert.deepEqual(byKind('credential.granted')[0].data, { names: [KEY_NAME] }, 'the valet recorded the name through the wrapper');

    // Scrubbed before hashing: the chain over the scrubbed lines is intact.
    const verified = store.verifyRun(out.runId);
    assert.equal(verified.ok, true, JSON.stringify(verified.errors));
    assert.equal(verified.entries, entries.length);

    // The adapter's own entries carry the actor it named.
    const agentEntries = entries.filter((e) => AGENT_KINDS.has(e.kind));
    assert.ok(agentEntries.length >= (fail ? 3 : 5), `${agentEntries.length} adapter entries`);
    for (const entry of agentEntries) assert.deepEqual(entry.actor, AGENT, `actor on ${entry.kind} #${entry.seq}`);
  }));
}
