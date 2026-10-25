/**
 * One conformance suite for both brokers. Run with BROKER=ts or BROKER=go:
 *   BROKER=go node --test conformance/
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREDENTIAL, grant, newToken, sleep, startBroker, startBrokerExpectingExit, startUpstream, transcript, waitFor,
} from './harness.js';

// The suite's own canonical form; both brokers must produce the same digest.
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const digest = (args) => createHash('sha256').update(canonical(args)).digest('hex');
const auditLines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const resultText = (res) => res.json.result.content.map((c) => c.text).join('');

let upstream;
before(async () => { upstream = await startUpstream(); });
after(async () => {
  await upstream.stop(); // first, so a failed assertion below cannot leave it running
  // Global leak check: nothing the broker ever returned names the credential.
  for (const x of transcript) {
    assert.ok(!x.text.includes(CREDENTIAL), `credential leaked in body of ${x.path}`);
    assert.ok(!x.headers.includes(CREDENTIAL), `credential leaked in headers of ${x.path}`);
  }
  assert.ok(transcript.length > 30, 'the leak scan saw the whole suite');
});

describe('protocol', () => {
  const g = grant();
  let b;
  before(async () => { b = await startBroker({ upstream, grants: [g] }); });
  after(() => b.stop());

  test('initialize answers with server info and a supported version', async () => {
    const res = await b.rpc(g.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.result.protocolVersion, '2025-06-18');
    assert.equal(res.json.result.serverInfo.name, 'grants-broker');
    assert.deepEqual(res.json.result.capabilities.tools, { listChanged: false });
  });

  test('an unknown protocol version is answered with the latest supported', async () => {
    const res = await b.rpc(g.token, 'initialize', { protocolVersion: '1999-01-01' });
    assert.equal(res.json.result.protocolVersion, '2025-06-18');
  });

  test('a notification is accepted without a body', async () => {
    const res = await b.exchange('/mcp', { token: g.token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(res.status, 202);
    assert.equal(res.text, '');
  });

  test('missing or unknown bearer token is 401', async () => {
    assert.equal((await b.rpc(undefined, 'initialize', {})).status, 401);
    const res = await b.rpc(newToken(), 'tools/list');
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, -32001);
  });

  test('malformed JSON is a parse error, a batch is an invalid request, an unknown method is -32601', async () => {
    const bad = await b.exchange('/mcp', { token: g.token, rawBody: '{"jsonrpc":' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, -32700);
    const batch = await b.exchange('/mcp', { token: g.token, body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }] });
    assert.equal(batch.status, 400);
    assert.equal(batch.json.error.code, -32600);
    const unknown = await b.rpc(g.token, 'resources/list');
    assert.equal(unknown.json.error.code, -32601);
  });

  test('GET /mcp is 405: no SSE stream is offered', async () => {
    assert.equal((await b.exchange('/mcp', { method: 'GET', token: g.token })).status, 405);
  });
});

describe('grant scope', () => {
  const g = grant({ tools: ['read_issue', 'list_issues', 'create_issue'], approve: ['create_issue'] });
  let b;
  before(async () => { b = await startBroker({ upstream, grants: [g] }); });
  after(() => b.stop());

  test('tools/list returns only granted tools, in upstream order', async () => {
    const res = await b.rpc(g.token, 'tools/list');
    assert.deepEqual(res.json.result.tools.map((t) => t.name), ['read_issue', 'list_issues', 'create_issue']);
    assert.ok(res.json.result.tools[0].inputSchema, 'definitions pass through');
  });

  test('an ungranted tool is refused with a JSON-RPC error and never reaches upstream', async () => {
    const before = (await upstream.seen()).calls.delete_repo || 0;
    const res = await b.rpc(g.token, 'tools/call', { name: 'delete_repo', arguments: {} });
    assert.equal(res.json.error.code, -32003);
    assert.equal(res.json.error.data.reason, 'not_granted');
    assert.equal(res.json.result, undefined);
    assert.equal((await upstream.seen()).calls.delete_repo || 0, before);
  });

  test('a granted tool is forwarded with the broker credential, not the grant token', async () => {
    const res = await b.rpc(g.token, 'tools/call', { name: 'read_issue', arguments: { number: 7 } });
    assert.deepEqual(JSON.parse(resultText(res)), { tool: 'read_issue', args: { number: 7 } });
    const seen = await upstream.seen();
    assert.ok(seen.credentialOk > 0);
    assert.ok(!seen.otherAuth.some((a) => a.includes(g.token)), 'grant token travelled upstream');
  });

  test('an upstream that reflects the credential has it redacted', async () => {
    const res = await b.rpc(g.token, 'tools/call', { name: 'read_issue', arguments: { number: 1, echoAuth: true } });
    const body = JSON.parse(resultText(res));
    assert.equal(body.auth, 'Bearer [redacted]');
    assert.ok(!res.text.includes(CREDENTIAL));
  });

  test('bad tools/call params are -32602', async () => {
    const res = await b.rpc(g.token, 'tools/call', { name: 'read_issue', arguments: [1] });
    assert.equal(res.json.error.code, -32602);
  });
});

describe('approval', () => {
  const g = grant({ tools: ['read_issue', 'create_issue'], approve: ['create_issue'] });
  let b;
  before(async () => { b = await startBroker({ upstream, grants: [g], approvalTimeoutMs: 600 }); });
  after(() => b.stop());

  const pendingFor = (title) => waitFor(async () => {
    const res = await b.admin('GET', '/approvals');
    return res.json.approvals.find((a) => a.arguments?.title === title);
  });

  test('a held call is listed, then forwarded on allow', async () => {
    const before = (await upstream.seen()).calls.create_issue || 0;
    const call = b.rpc(g.token, 'tools/call', { name: 'create_issue', arguments: { title: 'allow-me' } });
    const pending = await pendingFor('allow-me');
    assert.equal(pending.runId, g.runId);
    assert.equal(pending.tool, 'create_issue');
    assert.equal(pending.argsDigest, digest({ title: 'allow-me' }));
    assert.equal((await upstream.seen()).calls.create_issue || 0, before, 'not forwarded while held');
    const decided = await b.admin('POST', `/approvals/${pending.id}`, { decision: 'allow' });
    assert.equal(decided.status, 200);
    const res = await call;
    assert.equal(JSON.parse(resultText(res)).args.title, 'allow-me');
    assert.equal((await upstream.seen()).calls.create_issue, before + 1);
  });

  test('deny refuses the call and it never reaches upstream', async () => {
    const before = (await upstream.seen()).calls.create_issue || 0;
    const call = b.rpc(g.token, 'tools/call', { name: 'create_issue', arguments: { title: 'deny-me' } });
    const pending = await pendingFor('deny-me');
    await b.admin('POST', `/approvals/${pending.id}`, { decision: 'deny' });
    const res = await call;
    assert.equal(res.json.error.data.reason, 'approval_denied');
    assert.equal((await upstream.seen()).calls.create_issue || 0, before);
    const listed = await b.admin('GET', '/approvals');
    assert.ok(!listed.json.approvals.some((a) => a.id === pending.id), 'decided approvals leave the list');
  });

  test('no decision before the timeout denies', async () => {
    const started = Date.now();
    const res = await b.rpc(g.token, 'tools/call', { name: 'create_issue', arguments: { title: 'wait-me' } });
    assert.equal(res.json.error.data.reason, 'approval_timeout');
    assert.ok(Date.now() - started >= 550, 'held for the timeout');
    assert.equal((await b.admin('GET', '/approvals')).json.approvals.length, 0);
  });

  test('admin endpoints need the admin token, a known id and a valid decision', async () => {
    assert.equal((await b.exchange('/approvals', { method: 'GET', token: g.token })).status, 401);
    assert.equal((await b.exchange('/approvals', { method: 'GET' })).status, 401);
    assert.equal((await b.admin('POST', '/approvals/nope', { decision: 'allow' })).status, 404);
    const call = b.rpc(g.token, 'tools/call', { name: 'create_issue', arguments: { title: 'bad-decision' } });
    const pending = await pendingFor('bad-decision');
    assert.equal((await b.admin('POST', `/approvals/${pending.id}`, { decision: 'maybe' })).status, 400);
    await b.admin('POST', `/approvals/${pending.id}`, { decision: 'deny' });
    await call;
    assert.equal((await b.admin('POST', `/approvals/${pending.id}`, { decision: 'allow' })).status, 404, 'a decided approval cannot be re-decided');
  });

  test('the approval list carries no credential', async () => {
    const call = b.rpc(g.token, 'tools/call', { name: 'create_issue', arguments: { title: 'scan-me' } });
    await pendingFor('scan-me');
    const listed = await b.admin('GET', '/approvals');
    assert.ok(!listed.text.includes(CREDENTIAL));
    await call; // let it time out
  });
});

describe('expiry and maxCalls', () => {
  const expired = grant({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
  const limited = grant({ tools: ['read_issue'], approve: [], maxCalls: 2 });
  const racing = grant({ tools: ['list_issues'], approve: [], maxCalls: 5 });
  let b;
  before(async () => { b = await startBroker({ upstream, grants: [expired, limited, racing] }); });
  after(() => b.stop());

  test('an expired grant refuses calls and lists', async () => {
    const call = await b.rpc(expired.token, 'tools/call', { name: 'read_issue', arguments: {} });
    assert.equal(call.json.error.data.reason, 'expired');
    const list = await b.rpc(expired.token, 'tools/list');
    assert.equal(list.json.error.data.reason, 'expired');
  });

  test('a grant created through the admin call works, then expires', async () => {
    const g = grant({ approve: [], expiresAt: new Date(Date.now() + 700).toISOString() });
    const created = await b.admin('POST', '/grants', g);
    assert.equal(created.status, 201);
    assert.equal(created.json.runId, g.runId);
    assert.equal((await b.admin('POST', '/grants', g)).status, 409, 'a token is unique');
    assert.equal((await b.admin('POST', '/grants', { ...g, token: newToken(), maxCalls: 0 })).status, 400);
    const ok = await b.rpc(g.token, 'tools/call', { name: 'read_issue', arguments: { number: 2 } });
    assert.ok(ok.json.result);
    await sleep(800);
    const late = await b.rpc(g.token, 'tools/call', { name: 'read_issue', arguments: { number: 2 } });
    assert.equal(late.json.error.data.reason, 'expired');
  });

  test('maxCalls admits exactly that many calls', async () => {
    for (let i = 0; i < 2; i += 1) {
      assert.ok((await b.rpc(limited.token, 'tools/call', { name: 'read_issue', arguments: { number: i } })).json.result);
    }
    const third = await b.rpc(limited.token, 'tools/call', { name: 'read_issue', arguments: { number: 3 } });
    assert.equal(third.json.error.data.reason, 'max_calls');
    assert.equal((await b.rpc(limited.token, 'tools/list')).json.error.data.reason, 'max_calls');
  });

  test('concurrent calls cannot overspend maxCalls', async () => {
    const before = (await upstream.seen()).calls.list_issues || 0;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => b.rpc(racing.token, 'tools/call', { name: 'list_issues', arguments: { state: `s${i}` } })));
    assert.equal(results.filter((r) => r.json.result).length, 5);
    assert.equal(results.filter((r) => r.json.error?.data?.reason === 'max_calls').length, 15);
    assert.equal((await upstream.seen()).calls.list_issues, before + 5);
  });

  test('a malformed grant in the config stops startup with exit 2', async () => {
    assert.equal(await startBrokerExpectingExit({ upstream, grants: [{ ...grant(), expiresAt: 'tomorrow' }] }), 2);
    assert.equal(await startBrokerExpectingExit({ upstream, grants: [{ ...grant(), token: 'short' }] }), 2);
  });
});

describe('audit log', () => {
  const g = grant({ tools: ['read_issue', 'create_issue'], approve: ['create_issue'], maxCalls: 3 });
  const marker = 'RAW-ARG-VALUE-must-not-be-logged';
  let b;
  before(async () => { b = await startBroker({ upstream, grants: [g], approvalTimeoutMs: 300 }); });
  after(() => b.stop());

  test('one line per decision with a sha256 args digest, mode 0600, no raw args', async () => {
    const args = { z: 1, a: { y: [1, 'two', true, null], b: marker } };
    await b.rpc(g.token, 'tools/call', { name: 'read_issue', arguments: args }); // allowed
    await b.rpc(g.token, 'tools/call', { name: 'delete_repo', arguments: { why: marker } }); // refused not_granted
    const held = b.rpc(g.token, 'tools/call', { name: 'create_issue', arguments: { title: marker } });
    const pending = await waitFor(async () => (await b.admin('GET', '/approvals')).json.approvals[0]);
    await b.admin('POST', `/approvals/${pending.id}`, { decision: 'allow' });
    await held; // approved
    await b.rpc(g.token, 'tools/call', { name: 'create_issue', arguments: { title: 'x' } }); // timeout
    await b.rpc(g.token, 'tools/call', { name: 'read_issue', arguments: {} }); // refused max_calls

    const lines = auditLines(b.auditPath);
    assert.deepEqual(lines.map((l) => [l.tool, l.decision, l.reason]), [
      ['read_issue', 'allowed', undefined],
      ['delete_repo', 'refused', 'not_granted'],
      ['create_issue', 'approved', undefined],
      ['create_issue', 'timeout', undefined],
      ['read_issue', 'refused', 'max_calls'],
    ]);
    for (const l of lines) {
      assert.deepEqual(Object.keys(l).filter((k) => k !== 'reason'), ['ts', 'runId', 'tool', 'decision', 'argsDigest']);
      assert.equal(l.runId, g.runId);
      assert.match(l.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.match(l.argsDigest, /^[0-9a-f]{64}$/);
    }
    assert.equal(lines[0].argsDigest, digest(args), 'digest is over canonical (sorted-key) JSON');
    assert.equal(lines[4].argsDigest, digest({}));
    const raw = readFileSync(b.auditPath, 'utf8');
    assert.ok(!raw.includes(marker), 'raw args reached the audit log');
    assert.ok(!raw.includes(CREDENTIAL));
    assert.ok(!raw.includes(g.token));
    assert.equal(statSync(b.auditPath).mode & 0o777, 0o600);
  });

  test('a deny is logged as denied', async (t) => {
    const dg = grant({ runId: 'deny-run' });
    const b2 = await startBroker({ upstream, grants: [dg] });
    t.after(() => b2.stop());
    const held = b2.rpc(dg.token, 'tools/call', { name: 'create_issue', arguments: { title: 'd' } });
    const pending = await waitFor(async () => (await b2.admin('GET', '/approvals')).json.approvals[0]);
    await b2.admin('POST', `/approvals/${pending.id}`, { decision: 'deny' });
    await held;
    const lines = auditLines(b2.auditPath);
    assert.deepEqual(lines.map((l) => l.decision), ['denied']);
  });

  test('an audit file that already exists is tightened to 0600', async (t) => {
    const path = join(mkdtempSync(join(tmpdir(), 'grants-audit-')), 'audit.jsonl');
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    const b3 = await startBroker({ upstream, grants: [], extraConfig: { auditPath: path } });
    t.after(() => b3.stop());
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});
