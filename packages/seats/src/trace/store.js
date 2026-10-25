/**
 * Append-only trace store on the local filesystem.
 *
 *   <root>/runs/<runId>.jsonl   the run record (docs/record-v1.md): one
 *                               canonical, hash-chained entry per line
 *   <root>/index.jsonl          one line per started run, one per settled run;
 *                               a store convenience, not part of the format
 *
 * Files are 0600 and directories 0700: a trace holds agent output.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendEntry, hashLine, kindOfType, readRecord, traceTypeOf, validateActor, verifyRecord, BOARD_ACTOR,
} from '../record/format.js';

const RUN_ID = /^[A-Za-z0-9_-]{6,64}$/;
const readJsonl = (path) => (existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  })
  : []);

/**
 * Known credential values never reach a line, even inside agent text. Every
 * registered value is replaced, whatever its length: the eight-character
 * floor in redactKnownCredentials belongs to the refusal-text reader, not to
 * the record. `secrets` is kept longest first, so a value that contains a
 * shorter one is replaced whole rather than in pieces.
 */
const scrubText = (text, secrets) => {
  let out = text;
  for (const value of secrets) out = out.split(value).join('[redacted]');
  return out;
};

const scrub = (value, secrets) => {
  if (secrets.length === 0) return value;
  if (typeof value === 'string') return scrubText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, secrets)]));
  }
  return value;
};

/**
 * Streamed agent text arrives in deltas, so a value can be split across two or
 * more of them and match none on its own. Each stream (kind + actor) is
 * scrubbed over a rolling window instead: the held tail is joined to the next
 * delta, the join is scrubbed, and the longest suffix of the result that
 * could still begin a known value is held back again. What is written is the
 * rest.
 *
 * Why that is enough: an occurrence that started inside written text and ran
 * past its end would make the written part plus the held tail a proper prefix
 * of that value, a longer such suffix than the one held. So no value spans a
 * written boundary, and each written piece is itself scrubbed. The tail is
 * shorter than the longest value, and only as long as an actual prefix match.
 */
const STREAMED_KINDS = new Set(['agent.message_chunk', 'agent.thought_chunk']);
// The held text is written out before these, so it stays in its own attempt
// and is never lost at settle, whichever path (ok, failure, cancel, kill) got there.
const FLUSH_BEFORE = new Set(['attempt.started', 'attempt.settled', 'run.settled']);

const heldLength = (text, secrets) => {
  const longest = secrets.length ? secrets[0].length : 0;
  for (let start = Math.max(0, text.length - longest + 1); start < text.length; start += 1) {
    const tail = text.slice(start);
    if (secrets.some((value) => value.length > tail.length && value.startsWith(tail))) return text.length - start;
  }
  return 0;
};

/** What readRun has always returned, plus the envelope: `type` is the trace name. */
const asEvent = (entry) => (entry.kind ? { ...entry, type: traceTypeOf(entry.kind) } : entry);

