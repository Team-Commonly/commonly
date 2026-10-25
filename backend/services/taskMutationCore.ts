import { taskActionConditions, TaskActor } from './playbookTaskPolicy';
import Task from '../models/Task';

// A pending unassigned row is offered again only when updatedAt advances past
// offeredAt. Mongoose's wall-clock timestamp can run behind a revision bumped
// by a concurrent PATCH, so task writes reserve the next value
// against the stored revision instead of letting a later write move it back.
export const updateTaskWithRevisionSnapshot = async (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
) => {
  const key = { podId: filter.podId, taskId: filter.taskId };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const current = await Task.findOne(key).select('updatedAt claimedBy lapsedFrom assignee status').lean();
    if (!current) return null;
    const writeTime = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
    // eslint-disable-next-line no-await-in-loop
    const task = await Task.findOneAndUpdate(
      {
        ...filter,
        updatedAt: current.updatedAt,
        assignee: current.assignee ?? null,
        // A caller may already constrain claimedBy (note renewal). Preserve
        // that predicate; otherwise bind the ownership snapshot to this CAS.
        ...('claimedBy' in filter ? {} : { claimedBy: current.claimedBy ?? null }),
      },
      { ...update, $set: { ...(update.$set as Record<string, unknown> || {}), updatedAt: writeTime } },
      { new: true, timestamps: false },
    );
    // The revision and ownership predicates bind this snapshot to the write.
    if (task) return { task, previous: current };
    // Retry a changed revision, owner, or status; otherwise a caller predicate
    // (such as a live lease) refused the write.
    // eslint-disable-next-line no-await-in-loop
    const latest = await Task.findOne(key).select('updatedAt assignee claimedBy status').lean();
    if (!latest || (latest.updatedAt.getTime() === current.updatedAt.getTime()
      && (latest.assignee ?? null) === (current.assignee ?? null)
      && (latest.claimedBy ?? null) === (current.claimedBy ?? null)
      && latest.status === current.status)) return null;
  }
  return null;
};

export const updateTaskWithRevision = async (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
) => (await updateTaskWithRevisionSnapshot(filter, update))?.task || null;

const updateTaskAsActor = (filter: Record<string, unknown>, update: Record<string, unknown>, actor: TaskActor) => updateTaskWithRevisionSnapshot({
  ...filter, $and: [...((filter.$and as Record<string, unknown>[]) || []), taskActionConditions(actor)],
}, update);

export const claimTaskWithRevision = updateTaskAsActor;

export const completeTaskWithRevision = async (
  filter: Record<string, unknown>, update: Record<string, unknown>, actor: TaskActor,
) => {
  const task = (await updateTaskAsActor(filter, {
    ...update, $set: { ...(update.$set as Record<string, unknown>), completedBy: actor.userId },
  }, actor))?.task || null;
  return task;
};
