import Task from '../../models/Task';
import User from '../../models/User';
import Pod from '../../models/Pod';
import { emitTaskUpdated, TaskEventKind } from '../taskEventService';
import { recordTaskAttention, resolveTaskAttention } from '../attentionItemService';

/** Board updates are socket-only; the runner owns addressed agent delivery. */
export const publishPlaybookTask = async (task: any, kind: TaskEventKind = 'updated'): Promise<void> => {
  if (!task) return;
  emitTaskUpdated(String(task.podId), task.toObject?.() || task, kind);
  if (task.source !== 'playbook' || task.guard !== 'kernel' || task.parentTask) return;
  if (task.status !== 'blocked') {
    await resolveTaskAttention(task);
    return;
  }
  // The On owner is an immutable user ID on the root. Never let a departed
  // owner fall through the generic attention writer to the pod's creator.
  const [owner, pod] = await Promise.all([
    User.findById(task.claimedBy).select('username isBot botType').lean(),
    Pod.findById(task.podId).select('members').lean(),
  ]);
  if (!owner || owner.isBot || owner.botType || !pod?.members.some((id) => String(id) === String(owner._id))) return;
  await recordTaskAttention({ ...(task.toObject?.() || task), assignee: owner.username },
    { includeBlocked: true, suppressEmail: true });
};

/** One blocked transition creates one owner notification, even across sweeps. */
export const blockPlaybookRun = async (podId: string, taskId: string, reason: string) => {
  const root = await Task.findOneAndUpdate({ podId, taskId, source: 'playbook', guard: 'kernel', parentTask: null,
    status: { $nin: ['done', 'blocked'] } }, {
    $set: { status: 'blocked' },
    $push: { updates: { author: 'playbook', createdAt: new Date(), text: reason } },
  }, { new: true });
  await publishPlaybookTask(root);
  return root;
};
