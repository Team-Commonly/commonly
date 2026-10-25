import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRuns, renderRun, renderCompat, esc, fmtDuration } from '../src/dashboard/render.js';
import { FAILURE_KINDS } from '../src/failures.js';
import { seedStore, sampleCompat, BASE } from '../test-support/dashboard-fixtures.js';

const withStore = (fn, opts) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-dash-'));
  try { return fn(seedStore(root, opts)); } finally { rmSync(root, { recursive: true, force: true }); }
};
const NOW = BASE + 210000;
const rowOf = (html, marker) => html.split('<tr').find((r) => r.includes(marker)) || '';

test('runs page lists every run with adapter, duration, outcome and failure kind', () => withStore((store) => {
  const html = renderRuns(store.listRuns(), { now: NOW });
  for (const id of ['run-ok-0001', 'run-failed-02', 'run-stuck-03', 'run-live-0004']) assert.match(html, new RegExp(`href="/runs/${id}"`));
  const has = (marker, ...parts) => { const row = rowOf(html, marker); for (const p of parts) assert.ok(row.includes(p), `${marker} row lacks ${p}`); };
  has('run-ok-0001', '>opencode<', '>1.2s<', 'b-ok', 'nightly smoke');
  has('run-failed-02', '>goose<', 'b-failed', '>refusal<', FAILURE_KINDS.refusal.meaning);
  has('run-live-0004', '>hermes<', 'b-running', '10.0s so far');
  assert.match(html, /<script>setInterval/, 'the runs page refreshes itself');
  assert.doesNotMatch(renderRuns([], { refresh: false }), /<script>/);
}));

test('stuck runs stand out: an alert, a tinted row and the meaning of stuck', () => withStore((store) => {
  const html = renderRuns(store.listRuns(), { now: NOW });
  assert.match(html, /class="alert"[^>]*>1 stuck run: no progress signal within the liveness window/);
  assert.match(rowOf(html, 'run-stuck-03'), /^ class="stuck"/);
  assert.doesNotMatch(rowOf(html, 'run-ok-0001'), /^ class="stuck"/);
  assert.doesNotMatch(renderRuns(store.listRuns().filter((r) => r.outcome !== 'stuck'), { now: NOW }), /class="alert"/);
}));

test('the outcome filter keeps only matching runs and ignores unknown values', () => withStore((store) => {
  const runs = store.listRuns();
  const stuck = renderRuns(runs, { outcome: 'stuck', now: NOW });
  assert.match(stuck, /run-stuck-03/);
  assert.doesNotMatch(stuck, /href="\/runs\/run-ok-0001"/);
  assert.match(stuck, /href="\/\?outcome=stuck" aria-current="true"/);
  const bogus = renderRuns(runs, { outcome: 'nope', now: NOW });
  assert.match(bogus, /href="\/runs\/run-ok-0001"/);
  assert.match(renderRuns(runs, { outcome: 'cancelled', now: NOW }), /No cancelled runs/);
}));

test('run detail concatenates the reply, folds chunks and audits permissions and credentials by name', () => withStore((store) => {
  const html = renderRun(store.readRun('run-ok-0001'));
  assert.match(html, /<pre class="reply">PONG<\/pre>/);
  assert.match(html, /8–9<\/td>[\s\S]*?2 chunks, 4 chars/);
  assert.match(rowOf(html, 'credential.granted'), /class="audit"[\s\S]*<code>OPENROUTER_API_KEY<\/code>/);
  assert.match(rowOf(html, 'permission.requested'), /class="audit"[\s\S]*<b>Write notes\.md<\/b>[\s\S]*allow \(allow_once\), deny \(reject_once\)/);
  assert.match(rowOf(html, 'permission.requested'), /Allow writing notes\.md\?[\s\S]*agent-owner/);
  assert.match(rowOf(html, 'permission.decided'), /selected[\s\S]*deny[\s\S]*reject_once[\s\S]*agent-owner/);
  assert.match(rowOf(html, '>usage<'), /cost<\/span> unknown/);
  assert.match(html, /\+0\.400s/);
}));

test('a credential event shows the name and never the rest of its data', () => {
  const html = renderRun([
    { runId: 'run-x', seq: 1, ts: new Date(BASE).toISOString(), type: 'credential.granted', data: { names: ['API_KEY'], value: 'sk-leak-123' } },
    { runId: 'run-x', seq: 2, ts: new Date(BASE).toISOString(), type: 'credential.denied', data: { name: 'GH_TOKEN', value: 'ghp_leak' } },
  ]);
  assert.match(html, /API_KEY/);
  assert.match(rowOf(html, 'credential.denied'), /class="audit denied"[\s\S]*GH_TOKEN/);
  assert.doesNotMatch(html, /leak/);
});

