/**
 * The board's record lines (record-v1 §2, Claim; ADR-033 D4). The board is
 * the source of truth: these lines mirror a status change that has already
 * committed, and they never move the board.
 */
import { BOARD_ACTOR, emitRecord, type RecordActor, type RecordLineInput } from './recordService';

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'blocked' | string;

export type TaskTransition = {
  podId: unknown;
  task: { _id?: unknown; taskId?: unknown; updatedAt?: Date | null } | null | undefined;
  from: TaskStatus | null | undefined;
  to: TaskStatus;
  /**
   * When the source write committed. The event key prefers the row's own
   * `updatedAt`, which the revision CAS persists and advances on every write
   * (`max(now, previous + 1)`), so two transitions never share a key and a
   * redelivery of one always does. `at` keys writers that bypass the CAS.
   */
  at: Date;
  /**
   * task.claimed: the lease this write set. Only a writer that sets a lease
   * (a claim, or a note that restores one) passes it. A PATCH to `claimed`
   * sets none, and the row's older lease must not be reported as this one's.
   */
  leaseUntil?: Date | null;
  /** Who made the change. Unused for task.done, whose actor is the board. */
  actor?: RecordActor | null;
  /** task.done: the user who completed it, when a user did. */
  doneBy?: unknown;
  /** task.released: why, when the caller knows (`lease_expired`). */
  reason?: string;
  /**
   * The claim route knows whether the holder already held the claim: then the
   * claim only renews a lease, which is not news. Other writers leave it unset,
   * and a claimed row that stays claimed counts as no change.
   */
  renewal?: boolean;
};

/** The record line a board transition writes, or null when it writes none. */
export const taskTransitionLine = (change: TaskTransition): RecordLineInput | null => {
  const { from, to } = change;
  if (to === 'claimed' && !(change.renewal ?? from === 'claimed')) {
    const leaseUntil = change.leaseUntil instanceof Date ? change.leaseUntil.toISOString() : undefined;
    return { kind: 'task.claimed', actor: change.actor ?? null, data: leaseUntil ? { leaseUntil } : {} };
  }
  if (to === 'done' && from !== 'done') {
    const doneBy = change.doneBy ? String(change.doneBy) : undefined;
    return { kind: 'task.done', actor: BOARD_ACTOR, data: doneBy ? { doneBy } : {} };
  }
  if (from === 'claimed' && (to === 'blocked' || to === 'pending')) {
    const reason = to === 'blocked' ? 'blocked' : change.reason;
    return { kind: 'task.released', actor: change.actor ?? null, data: reason ? { reason } : {} };
  }
  return null;
};

/** Emit the line for a committed board transition, if it has one. Never throws. */
export const recordTaskTransition = (change: TaskTransition): void => {
  const podId = change.podId ? String(change.podId) : '';
  const taskId = change.task?.taskId ? String(change.task.taskId) : '';
  if (!podId || !taskId) return;
  const line = taskTransitionLine(change);
  if (!line) return;
  const source = change.task?._id ? String(change.task._id) : taskId;
  const revision = change.task?.updatedAt instanceof Date ? change.task.updatedAt : change.at;
  emitRecord({ podId, taskId }, `${line.kind}/${source}/${revision.toISOString()}`, [line]);
};
