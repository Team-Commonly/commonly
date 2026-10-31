/**
 * Initiative status, derived from evidence records only (Initiative v1 row 2;
 * design: the Initiative v1 design, #2788, §2).
 *
 * A status here is never written by an owner. It is a read over three kinds of
 * record, each dated by the system that wrote it:
 *
 * - a merge: the update `completeTaskForMergedPull` pushes onto a Task when its
 *   linked PR merges (githubGigService). Only that exact update counts; other
 *   `author: 'system'` updates (starter tasks, sync lines) are not evidence;
 * - a ruled decision: a DecisionRequest with `status: 'ruled'`, dated by
 *   `ruling.at`;
 * - the close record, written by the direction-giver with one evidence URL.
 *
 * Owner-written Task `updates[]`, `claimedAt` and lease renewals are
 * deliberately NOT evidence: seats renew leases with update notes, so counting
 * them would make a stalled initiative read as moving. Task `status` is read in
 * one place only: `needs your check` requires every linked Task to be `done`
 * AND to carry its own merge record, so a Task closed by hand through
 * `/complete` or PATCH never counts, even beside a merged one. A merge is
 * found through a `task` link or a `pr` link alike, since the record lives on
 * the Task either way. A `blocked` Task is a note on its part, never a status.
 *
 * A `pr` link matches `records.tasks` by `prUrl`, so the caller must scope
 * those tasks to the initiative's pods.
 *
 * Pure: callers resolve the linked records and pass them in, so this module
 * reads no collection and owns no schema.
 */

/** The text `completeTaskForMergedPull` writes; the only Task update that is evidence. */
export const MERGE_EVIDENCE_TEXT = 'Completed automatically — linked pull request merged';

export const DEFAULT_WINDOW_HOURS = 24;

export type InitiativeLinkKind = 'task' | 'pr' | 'pod' | 'decision';

export interface InitiativeLink {
  kind: InitiativeLinkKind;
  /** Task `_id`, PR URL (matched against `Task.prUrl`), pod id, or DecisionRequest `_id`. */
  ref: string;
  addedAt: Date | string;
}

export interface InitiativeClose {
  at: Date | string;
  byUserId: string;
  evidenceUrl: string;
  note?: string;
}

export interface InitiativeInput {
  createdAt: Date | string;
  /** User id of the direction-giver. */
  direction: string;
  /** `owner.userId || owner.agentUserId`. */
  ownerId?: string | null;
  links: InitiativeLink[];
  cadence?: { windowHours?: number } | null;
  closed?: InitiativeClose | null;
}

export interface TaskRecord {
  _id: unknown;
  status: string;
  prUrl?: string | null;
  updates?: Array<{ text?: string; author?: string; authorId?: unknown; createdAt?: Date | string }>;
}

export interface DecisionRecord {
  _id: unknown;
  title: string;
  status: 'pending' | 'ruled' | string;
  ruling?: { at?: Date | string } | null;
}

export interface AttentionRecord {
  kind: string;
  status: string;
  recipientUserId: unknown;
  source: { type: string; id: string };
}

export interface InitiativeRecords {
  /** Tasks named by `task` links, plus tasks whose `prUrl` matches a `pr` link. */
  tasks: TaskRecord[];
  /** DecisionRequests named by `decision` links. */
  decisions: DecisionRecord[];
  /** Open attention items, for `waiting on you`. Others are ignored. */
  attention: AttentionRecord[];
}

export type InitiativeStatus =
  | 'closed'
  | 'closed-by-owner'
  | 'waiting-on-you'
  | 'blocked'
  | 'needs-your-check'
  | 'moving'
  | 'stalled';

export type PartState = 'moving' | 'stalled' | 'merged' | 'ruled' | 'pending';

export interface Evidence {
  kind: 'merge' | 'decision';
  /** The link the evidence was found through. */
  linkKind: InitiativeLinkKind;
  ref: string;
  at: Date;
}

export interface InitiativePart {
  kind: InitiativeLinkKind;
  ref: string;
  state: PartState;
  /** For `stalled`, the date the digest prints; otherwise the newest evidence, or null. */
  since: Date | null;
  /** The owner flagged the linked Task `blocked`. A note only; never a status. */
  ownerFlaggedBlocked?: boolean;
}

export interface DerivedInitiativeStatus {
  status: InitiativeStatus;
  /** Evidence-only activity, computed for every initiative regardless of `status`. */
  activity: { state: 'moving' | 'stalled'; since: Date };
  waitingOnYou: Array<{ decisionId: string; title: string }>;
  blockedOn: Array<{ decisionId: string; title: string }>;
  parts: InitiativePart[];
  /** Newest first. */
  evidence: Evidence[];
  /** True when the merge-to-check state holds; it never stalls and never nudges. */
  needsCheck: boolean;
}

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const idOf = (value: unknown): string => String(value ?? '');

const newest = (dates: Array<Date | null>): Date | null => dates
  .reduce<Date | null>((best, d) => (d && (!best || d > best) ? d : best), null);

/** Merge evidence on one Task: the webhook's own update, never an owner's note. */
export const mergeEvidenceDates = (task: TaskRecord): Date[] => (task.updates || [])
  .filter((u) => u.author === 'system' && (u.authorId === null || u.authorId === undefined)
    && u.text === MERGE_EVIDENCE_TEXT)
  .map((u) => toDate(u.createdAt))
  .filter((d): d is Date => d !== null);