test('stuck detail highlights stalls and recoveries and explains the settle', () => withStore((store) => {
  const html = renderRun(store.readRun('run-stuck-03'));
  assert.equal((html.match(/<tr class="live">/g) || []).length, 5, 'two stalls and three recoveries');
  assert.match(rowOf(html, 'liveness.stalled'), /idle 30\.0s of a 30\.0s window/);
  assert.match(html, /Stalls <b>2<\/b>[\s\S]*Recoveries <b>3<\/b>/);
  assert.match(html, /class="card settle stuck"><b class="mono">stuck<\/b> — no progress signal within the liveness window/);
  assert.match(rowOf(html, 'run.settled'), /class="settled"[\s\S]*b-stuck/);
  assert.match(html, /No agent text/);
}));

test('a refusal settle carries its kind, meaning and detail', () => withStore((store) => {
  const html = renderRun(store.readRun('run-failed-02'));
  assert.ok(html.includes(FAILURE_KINDS.refusal.meaning));
  assert.match(html, /provider returned 400: content refused/);
  assert.match(rowOf(html, 'credential.denied'), /GITHUB_TOKEN/);
}));

test('an unsettled or empty run renders as running without throwing', () => {
  assert.match(renderRun([], { runId: 'run-empty' }), /No events yet/);
  assert.match(renderRun([{ seq: 1, type: 'run.started', ts: 'bad', data: null }], { runId: 'run-odd1' }), /b-running/);
  assert.match(renderRun([{ seq: 1, type: 'future.kind', data: { a: 1 } }], { runId: 'run-odd2' }), /\{&quot;a&quot;:1\}/);
  assert.match(renderRun([{ seq: 1, type: 'run.settled', data: { outcome: 'failed', failure: { kind: 'brand_new' } } }]), /brand_new/);
});

test('compat grid shows each CLI@version against each check', () => {
  const html = renderCompat(sampleCompat());
  assert.match(html, /opencode@1\.19\.0[\s\S]*2\/3 pass/);
  assert.match(html, /goose@1\.54\.0[\s\S]*1\/2 pass/);
  assert.match(html, /<th class="check" title="stall">Stall is detected<\/th>/);
  assert.match(html, /c-fail">fail<\/b>[\s\S]*no liveness\.stalled within 30s/);
  const goose = rowOf(html, 'goose@');
  assert.match(goose, /c-skip">skip/);
  assert.match(goose, /<td class="cell"><span class="muted">—<\/span><\/td>/, 'a check the row lacks is a dash');
  assert.match(html, /darwin[\s\S]*arm64[\s\S]*v26\.0\.0/);
});

test('compat tolerates missing or malformed results', () => {
  assert.match(renderCompat(null), /No compatibility results/);
  assert.match(renderCompat({ rows: 'x' }), /No compatibility results/);
  assert.match(renderCompat({ rows: [{ cli: 'x' }, null, { checks: [{ id: 'a', status: 'weird' }] }] }), /\(unknown cli\)[\s\S]*c-unknown">weird/);
  assert.match(renderCompat(null, { error: 'Could not parse x' }), /Could not parse x/);
});

test('every interpolated value is escaped: agent text, run id, tool title, compat detail', () => withStore((store) => {
  const evilId = '<script>alert(1)</script>';
  const pages = [
    renderRuns([...store.listRuns(), { runId: evilId, adapter: evilId, label: evilId, outcome: evilId, failure: { kind: evilId }, startedAt: evilId }], { outcome: evilId, now: NOW }),
    renderRun(store.readRun('run-ok-0001')),
    renderRun(store.readRun('run-ok-0001'), { runId: evilId }),
    renderRun([{ runId: evilId, seq: evilId, ts: evilId, type: evilId, data: { x: evilId } }, { seq: 2, type: 'plan', data: { entries: [{ status: evilId, content: evilId }] } }]),
    renderCompat(sampleCompat({ evil: true })),
    renderCompat({ generatedAt: evilId, host: { os: evilId }, rows: [{ cli: evilId, version: evilId, checks: [{ id: evilId, title: evilId, status: evilId, detail: evilId }] }] }),
  ];
  for (const html of pages) {
    const scripts = html.match(/<script>[^<]*<\/script>/g) || [];
    assert.ok(scripts.every((s) => s.startsWith('<script>setInterval')), 'the only script is the refresh one');
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }
}, { evil: true }));

test('helpers escape quotes and format durations', () => {
  assert.equal(esc(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
  assert.equal(esc(null), '');
  assert.deepEqual([fmtDuration(5), fmtDuration(1500), fmtDuration(65000), fmtDuration(3723000), fmtDuration(null)], ['5ms', '1.5s', '1m 05s', '1h 02m', '—']);
});
