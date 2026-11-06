/**
 * Who sees whose id on a pod anyone can join (F265, ADR-033 D6). An approver's
 * or credential owner's id goes only to the person it names and the pod's
 * creator. There is no join
 * time to do better with: Pod.members is a bare id array, and PG
 * pod_members.joined_at is the mirror row's insert time (ADR-033 D6).
 *
 * The view is built to pass the reader's own verifyRecord (record-v1 §8). Pure:
 * callers load the stored lines.
 */
import type { ChainOpening } from '../repositories/recordChainRepository';
import { isDirectlyJoinable } from './podListing';

/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const format = require('../vendor/seats/src/record/format') as {
  canonicalLine: (entry: Record<string, unknown>) => string;
  hashLine: (line: string) => string;
  isCommitment: (value: unknown) => boolean;
};
/* eslint-enable @typescript-eslint/no-require-imports, global-require */

/** An id token, so a redacted line still passes the format's actor check. */
export const REDACTED_ID = 'redacted';

type PodShape = Parameters<typeof isDirectlyJoinable>[0] & { _id?: unknown; createdBy?: unknown };

/**
 * A pod a stranger can reach on their own. `joinPolicy: 'open'` alone isn't
 * this: it is the schema default, and joinPod refuses an unlisted pod. The
 * community pod is added to at signup, so it counts whatever its flags say.
 * Read at each request, so a pod that gets listed is redacted from then on.
 */
export const isOpenPod = (pod: PodShape): boolean => {
  const community = String(process.env.COMMUNITY_POD_ID || '').trim();
  return isDirectlyJoinable(pod) || (Boolean(community) && String(pod?._id) === community);
};

/** Who reads every id on an open pod: the pod's creator, and no admin. */
export const seesAllIds = (pod: PodShape, viewerId: unknown): boolean => (
  Boolean(viewerId) && String(pod?.createdBy) === String(viewerId)
);

/** A person's id as this viewer may see it, or null on an open pod. */
export const personIdFor = <T>(pod: PodShape, viewerId: unknown, id: T): T | null => (
  isOpenPod(pod) && String(id) !== String(viewerId) && !seesAllIds(pod, viewerId) ? null : id
);

type Actor = { type?: string; id?: string; owner?: string; name?: string; onBehalfOf?: { id: string; role: string } };
type Entry = Record<string, unknown> & { kind?: string; actor?: Actor | null; data?: Record<string, unknown> };

// Kinds whose lines name no approver or credential owner: the worker and the
// board. Every other kind is held back, so a kind added later starts hidden.
const NO_DECIDER_KINDS = new Set(['task.claimed', 'task.released', 'task.done', 'tool.call', 'tool.update']);
const NOT_A_PERSON = new Set(['policy']);

/** The entry as this viewer may read it, and the paths that changed. */
const redactEntry = (stored: Entry, viewerId: string): { entry: Entry; fields: string[] } => {
  const entry = JSON.parse(JSON.stringify(stored)) as Entry;
  const data = entry.data || {};
  const fields: string[] = [];
  const hide = (value: unknown, path: string): unknown => {
    // A commitment hides itself: it stays, and only its opening is withheld.
    if (typeof value !== 'string' || NOT_A_PERSON.has(value) || value === viewerId || format.isCommitment(value)) return value;
    fields.push(path);
    return REDACTED_ID;
  };
  const hideActor = () => {
    const { actor } = entry;
    if (!actor || (actor.type !== 'human' && actor.type !== 'agent')) return;
    actor.id = hide(actor.id, 'actor.id') as string;
    if (actor.owner) actor.owner = hide(actor.owner, 'actor.owner') as string;
    if (actor.onBehalfOf) actor.onBehalfOf.id = hide(actor.onBehalfOf.id, 'actor.onBehalfOf.id') as string;
    if (actor.name && actor.id === REDACTED_ID) { delete actor.name; fields.push('actor.name'); }
  };
  const { kind = '' } = entry;
  if (NO_DECIDER_KINDS.has(kind)) return { entry, fields };
  if (kind === 'permission.requested') {
    const askedOf = data.askedOf as { id?: string; role?: string } | undefined;
    if (askedOf && askedOf.role !== 'policy') askedOf.id = hide(askedOf.id, 'data.askedOf.id') as string;
  } else if (kind === 'permission.decided' || kind === 'decision.ruled') {
    hideActor();
    data.decidedBy = hide(data.decidedBy, 'data.decidedBy');
  } else if (kind === 'grant.issued') {
    // Only a person minting a root grant is known to own its connection: a child
    // can rest on anyone's, whoever attenuated it.
    const own = entry.actor?.type === 'human' && data.issuedBy === viewerId && !data.parentGrantId;
    hideActor();
    data.issuedBy = hide(data.issuedBy, 'data.issuedBy');
    // The audience stays: the grant read gives every member effectiveAudience,
    // and hiding it here cost the granter a whole line for nothing.
    const scope = (data.scope || {}) as { connectionId?: unknown };
    // A connection is one person's credential, so its id says whose it is.
    if (scope.connectionId !== undefined && !own) scope.connectionId = hide(scope.connectionId, 'data.scope.connectionId');
  } else if (kind === 'grant.revoked') {
    hideActor();
  } else {
    hideActor();
    if (Object.keys(data).length > 0) fields.push('data');
    entry.data = {};
  }
  return { entry, fields };
};

