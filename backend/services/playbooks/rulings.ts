import { Types } from 'mongoose';
import ApprovalAction, { IApprovalAction } from '../../models/ApprovalAction';
import Task from '../../models/Task';
import { PlaybookError, validatePlaybook } from './definition';
import { loadPlaybookContext } from './context';
import { preflightPlaybook } from './preflight';
import { withPlaybookLock, playbookConfig, playbookDefinition, requirePlaybookHuman } from './store';
import { advancePlaybookRun } from './runState';

export const loadPlaybookPoint = async (podId: string, taskId: string) => {
  const step = await Task.findOne({ podId, taskId, source: 'playbook', parentTask: { $ne: null } });
  const root = step && await Task.findOne({ podId, taskId: step.parentTask, source: 'playbook', guard: 'kernel',
    parentTask: null, status: { $ne: 'done' } });
  const identity = /^playbook:([a-f0-9]{24}):/.exec(root?.sourceRef || '');
  if (!step || !root || !identity || !step.ruling) throw new PlaybookError('point_not_found', 'Open approval point not found');
  return { step, root, installationId: identity[1] };
};

/** Card data is reconstructed from server records, never the proposer's effect or owner. */
export const describePlaybookPoint = async (podId: string, taskId: string, reservedId: string) => {
  const point = await loadPlaybookPoint(podId, taskId);
  return withPlaybookLock(podId, point.installationId, async (installation, installable) => {
    const fresh = await Task.findById(point.step._id);
    if (!fresh || fresh.ruling?.state !== 'awaiting'
      || String(fresh.ruling.approvalId) !== reservedId) {
      throw new PlaybookError('point_not_awaiting', 'Point is not awaiting this card');
    }
    const { book, members } = preflightPlaybook(playbookDefinition(installable),
      playbookConfig(installation).bindings, await loadPlaybookContext(podId));
    const index = book.steps.findIndex((_, n) => point.step.sourceRef === `${point.root.sourceRef}:${n + 1}`);
    const definition = book.steps[index];
    if (!definition?.approval || String(point.step.ruling?.approvalId) !== reservedId
      || point.step.ruling?.state !== 'awaiting') throw new PlaybookError('point_not_awaiting', 'Point is not awaiting this card');
    const preceding = book.steps.slice(0, index).reverse()
      .find((step) => book.roles.find((role) => role.key === step.role)?.kind === 'agent');
    const firstAgentRole = book.roles.find((role) => role.kind === 'agent');
    const agent = members.get(preceding?.role || firstAgentRole?.key || '');
    if (!agent?.agentName) throw new PlaybookError('agent_role_required', 'An approval point requires an active agent role');
    return { ...point, agent, ownerUserId: members.get(definition.approval.by)!.userId,
      params: { taskId, runTaskId: point.root.taskId, installationId: point.installationId,
        title: definition.title, act: definition.approval.act, effect: 'none' },
      summary: `${definition.title}: ${definition.approval.act === 'kernel' ? 'Runs when approved' : 'Enforced on the record, not on the action'}` };
  });
};

