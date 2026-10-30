/**
 * The server's record-v1 writer and reader (TASK-513, ADR-033).
 *
 * Lines are built by the shared reference writer, vendored byte-identical
 * from packages/seats/src (see vendor/seats/README.md), so a server line and
 * a local seat's line are the same format. The backend is the only writer:
 * one chain per (pod, task), plus one taskless chain per pod, each sequenced
 * under its PG row lock (repositories/recordChainRepository).
 *
 * D2: a writer emits only after its source write commits, and a failed emit
 * never blocks or undoes that write. Readers get an error, never an empty
 * record, when storage is unavailable.
 */
import { createHash } from 'crypto';
import {
  appendToChain, readChain, RecordStoreUnavailableError, type ChainPage, type ChainRef,
} from '../repositories/recordChainRepository';

type Store = Parameters<typeof readChain>[1];

/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const format = require('../vendor/seats/src/record/format') as {
  appendEntry: (prevLine: string | null, fields: Record<string, unknown>) => string;
  hashLine: (line: string) => string;
  isUserId: (value: unknown) => boolean;
  readRecord: (text: string) => Record<string, unknown>[];
  BOARD_ACTOR: RecordActor;
};
const otel = require('../vendor/seats/src/record/otel') as {
  toOtlpJson: (entries: Record<string, unknown>[], options: { serviceName: string }) => unknown;
};
/* eslint-enable @typescript-eslint/no-require-imports, global-require */

export type RecordActor = {
  type: 'agent' | 'human' | 'policy' | 'system';
  id: string;
  owner?: string;
};
export type RecordLineInput = {
  kind: string;
  /** Omit for the kind's default actor; null records "unknown" (spec §1). */
  actor?: RecordActor | null;
  data?: Record<string, unknown>;
};
export { RecordStoreUnavailableError, type ChainPage, type ChainRef };

export const BOARD_ACTOR: RecordActor = format.BOARD_ACTOR;
/**
 * The server itself, for an entry no person or board write caused (a grant
 * found expired at use). The format's own default system actor is `seats`,
 * the local run writer, which would misname the server.
 */
export const SERVER_ACTOR: RecordActor = Object.freeze({ type: 'system', id: 'commonly' }) as RecordActor;

/**
 * Pods the record is written and served for. Nothing is public until a
 * non-author walks it (TASK-513), so the default is no pod; `*` is every pod.
 */
export const isRecordEnabled = (podId: unknown): boolean => {
  const list = String(process.env.RECORD_V1_PODS || '').split(',').map((id) => id.trim()).filter(Boolean);
  return list.includes('*') || (typeof podId === 'string' && list.includes(podId));
};

/**
 * The spec's runId for a server chain (ADR-033 §8 q3, option a). Derived, so
 * the same pod and task always name the same chain, and so the id carries no
 * pod or task text beyond what the line's own podId/taskId already say.
 */
export const serverRunId = (ref: ChainRef): string => {
  const scope = ref.taskId ? `task/${ref.podId}/${ref.taskId}` : `pod/${ref.podId}`;
  const digest = createHash('sha256').update(`commonly.record/${scope}`, 'utf8').digest('hex').slice(0, 32);
  return `srv-${ref.taskId ? 'task' : 'pod'}-${digest}`;
};

type ActorSource = {
  _id?: unknown;
  isBot?: boolean;
  botMetadata?: { ownerUserId?: unknown } | null;
} | null | undefined;

/** An agent actor: its user id, plus its owner when that is a valid id. */
export const agentActor = (user: ActorSource): RecordActor | null => {
  const id = user?._id ? String(user._id) : '';
  if (!format.isUserId(id)) return null;
  const owner = user?.botMetadata?.ownerUserId ? String(user.botMetadata.ownerUserId) : '';
  return { type: 'agent', id, ...(format.isUserId(owner) && owner !== id ? { owner } : {}) };
};

export const humanActor = (userId: unknown): RecordActor | null => {
  const id = userId ? String(userId) : '';
  return format.isUserId(id) ? { type: 'human', id } : null;
};

/**
 * The authenticated caller of a request as an actor. An agent token sets
 * req.agentUser (never req.user); a legacy installation token may not resolve
 * one, and then the actor is unknown rather than guessed.
 */
