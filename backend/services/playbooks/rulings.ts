import { Types } from 'mongoose';
import ApprovalAction, { IApprovalAction } from '../../models/ApprovalAction';
import Task from '../../models/Task';
import MongoMessage from '../../models/Message';
import { PlaybookError, validatePlaybook } from './definition';
import { loadPlaybookContext } from './context';
import { preflightPlaybook } from './preflight';
import { withPlaybookLock, playbookConfig, playbookDefinition, requirePlaybookHuman } from './store';
import { advancePlaybookRun } from './runState';
import { publishPlaybookTask, blockPlaybookRun } from './observations';

/** Only a stored post by the preceding actor in this pod is presented as output. */
const precedingOutput = async (podId: string, source: any, actorId: string) => {
  if (!source) return null;
  const notes = { taskId: source.taskId, kind: 'notes',
    url: `/v2/pods/${podId}/board`, excerpt: String(source.notes || '').slice(0, 600) };
  const receipt = [...source.updates].reverse().find((entry: any) => entry.author === 'playbook'
    && entry.text.startsWith('Native result posted: '));
  const ids = String(receipt?.text || '').replace(/^Native result posted: /, '').split(', ').slice(-10).reverse();
  for (const id of ids) {
    let message: { pod?: unknown; author?: unknown; content?: string; at?: unknown } | null = null;
    if (/^[a-f0-9]{24}$/.test(id)) {
      const row = await MongoMessage.findOne({ _id: id, podId, userId: actorId }).select('content createdAt').lean();
      if (row) message = { pod: podId, author: actorId, content: row.content, at: row.createdAt };
    } else if (process.env.PG_HOST && /^\d+$/.test(id)) {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const PGMessage = require('../../models/pg/Message');
      const row = await PGMessage.findById(id);
      if (row) message = { pod: row.pod_id, author: row.user_id, content: row.content, at: row.createdAt };
    }
    const at = new Date(message?.at as string).getTime();
    if (message?.content && String(message.pod) === podId && String(message.author) === actorId
      && at >= source.createdAt.getTime() && at <= (source.completedAt?.getTime() || Date.now())) {
      return { taskId: source.taskId, kind: 'post', url: `/v2/pods/${podId}#message-${id}`,
        excerpt: message.content.slice(0, 600) };
    }
  }
  if (source.prUrl) {
    try {
      const link = new URL(source.prUrl);
      if (link.protocol === 'https:') return { ...notes, kind: 'pr', url: link.href };
    } catch { /* Invalid stored links remain plain step notes. */ }
  }
  return notes;
};

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
    const priorIndex = preceding && book.steps.indexOf(preceding);
    const prior = typeof priorIndex === 'number' ? await Task.findOne({ podId, source: 'playbook',
      sourceRef: `${point.root.sourceRef}:${priorIndex + 1}` }).lean() : null;
    const output = await precedingOutput(podId, prior, agent.userId);
    return { ...point, agent, ownerUserId: members.get(definition.approval.by)!.userId,
      params: { taskId, runTaskId: point.root.taskId, installationId: point.installationId,
        title: definition.title, act: definition.approval.act, effect: 'none', output },
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
    await publishPlaybookTask(updated);
    if (updated && !approved) await blockPlaybookRun(podId, point.root.taskId, `Approval declined: ${definition.title}`);
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
    const resumed = await Task.findOneAndUpdate({ _id: point.root._id, status: 'blocked' },
      { $set: { status: 'claimed' } }, { new: true });
    await publishPlaybookTask(resumed);
    await publishPlaybookTask(row);
    return row;
  });
};