export const createTraceStore = ({ root, now = () => new Date() } = {}) => {
  if (!root) throw new Error('createTraceStore needs a root directory');
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const append = (path, value) => appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const indexPath = join(root, 'index.jsonl');

  /**
   * startRun({ runId?, adapter?, label?, taskId?, podId?, actor? })
   *   → { runId, emit, redact, revokeGrant, expireGrants, openGrants, settled }
   *
   * `taskId` is the board's task id verbatim and needs `podId`, since task
   * ids repeat across pods. `actor` is the run's own party, normally
   * {type: 'agent', id: <user id>, owner: <user id>}.
   */
  const startRun = (meta = {}) => {
    const runId = meta.runId || randomUUID();
    if (!RUN_ID.test(runId)) throw new Error('runId must be 6-64 characters of [A-Za-z0-9_-]');
    const taskId = meta.taskId || undefined;
    const podId = meta.podId || undefined;
    if (taskId && !podId) throw new Error('a taskId needs a podId: task ids repeat across pods');
    const runActor = meta.actor === undefined ? null : validateActor(meta.actor);
    const path = join(runsDir, `${runId}.jsonl`);
    try {
      writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`run ${runId} already exists`);
      throw error;
    }
    let last = null; // the previous line, which the next one hashes
    let seq = 0;
    let settled = false;
    let broken = false;
    const secrets = []; // longest first; see scrubText
    const streams = new Map(); // stream key → { kind, actor, held }
    const grants = new Map(); // open grants: grantId → { parentGrantId, binding, expiresAt }
    const startedAt = now();

    const writeLine = (kind, data, actor) => {
      const line = appendEntry(last, {
        runId, taskId, podId, ts: now().toISOString(), kind, data: scrub(data, secrets), actor,
      }, { runActor });
      try {
        appendFileSync(path, `${line}\n`, { mode: 0o600 });
      } catch (error) {
        // Some bytes may have landed; a chain cannot continue past an unknown tail.
        broken = true;
        throw error;
      }
      last = line;
      seq += 1;
      const entry = JSON.parse(line);
      if (kind === 'grant.issued') {
        grants.set(entry.data.grantId, {
          parentGrantId: entry.data.parentGrantId ?? null, binding: entry.data.binding || null, expiresAt: entry.data.expiresAt || null,
        });
      }
      if (kind === 'grant.revoked') for (const id of entry.data.grantIds) grants.delete(id);
      return asEvent(entry);
    };

    /** A streamed delta's text, less a tail that could begin a known value. */
    const windowed = (kind, data, actor) => {
      if (!STREAMED_KINDS.has(kind) || typeof data?.text !== 'string') return data;
      const key = JSON.stringify([kind, actor ?? null]);
      const joined = scrubText(`${streams.get(key)?.held ?? ''}${data.text}`, secrets);
      const cut = joined.length - heldLength(joined, secrets);
      if (cut < joined.length) streams.set(key, { kind, actor, held: joined.slice(cut) });
      else streams.delete(key);
      return { ...data, text: joined.slice(0, cut) };
    };

    const write = (kind, data, actor) => writeLine(kind, windowed(kind, data, actor), actor);

    /**
     * The stream has ended, so each held tail can no longer complete a value.
     * A tail is held only while it is a prefix of a known value, so it is part
     * of a credential: write the marker in its place, never the prefix.
     */
    const flushStreams = () => {
      for (const [key, { kind, actor }] of streams) {
        streams.delete(key);
        writeLine(kind, { text: '[redacted]' }, actor);
      }
    };

    const revoke = (grantIds, reason, actor) => (grantIds.length ? write('grant.revoked', { grantIds, reason }, actor) : null);

    const emit = (type, data = {}, options = {}) => {
      const kind = kindOfType(type);
      if (!kind) throw new Error(`unknown trace event type: ${type}`);
      if (settled) return null;
      if (broken) throw new Error(`run ${runId}: the record is broken after a failed write`);
      if (FLUSH_BEFORE.has(kind)) flushStreams();
      const event = write(kind, data, options?.actor);
      if (kind === 'task.done') {
        // The board closed the task: every grant bound to it ends, in one write.
        const bound = [...grants].filter(([, g]) => g.binding?.endsOn === 'task.done').map(([id]) => id);
        revoke(bound, 'task.done', BOARD_ACTOR);
      }
      if (kind === 'run.settled') {
        settled = true;
        append(indexPath, {
          runId,
          settledAt: event.ts,
          outcome: event.data.outcome,
          failure: event.data.failure || null,
          durationMs: event.data.durationMs ?? null,
          entries: seq,
          head: hashLine(last),
        });
      }
      return event;
    };

    /** Revoke a grant and every descendant this run knows of, in one entry. */
    const revokeGrant = (grantId, { actor } = {}) => {
      if (settled || !grants.has(grantId)) return null;
      const lineage = [grantId];
      for (let i = 0; i < lineage.length; i += 1) {
        for (const [id, g] of grants) if (g.parentGrantId === lineage[i] && !lineage.includes(id)) lineage.push(id);
      }
      return revoke(lineage, lineage.length > 1 ? 'cascade' : 'manual', actor);
    };

    /** Record the end of every open grant whose expiresAt has passed. */
    const expireGrants = (at = now()) => {
      if (settled) return null;
      const cutoff = at.getTime();
      return revoke([...grants].filter(([, g]) => g.expiresAt && Date.parse(g.expiresAt) <= cutoff).map(([id]) => id), 'expired');
    };

    /** Every non-empty string is scrubbed from here on, whatever its length. */
    const redact = (values = []) => {
      for (const value of values) if (typeof value === 'string' && value && !secrets.includes(value)) secrets.push(value);
      secrets.sort((a, b) => b.length - a.length);
    };

    append(indexPath, {
      runId,
      startedAt: startedAt.toISOString(),
      adapter: meta.adapter || null,
      label: meta.label || null,
      ...(taskId ? { taskId, podId } : podId ? { podId } : {}),
      ...(runActor ? { actor: runActor } : {}),
    });
    return {
      runId,
      taskId: taskId ?? null,
      podId: podId ?? null,
      emit,
      redact,
      revokeGrant,
      expireGrants,
      openGrants: () => [...grants.keys()],
      get settled() { return settled; },
    };
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

  const runPath = (runId) => (RUN_ID.test(String(runId)) ? join(runsDir, `${runId}.jsonl`) : null);

  const readRun = (runId) => {
    const path = runPath(runId);
    return path && existsSync(path) ? readRecord(readFileSync(path, 'utf8')).map(asEvent) : null;
  };

  /**
   * verifyRun(runId) → { ok, errors: [{seq, reason, detail?}], entries, head, settled } | null
   *
   * The chain check from verifyRecord, plus the last line against the head the
   * index recorded at settle (head_mismatch, count_mismatch). The index sits
   * beside the record, so that check catches accidents, not an editor.
   */
  const verifyRun = (runId) => {
    const path = runPath(runId);
    if (!path || !existsSync(path)) return null;
    const result = verifyRecord(readFileSync(path, 'utf8'));
    const sealed = readJsonl(indexPath).filter((row) => row.runId === runId && row.head).pop();
    if (sealed) {
      if (sealed.entries !== result.entries) result.errors.push({ seq: sealed.entries, reason: 'count_mismatch', detail: `index ${sealed.entries}, file ${result.entries}` });
      else if (sealed.head !== result.head) result.errors.push({ seq: sealed.entries, reason: 'head_mismatch' });
      result.ok = result.errors.length === 0;
    }
    return result;
  };

  return { root, startRun, listRuns, readRun, verifyRun };
};
