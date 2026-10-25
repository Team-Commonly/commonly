import Task from '../../models/Task';
import { taskActionConditions } from '../playbookTaskPolicy';
import { claimTaskWithRevision } from '../taskMutationCore';
import { PlaybookError } from './definition';
import { loadPlaybookContext } from './context';
import { describePlaybookPoint } from './rulings';
import { publishPlaybookTask } from './observations';

export type ProposePlaybookCard = typeof import('../approvalActionService').proposeAction;

export type PlaybookWake = { agentName: string; instanceId: string; podId: string; type: 'chat.mention';
  payload: Record<string, unknown> };

/** Enqueue is supplied by the event service itself or its caller, avoiding an event/runtime import cycle. */
export const deliverPlaybookStep = async (
  podId: string, taskId: string, enqueue: (event: PlaybookWake) => Promise<unknown>,
  proposeAction: ProposePlaybookCard,
) => {
  const step = await Task.findOne({ podId, taskId, source: 'playbook', status: 'pending' });
  if (!step) return;
  if (step.ruling?.state === 'awaiting') {
    // The step's reservation gives every retry the same card identity.
    const point = await describePlaybookPoint(podId, taskId, String(step.ruling.approvalId));
    const offered = await Task.findOneAndUpdate({ _id: step._id, offeredAt: { $exists: false },
      'ruling.state': 'awaiting', 'ruling.approvalId': step.ruling.approvalId }, { $set: { offeredAt: new Date() } });
    if (!offered) return;
    try {
      const proposed = await proposeAction({ podId, agentName: point.agent.agentName!,
        instanceId: point.agent.instanceId || 'default', actionType: 'playbook_step',
        reservedApprovalId: String(step.ruling.approvalId), params: point.params, summary: point.summary });
      if (!proposed.ok) throw new PlaybookError('approval_failed', proposed.error || 'Approval card failed');
    } catch (error) {
      await Task.updateOne({ _id: step._id, 'ruling.state': 'awaiting' }, { $unset: { offeredAt: '' } });
      throw error;
    }
    return;
  }
  if (step.ruling && step.ruling.state !== 'approved') return;
  if (step.guard === 'kernel' || step.guard === 'person') return;
  const context = await loadPlaybookContext(podId);
  const actor = context.members.find((member) => member.handle === step.assignee && member.kind === 'agent');
  if (!actor?.agentName || !actor.runtime) throw new PlaybookError('agent_not_installed', 'Step actor is not installed');
  const now = new Date();
  const filter = { podId, taskId, status: 'pending', offeredAt: { $exists: false },
    $and: [taskActionConditions({ userId: actor.userId, assignee: actor.handle, isBot: true })] };
  const offered = actor.runtime === 'native'
    ? (await claimTaskWithRevision(filter, { $set: { status: 'claimed', claimedBy: actor.userId, claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + 30 * 60_000), offeredAt: now } },
    { userId: actor.userId, assignee: actor.handle, isBot: true }))?.task
    : await Task.findOneAndUpdate(filter, { $set: { offeredAt: now } }, { new: true });
  if (!offered) return;
  await publishPlaybookTask(offered);
  const content = [`[Playbook step assigned to you: ${taskId}]`, step.title, step.notes || '',
    actor.runtime === 'native' ? 'Post the result in this pod. The workflow records completion from that post.'
      : 'Claim this task, do the step, then complete it with your task tools. Keep any PR link on the row.',
  ].join('\n\n');
  try {
    await enqueue({ podId, agentName: actor.agentName, instanceId: actor.instanceId || 'default', type: 'chat.mention',
      payload: { podId, content, triggerAuthor: 'kernel', boardWake: true, taskId, playbookTaskId: taskId,
        playbookAttempt: offered.rescueDeferrals || 0,
        ...(actor.runtime === 'native' ? { playbookClaimedAt: now.toISOString(), playbookActorId: actor.userId } : {}) } });
  } catch (error) {
    await Task.updateOne({ _id: step._id, offeredAt: now }, { $unset: { offeredAt: '' },
      ...(actor.runtime === 'native' ? { $set: { status: 'pending', claimedBy: null, claimedAt: null, claimExpiresAt: null } } : {}) });
    throw error;
  }
};
