import Task from '../../models/Task';
import { completeTaskWithRevision } from '../taskMutationCore';
import { advancePlaybookRun } from './runState';
import { loadPlaybookContext } from './context';
import { deliverPlaybookStep, PlaybookWake, ProposePlaybookCard } from './delivery';

/** Settlement is bound to the runner's claim, never to an agent/model's task-id argument. */
export const settleNativePlaybookStep = async (
  event: { podId: string; agentName: string; instanceId?: string; payload?: Record<string, any> },
  result: { status?: string; postedMessageIds?: string[] },
  enqueue: (event: PlaybookWake) => Promise<unknown>,
  proposeAction: ProposePlaybookCard,
): Promise<boolean> => {
  const taskId = event.payload?.playbookTaskId;
  if (typeof taskId !== 'string' || !/^TASK-\d+$/.test(taskId)) return false;
  const claimedAt = new Date(event.payload?.playbookClaimedAt || '');
  if (!Number.isFinite(claimedAt.getTime())) return false; // BYO events settle through task tools.
  const podId = String(event.podId);
  const context = await loadPlaybookContext(podId);
  const actor = context.members.find((member) => member.agentName === event.agentName
    && (member.instanceId || 'default') === (event.instanceId || 'default') && member.runtime === 'native');
  if (!actor) return true; // A departed/uninstalled actor cannot move a row.
  const filter = { podId, taskId, source: 'playbook', status: 'claimed', claimedBy: actor.userId,
    assignee: actor.handle, claimedAt, rescueDeferrals: event.payload?.playbookAttempt || 0 };
  const posted = result.status === 'succeeded' && Array.isArray(result.postedMessageIds)
    && result.postedMessageIds.some((id) => typeof id === 'string' && id.length > 0);
  if (posted) {
    const completed = await completeTaskWithRevision(filter, { $set: { status: 'done', completedAt: new Date() },
      $push: { updates: { author: 'playbook', createdAt: new Date(),
        text: `Native result posted: ${result.postedMessageIds!.join(', ')}` } } },
    { userId: actor.userId, assignee: actor.handle, isBot: true });
    if (completed) {
      const next = await advancePlaybookRun(podId, taskId);
      if (next) await deliverPlaybookStep(podId, next.taskId, enqueue, proposeAction);
    }
    return true;
  }
  const retry = Number(event.payload?.playbookAttempt || 0) < 1;
  const changed = await Task.findOneAndUpdate(filter, {
    $set: { status: retry ? 'pending' : 'blocked', claimedBy: null, claimedAt: null, claimExpiresAt: null },
    $inc: { rescueDeferrals: 1 }, $unset: { offeredAt: '' },
    $push: { updates: { author: 'playbook', createdAt: new Date(),
      text: retry ? 'No native post; retrying once' : 'No native post after retry; run blocked' } },
  }, { new: true });
  if (changed && retry) await deliverPlaybookStep(podId, taskId, enqueue, proposeAction);
  if (changed && !retry) await Task.updateOne({ podId, taskId: changed.parentTask, source: 'playbook',
    guard: 'kernel', status: { $ne: 'done' } }, {
    $set: { status: 'blocked' }, $push: { updates: { author: 'playbook', createdAt: new Date(),
      text: `${taskId}: no native post after retry` } },
  });
  return true;
};