export const requestActor = (req: {
  agentUser?: ActorSource;
  agentTokenHash?: unknown;
  user?: ActorSource;
  userId?: unknown;
}): RecordActor | null => {
  if (req.agentUser) return agentActor(req.agentUser);
  if (req.agentTokenHash) return null;
  const user = req.user || null;
  if (user?.isBot) return agentActor(user);
  return humanActor(req.userId || user?._id);
};

/**
 * Append one source event's lines now. Throws on a malformed line or an
 * unavailable store; callers that must not fail use emitRecord.
 */
export async function appendRecord(
  ref: ChainRef,
  eventKey: string,
  inputs: RecordLineInput[],
  db?: Store,
): Promise<{ appended: number; duplicate: boolean }> {
  const runId = serverRunId(ref);
  return appendToChain(ref, runId, eventKey, (prevLine, storedRunId) => {
    const lines: string[] = [];
    let prev = prevLine;
    for (const input of inputs) {
      prev = format.appendEntry(prev, {
        runId: storedRunId,
        ...(ref.taskId ? { taskId: ref.taskId } : {}),
        podId: ref.podId,
        ts: new Date().toISOString(),
        kind: input.kind,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        data: input.data || {},
      });
      lines.push(prev);
    }
    return { lines, headHash: prev ? format.hashLine(prev) : '' };
  }, db);
}

// One promise tail per chain keeps this process's emits in source-commit
// order without making the source wait. Across replicas the row lock orders.
const tails = new Map<string, Promise<void>>();
const chainKey = (ref: ChainRef): string => `${ref.podId}\u0000${ref.taskId || ''}`;

/**
 * Record a committed source event, best-effort. Returns at once; never throws.
 * `inputs` may be a function, called in the chain's queue, when building the
 * lines needs a lookup: the event keeps the queue position of the call.
 * A failure logs one bounded line naming the chain and kinds, never data.
 */
export const emitRecord = (
  ref: ChainRef,
  eventKey: string,
  inputs: RecordLineInput[] | (() => Promise<RecordLineInput[]>),
): void => {
  if (!ref?.podId || !isRecordEnabled(ref.podId)) return;
  if (Array.isArray(inputs) && inputs.length === 0) return;
  const key = chainKey(ref);
  const run = async (): Promise<void> => {
    let lines: RecordLineInput[] = [];
    try {
      lines = Array.isArray(inputs) ? inputs : await inputs();
      if (lines.length > 0) await appendRecord(ref, eventKey, lines);
    } catch (error) {
      const err = error as { name?: string; code?: string; message?: string };
      console.warn(
        `[record] append failed pod=${ref.podId} task=${ref.taskId || '-'} `
        + `kinds=${lines.map((input) => input.kind).join(',') || '?'}: `
        + `${err.code || err.name || 'Error'} ${String(err.message || '').slice(0, 160)}`,
      );
    }
  };
  const next = (tails.get(key) || Promise.resolve()).then(run);
  tails.set(key, next);
  void next.then(() => { if (tails.get(key) === next) tails.delete(key); });
};

/** Resolves once every emit queued so far has settled. Tests and shutdown. */
export const flushRecordWrites = async (): Promise<void> => {
  while (tails.size > 0) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all([...tails.values()]);
  }
};

export type RecordExport = {
  runId: string | null;
  entries: number;
  head: string | null;
  jsonl: string;
  /** Pass as `after` for the next page; null once a page reaches the head. */
  nextAfter: number | null;
};

/**
 * One page of a chain as stored, in record-v1's file form: one line per entry,
 * each ending in \n. `entries` and `head` describe the whole chain, not the
 * page, so every page names the same head.
 */
export async function readRecordExport(ref: ChainRef, db?: Store, page: ChainPage = {}): Promise<RecordExport> {
  const chain = await readChain(ref, db, page);
  if (!chain) return { runId: null, entries: 0, head: null, jsonl: '', nextAfter: null };
  return {
    runId: chain.runId,
    entries: chain.headSeq,
    head: chain.headHash,
    jsonl: chain.lines.map((line) => `${line}\n`).join(''),
    nextAfter: chain.nextAfter,
  };
}

/** The spec's deterministic OTLP/JSON export (§5) of a JSONL record. */
export const toOtlp = (jsonl: string): unknown => (
  otel.toOtlpJson(format.readRecord(jsonl), { serviceName: 'commonly' })
);
