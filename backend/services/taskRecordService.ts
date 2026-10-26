/**
 * The board's record lines (record-v1 §2, Claim; ADR-033 D4). The board is
 * the source of truth: these lines mirror a status change that has already
 * committed, and they never move the board.
 */
import { BOARD_ACTOR, emitRecord, type RecordActor, type RecordLineInput } from './recordService';

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'blocked' | string;

export type TaskTransition = {
  podId: unknown;
  task: { _id?: unknown; taskId?: unknown; claimExpiresAt?: Date | null } | null | undefined;
  from: TaskStatus | null | undefined;
  to: TaskStatus;
  /** When the source write committed; also keys a redelivery to one write. */
  at: Date;
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
    const lease = change.task?.claimExpiresAt;
    const leaseUntil = lease instanceof Date ? lease.toISOString() : undefined;
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
  emitRecord({ podId, taskId }, `${line.kind}/${source}/${change.at.toISOString()}`, [line]);
};