/** Every task is `done` and carries its own merge record; a hand-closed task never counts. */
const allDoneAndMerged = (tasks: TaskRecord[]): boolean => tasks.length > 0
  && tasks.every((t) => t.status === 'done' && mergeEvidenceDates(t).length > 0);

const rulingDate = (decision: DecisionRecord): Date | null => (decision.status === 'ruled'
  ? toDate(decision.ruling?.at) : null);

export const deriveInitiativeStatus = (
  initiative: InitiativeInput,
  records: InitiativeRecords,
  now: Date = new Date(),
): DerivedInitiativeStatus => {
  const windowHours = initiative.cadence?.windowHours && initiative.cadence.windowHours > 0
    ? initiative.cadence.windowHours : DEFAULT_WINDOW_HOURS;
  const windowStart = new Date(now.getTime() - windowHours * 3600 * 1000);
  const createdAt = toDate(initiative.createdAt) || now;

  const tasksById = new Map(records.tasks.map((t) => [idOf(t._id), t]));
  const decisionsById = new Map(records.decisions.map((d) => [idOf(d._id), d]));

  const evidence: Evidence[] = [];
  const parts: InitiativePart[] = [];
  const linkedTasks = new Map<string, TaskRecord>();

  const activePart = (link: InitiativeLink, last: Date | null): InitiativePart => {
    if (last && last >= windowStart) return { kind: link.kind, ref: link.ref, state: 'moving', since: last };
    return { kind: link.kind, ref: link.ref, state: 'stalled', since: last || toDate(link.addedAt) || createdAt };
  };

  initiative.links.forEach((link) => {
    if (link.kind === 'task' || link.kind === 'pr') {
      const tasks = link.kind === 'task'
        ? [tasksById.get(link.ref)].filter((t): t is TaskRecord => Boolean(t))
        : records.tasks.filter((t) => t.prUrl && t.prUrl === link.ref);
      tasks.forEach((t) => linkedTasks.set(idOf(t._id), t));
      const merges = tasks.flatMap(mergeEvidenceDates);
      merges.forEach((at) => evidence.push({ kind: 'merge', linkKind: link.kind, ref: link.ref, at }));
      const last = newest(merges);
      const part = allDoneAndMerged(tasks) && last
        ? { kind: link.kind, ref: link.ref, state: 'merged' as PartState, since: last }
        : activePart(link, last);
      if (tasks.some((t) => t.status === 'blocked')) part.ownerFlaggedBlocked = true;
      parts.push(part);
    } else if (link.kind === 'decision') {
      const decision = decisionsById.get(link.ref);
      if (!decision) return;
      const at = rulingDate(decision);
      if (at) {
        evidence.push({ kind: 'decision', linkKind: 'decision', ref: link.ref, at });
        parts.push({ kind: 'decision', ref: link.ref, state: 'ruled', since: at });
      } else if (decision.status === 'pending') {
        parts.push({ kind: 'decision', ref: link.ref, state: 'pending', since: null });
      }
    }
    // A pod link is context for the digest; no record dates it.
  });

  evidence.sort((a, b) => b.at.getTime() - a.at.getTime());
  const lastEvidence = evidence[0]?.at || null;
  const activity = lastEvidence && lastEvidence >= windowStart
    ? { state: 'moving' as const, since: lastEvidence }
    : { state: 'stalled' as const, since: lastEvidence || createdAt };

  const pending = initiative.links
    .filter((l) => l.kind === 'decision')
    .map((l) => decisionsById.get(l.ref))
    .filter((d): d is DecisionRecord => d?.status === 'pending');
  const giver = idOf(initiative.direction);
  const giverItems = new Set(records.attention
    .filter((a) => a.kind === 'decision' && a.status === 'open'
      && a.source?.type === 'decision_request' && idOf(a.recipientUserId) === giver)
    .map((a) => idOf(a.source.id)));
  const waitingOnYou = pending
    .filter((d) => giverItems.has(idOf(d._id)))
    .map((d) => ({ decisionId: idOf(d._id), title: d.title }));
  const blockedOn = pending.map((d) => ({ decisionId: idOf(d._id), title: d.title }));

  const tasks = [...linkedTasks.values()];
  const needsCheck = allDoneAndMerged(tasks);

  // A close counts only when the giver wrote it; the close route enforces that,
  // and the derivation does not trust a row that says otherwise.
  const close = initiative.closed && idOf(initiative.closed.byUserId) === giver
    && toDate(initiative.closed.at) && initiative.closed.evidenceUrl ? initiative.closed : null;

  let status: InitiativeStatus;
  if (close) status = initiative.ownerId && idOf(initiative.ownerId) === giver ? 'closed-by-owner' : 'closed';
  else if (waitingOnYou.length) status = 'waiting-on-you';
  else if (blockedOn.length) status = 'blocked';
  else if (needsCheck) status = 'needs-your-check';
  else status = activity.state;

  return {
    status, activity, waitingOnYou, blockedOn, parts, evidence, needsCheck: !close && needsCheck,
  };
};
