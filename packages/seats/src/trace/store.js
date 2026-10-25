/**
 * Append-only trace store on the local filesystem.
 *
 *   <root>/runs/<runId>.jsonl   one event per line, in seq order
 *   <root>/index.jsonl          one line per started run, one per settled run
 *
 * Files are 0600 and directories 0700: a trace holds agent output.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEventType } from './events.js';

const RUN_ID = /^[A-Za-z0-9_-]{6,64}$/;
const readJsonl = (path) => (existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  })
  : []);

export const createTraceStore = ({ root, now = () => new Date() } = {}) => {
  if (!root) throw new Error('createTraceStore needs a root directory');
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const append = (path, value) => appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const indexPath = join(root, 'index.jsonl');

  const startRun = (meta = {}) => {
    const runId = meta.runId || randomUUID();
    if (!RUN_ID.test(runId)) throw new Error('runId must be 6-64 characters of [A-Za-z0-9_-]');
    const path = join(runsDir, `${runId}.jsonl`);
    try {
      writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`run ${runId} already exists`);
      throw error;
    }
    let seq = 0;
    let settled = false;
    const startedAt = now();
    const emit = (type, data = {}) => {
      if (!isEventType(type)) throw new Error(`unknown trace event type: ${type}`);
      if (settled) return null;
      seq += 1;
      const event = { runId, seq, ts: now().toISOString(), type, data };
      append(path, event);
      if (type === 'run.settled') {
        settled = true;
        append(indexPath, { runId, settledAt: event.ts, outcome: data.outcome, failure: data.failure || null, durationMs: data.durationMs ?? null });
      }
      return event;
    };
    append(indexPath, { runId, startedAt: startedAt.toISOString(), adapter: meta.adapter || null, label: meta.label || null });
    return { runId, emit, get settled() { return settled; } };
  };

  const listRuns = ({ limit = 50 } = {}) => {
    const byId = new Map();
    for (const line of readJsonl(indexPath)) {
      const row = byId.get(line.runId) || { runId: line.runId, outcome: 'running' };
      Object.assign(row, line);
      byId.set(line.runId, row);
    }
    return [...byId.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit);
  };

  const readRun = (runId) => {
    if (!RUN_ID.test(String(runId))) return null;
    const path = join(runsDir, `${runId}.jsonl`);
    return existsSync(path) ? readJsonl(path) : null;
  };

  return { root, startRun, listRuns, readRun };
};