/** The resolved card is the authority; one CAS applies it to an open run's waiting row. */
export const applyPlaybookRuling = async (card: IApprovalAction) => {
  if (card.actionType !== 'playbook_step' || card.status !== 'resolved' || !card.resolvedBy || !card.resolvedAt
    || !['approved', 'declined'].includes(card.decision || '')) throw new PlaybookError('invalid_ruling', 'Card is not decided');
  const podId = String(card.podId);
  const taskId = String(card.params?.taskId || '');
  const point = await loadPlaybookPoint(podId, taskId);
  await requirePlaybookHuman(podId, String(card.resolvedBy));
  const changed = await withPlaybookLock(podId, point.installationId, async (installation, installable) => {
    const book = validatePlaybook(playbookDefinition(installable));
    const config = playbookConfig(installation);
    const index = book.steps.findIndex((_, n) => point.step.sourceRef === `${point.root.sourceRef}:${n + 1}`);
    const definition = book.steps[index];
    const approver = definition?.approval && config.bindings?.[definition.approval.by];
    if (!approver || approver !== String(card.ownerUserId) || approver !== String(card.resolvedBy)
      || card.params?.runTaskId !== point.root.taskId || card.params?.installationId !== point.installationId) {
      throw new PlaybookError('ruling_owner', 'Only the bound human approver can rule on this point', 403);
    }
    // Re-read under the same lock that finalizes roots, so a late card cannot
    // mutate a completed run. Completion also preserves the immutable card id.
    const open = await Task.exists({ _id: point.root._id, status: { $ne: 'done' } });
    if (!open) return null;
    const approved = card.decision === 'approved';
    const kernel = definition.approval!.act === 'kernel';
    const updated = await Task.findOneAndUpdate({ _id: point.step._id, status: { $ne: 'done' },
      'ruling.approvalId': card._id, 'ruling.state': 'awaiting' }, {
      $set: { 'ruling.state': card.decision, 'ruling.decidedBy': card.resolvedBy, 'ruling.decidedAt': card.resolvedAt,
        status: approved ? (kernel ? 'done' : 'pending') : 'blocked',
        ...(approved && kernel ? { completedAt: card.resolvedAt } : {}) },
      ...(approved && !kernel ? { $unset: { offeredAt: '' } } : {}),
      $push: { updates: { author: 'playbook', createdAt: new Date(),
        text: `${approved ? 'Approved' : 'Declined'} · card ${card._id}` } },
    }, { new: true });
    if (updated && !approved) await Task.updateOne({ _id: point.root._id, status: { $ne: 'done' } }, {
      $set: { status: 'blocked' }, $push: { updates: { author: 'playbook', createdAt: new Date(),
        text: `Approval declined: ${definition.title}. Run owner: ${config.onBy}` } },
    });
    return updated;
  });
  if (changed?.status === 'done') await advancePlaybookRun(podId, taskId);
  return { taskId, applied: Boolean(changed), status: changed?.status || point.step.status };
};

export const reconcilePlaybookRuling = async (podId: string, taskId: string) => {
  const { step } = await loadPlaybookPoint(podId, taskId);
  const card = await ApprovalAction.findOne({ _id: step.ruling!.approvalId, podId, actionType: 'playbook_step', status: 'resolved' });
  return card ? applyPlaybookRuling(card) : null;
};

export const askPlaybookPointAgain = async (podId: string, taskId: string, userId: string) => {
  await requirePlaybookHuman(podId, userId);
  const point = await loadPlaybookPoint(podId, taskId);
  return withPlaybookLock(podId, point.installationId, async (installation, installable) => {
    const config = playbookConfig(installation);
    const { book, members } = preflightPlaybook(playbookDefinition(installable), config.bindings,
      await loadPlaybookContext(podId));
    const index = book.steps.findIndex((_, n) => point.step.sourceRef === `${point.root.sourceRef}:${n + 1}`);
    const approval = book.steps[index]?.approval;
    if (!approval || (userId !== config.onBy && userId !== members.get(approval.by)?.userId)) {
      throw new PlaybookError('ruling_owner', 'Only the run owner or bound approver can ask again', 403);
    }
    const open = await Task.exists({ _id: point.root._id, status: { $ne: 'done' } });
    if (!open) throw new PlaybookError('run_closed', 'This run is already complete');
    const row = await Task.findOneAndUpdate({ _id: point.step._id, status: 'blocked', 'ruling.state': 'declined',
      'ruling.approvalId': point.step.ruling!.approvalId }, {
      $set: { status: 'pending', ruling: { state: 'awaiting', approvalId: new Types.ObjectId() } },
      $unset: { offeredAt: '' },
      $push: { updates: { author: 'playbook', authorId: userId, createdAt: new Date(), text: 'Asked for a new ruling' } },
    }, { new: true });
    if (!row) throw new PlaybookError('point_not_declined', 'Only a declined point can be asked again');
    await Task.updateOne({ _id: point.root._id, status: 'blocked' }, { $set: { status: 'claimed' } });
    return row;
  });
};
