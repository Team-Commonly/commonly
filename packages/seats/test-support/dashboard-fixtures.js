/**
 * Seeds a trace store with one run per headline outcome (ok, failed with a
 * refusal, stuck after a stall and a recovery) plus a running one, and a
 * small compat results.json. Shared by the dashboard tests and the manual
 * browser check, so both look at the same data.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTraceStore } from '../src/trace/store.js';

export const BASE = Date.UTC(2026, 9, 25, 12, 0, 0);

export const seedStore = (root, { evil = false } = {}) => {
  let clock = BASE;
  const at = (ms) => { clock = ms; };
  const store = createTraceStore({ root, now: () => new Date(clock) });
  const xss = evil ? '<script>alert(1)</script>' : '';

  at(BASE);
  const ok = store.startRun({ runId: 'run-ok-0001', adapter: 'opencode', label: 'nightly smoke' });
  ok.emit('run.started', { adapter: 'opencode', cli: { name: 'opencode', version: '1.19.0' }, sessionId: 'ses_1', attempt: 1 });
  at(BASE + 40); ok.emit('turn.prompt_sent', { chars: 42 });
  at(BASE + 120); ok.emit('credential.granted', { names: ['OPENROUTER_API_KEY'] });
  at(BASE + 300); ok.emit('tool.call', { toolCallId: 'tc-1', title: `Write notes.md${xss}`, kind: 'edit', status: 'pending' });
  at(BASE + 310); ok.emit('permission.requested', { toolCallId: 'tc-1', question: `Allow writing notes.md?${xss}`, askedOf: { id: 'u-owner', role: 'agent-owner' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] });
  at(BASE + 320); ok.emit('permission.decided', { outcome: 'selected', optionId: 'deny', kind: 'reject_once', decidedBy: 'u-owner', decidedByRole: 'agent-owner' });
  at(BASE + 330); ok.emit('tool.update', { toolCallId: 'tc-1', status: 'failed' });
  at(BASE + 400); ok.emit('agent.message_chunk', { text: 'PO' });
  at(BASE + 410); ok.emit('agent.message_chunk', { text: `NG${xss}` });
  at(BASE + 500); ok.emit('usage', { inputTokens: 12, outputTokens: 3, totalTokens: 15, cost: null });
  at(BASE + 1200); ok.emit('run.settled', { outcome: 'ok', durationMs: 1200, attempts: 1 });

  at(BASE + 60000);
  const failed = store.startRun({ runId: 'run-failed-02', adapter: 'goose' });
  failed.emit('run.started', { adapter: 'goose', cli: { name: 'goose', version: '1.54.0' }, attempt: 1 });
  at(BASE + 60050); failed.emit('credential.denied', { name: 'GITHUB_TOKEN' });
  at(BASE + 60900); failed.emit('run.settled', { outcome: 'failed', failure: { kind: 'refusal', detail: 'provider returned 400: content refused' }, durationMs: 900, attempts: 1 });

  at(BASE + 120000);
  const stuck = store.startRun({ runId: 'run-stuck-03', adapter: 'opencode' });
  stuck.emit('run.started', { adapter: 'opencode', cli: { name: 'opencode', version: '1.19.0' }, attempt: 1 });
  at(BASE + 120050); stuck.emit('turn.prompt_sent', { chars: 18 });
  at(BASE + 150050); stuck.emit('liveness.stalled', { idleMs: 30000, windowMs: 30000 });
  at(BASE + 150060); stuck.emit('liveness.recovery', { action: 'cancel', attempt: 1 });
  at(BASE + 150500); stuck.emit('liveness.recovery', { action: 'retry', attempt: 2 });
  at(BASE + 180500); stuck.emit('liveness.stalled', { idleMs: 30000, windowMs: 30000 });
  at(BASE + 180600); stuck.emit('liveness.recovery', { action: 'kill', attempt: 2 });
  at(BASE + 180700); stuck.emit('process.exited', { code: null, signal: 'SIGKILL' });
  at(BASE + 180710); stuck.emit('run.settled', { outcome: 'stuck', failure: { kind: 'stuck', detail: 'no output for 30s after 2 attempts' }, durationMs: 60710, attempts: 2 });

  at(BASE + 200000);
  const running = store.startRun({ runId: 'run-live-0004', adapter: 'hermes' });
  running.emit('run.started', { adapter: 'hermes', attempt: 1 });
  return store;
};

export const sampleCompat = ({ evil = false } = {}) => ({
  schemaVersion: 1,
  generatedAt: '2026-10-25T12:05:00.000Z',
  host: { os: 'darwin', arch: 'arm64', node: 'v26.0.0' },
  rows: [
    {
      cli: 'opencode',
      version: '1.19.0',
      checks: [
        { id: 'detect', title: 'Detect version', status: 'pass', detail: 'opencode 1.19.0', ms: 210 },
        { id: 'reply', title: 'Reply through fake provider', status: 'pass', detail: 'PONG', ms: 1830 },
        { id: 'stall', title: 'Stall is detected', status: 'fail', detail: evil ? '<script>alert(1)</script>' : 'no liveness.stalled within 30s', ms: 30100 },
      ],
    },
    {
      cli: 'goose',
      version: '1.54.0',
      checks: [
        { id: 'detect', title: 'Detect version', status: 'pass', ms: 95 },
        { id: 'reply', title: 'Reply through fake provider', status: 'skip', detail: 'provider config not supported yet' },
      ],
    },
  ],
});

export const writeCompat = (dir, opts) => {
  const path = join(dir, 'results.json');
  writeFileSync(path, JSON.stringify(sampleCompat(opts), null, 2));
  return path;
};