/** A stored line with the ids this reader may have, or as stored with none. */
export const attachOpenings = (line: string, rows: Array<Pick<ChainOpening, 'commitment' | 'value' | 'salt'>>): string => {
  if (rows.length === 0) return line;
  return format.canonicalLine({
    ...(JSON.parse(line) as Record<string, unknown>),
    openings: Object.fromEntries(rows.map((row) => [row.commitment.trim(), { id: row.value, salt: row.salt }])),
  });
};

/**
 * Whether an open pod's reader gets a committed id. The task lines' people and
 * the agent asking stay readable, as on a plain line; the rest go to the
 * person they name.
 */
const opensTo = (row: ChainOpening, kind: string, viewerId: string): boolean => (
  NO_DECIDER_KINDS.has(kind)
  || (kind === 'permission.requested' && row.field.startsWith('actor.'))
  || row.field.startsWith('data.scope.audience.')
  || row.value === viewerId || row.subject === viewerId
);

export type RecordView = {
  /** One served line per stored line, in order, without newlines. */
  lines: string[];
  jsonl: string;
  /** Lines that carry a redaction marker, and those with no hash to link through. */
  redacted: number;
  unlinked: number;
  /** Commitments held back from this reader. Deleted ids aren't counted. */
  unopened: number;
  /** Whether the stored head may be shown (record-v1 §8). */
  headShown: boolean;
};

/**
 * The stored chain as this viewer reads it. The chain is unsalted hashing, so
 * any hash at or after a held-back line lets a reader try each member id until
 * one matches. A hash goes out only for a salted line, or a verbatim line with
 * every earlier hash shown; everything else is served with `hash: null`.
 * A stored line that isn't JSON can't be redacted, so this throws.
 */
export const buildRecordView = (stored: string[], viewerId: string, openings: ChainOpening[] = []): RecordView => {
  const lines: string[] = [];
  let hashShown = true;
  let redacted = 0;
  let unlinked = 0;
  let unopened = 0;
  const bySeq = new Map<number, ChainOpening[]>();
  openings.forEach((row) => bySeq.set(row.seq, [...(bySeq.get(row.seq) || []), row]));
  for (const [index, line] of stored.entries()) {
    const { salt, ...parsed } = JSON.parse(line) as Entry & { salt?: string };
    const { entry, fields } = redactEntry(parsed, viewerId);
    const rows = bySeq.get(index + 1) || [];
    // A commitment that left with held-back data takes its opening with it.
    const served = JSON.stringify(entry);
    const opened = rows.filter((row) => opensTo(row, entry.kind || '', viewerId) && served.includes(row.commitment.trim()));
    unopened += rows.length - opened.length;
    if (fields.length === 0 && hashShown) {
      lines.push(attachOpenings(line, opened));
    } else {
      const hash = salt ? format.hashLine(line) : null;
      const held = format.canonicalLine({ ...entry, prev: hashShown ? entry.prev : null, redaction: { fields, hash } });
      lines.push(attachOpenings(held, opened));
      redacted += 1;
      if (hash === null) unlinked += 1;
      hashShown = hash !== null;
    }
  }
  return { lines, jsonl: lines.map((line) => `${line}\n`).join(''), redacted, unlinked, unopened, headShown: hashShown };
};
