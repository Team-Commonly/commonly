import { randomUUID } from 'crypto';
import Installation from '../../models/InstallableInstallation';
import Task from '../../models/Task';
import ApprovalAction from '../../models/ApprovalAction';
import AgentEventService from '../agentEventService';
import { proposeAction } from '../approvalActionService';
import { startPlaybookRun, advancePlaybookRun } from './runState';
import { deliverPlaybookStep } from './delivery';
import { settleNativePlaybookStep } from './nativeSettle';
import { applyPlaybookRuling, askPlaybookPointAgain } from './rulings';
import { loadPlaybookContext } from './context';
import { playbookConfig } from './store';
import { latestScheduleSlot } from './schedule';
import { PlaybookError } from './definition';

const enqueue = (event: Parameters<typeof AgentEventService.enqueue>[0]) => AgentEventService.enqueue(event);
const deliver = (podId: string, taskId: string) => deliverPlaybookStep(podId, taskId, enqueue, proposeAction);

export const runPlaybookManually = async (options: {
  podId: string; installationId: string; userId: string; input: string; requestId?: string;
}) => {
  const result = await startPlaybookRun({ ...options, triggerKey: `manual:${options.requestId || randomUUID()}`,
    label: 'Runs when someone presses Run' });
  if (result.step) await deliver(options.podId, result.step.taskId);
  return result;
};

/** Every replica may tick; the installation lease and task indexes choose a single run. */
export const tickPlaybookSchedules = async (now = new Date()) => {
  if (process.env.PLAYBOOKS_ENABLED !== 'true') return;
  const installations = await Installation.find({ status: 'active', targetType: 'pod',
    'components.componentName': 'playbook', 'components.config.schedule': { $exists: true } }).lean();
  for (const installation of installations) {
    const config = playbookConfig(installation);
    try {
      const slot = latestScheduleSlot(config.schedule, new Date(config.onAt), now);
      if (!slot) continue;
      const podId = String(installation.targetId);
      const result = await startPlaybookRun({ podId, installationId: String(installation._id),
        userId: String(config.onBy), triggerKey: slot.key, label: slot.label, input: '' });
      if (result.step) await deliver(podId, result.step.taskId);
    } catch (error) {
      if (!(error instanceof PlaybookError)) throw error;
      if (error.code !== 'playbook_busy') await Installation.updateOne({ _id: installation._id }, {
        $set: { errorMessage: `Scheduled run refused: ${error.message}` },
      });
    }
  }
};

const blockRun = async (podId: string, runId: string, reason: string) => Task.updateOne({ podId,
  taskId: runId, source: 'playbook', guard: 'kernel', status: { $ne: 'done' } }, {
  $set: { status: 'blocked' }, $push: { updates: { author: 'playbook', createdAt: new Date(), text: reason } },
});

/** Recover row/card/delivery gaps without creating another trigger or resetting an assignee. */
export const reconcilePlaybookRuns = async (now = new Date()) => {
  if (process.env.PLAYBOOKS_ENABLED !== 'true') return;
  const roots = await Task.find({ source: 'playbook', guard: 'kernel', parentTask: null,
    status: { $ne: 'done' } }).sort({ updatedAt: 1 }).limit(100).lean();
  for (const root of roots) {
    const podId = String(root.podId);
    try {
      let step = await advancePlaybookRun(podId, root.taskId);
      if (!step) continue;
      if (step.ruling?.state === 'awaiting') {
        const card = await ApprovalAction.findById(step.ruling.approvalId);
        if (card?.status === 'resolved') {
          await applyPlaybookRuling(card);
          step = await advancePlaybookRun(podId, root.taskId);
        } else if (card && ['moot', 'expired'].includes(card.status)) {
          await blockRun(podId, root.taskId, `${step.taskId}: approval card could not be delivered`);
          continue;
        } else if (!card && step.offeredAt && now.getTime() - step.offeredAt.getTime() >= 5 * 60_000) {
          await Task.updateOne({ _id: step._id, offeredAt: step.offeredAt, 'ruling.state': 'awaiting' },
            { $unset: { offeredAt: '' } });
        }
      }
      if (!step || step.status === 'done' || step.status === 'blocked') continue;
      const age = now.getTime() - (step.offeredAt?.getTime() || now.getTime());
      if (step.offeredAt && age >= 30 * 60_000 && step.ruling?.state !== 'awaiting') {
        const context = await loadPlaybookContext(podId);
        const actor = context.members.find((member) => member.handle === step!.assignee && member.kind === 'agent');
        if (actor?.runtime === 'native' && step.status === 'claimed') {
          await settleNativePlaybookStep({ podId, agentName: actor.agentName!, instanceId: actor.instanceId,
            payload: { playbookTaskId: step.taskId, playbookClaimedAt: step.claimedAt?.toISOString(),
              playbookAttempt: step.rescueDeferrals || 0 } }, { status: 'failed', postedMessageIds: [] }, enqueue, proposeAction);
          continue;
        }
        if (actor?.runtime === 'byo' && (step.rescueDeferrals || 0) < 1
          && (step.status === 'pending' || (step.claimExpiresAt && step.claimExpiresAt <= now))) {
          await Task.updateOne({ _id: step._id, offeredAt: step.offeredAt, status: step.status,
            rescueDeferrals: step.rescueDeferrals || 0, updatedAt: step.updatedAt,
            claimedAt: step.claimedAt, claimExpiresAt: step.claimExpiresAt }, { $set: { status: 'pending', claimedBy: null,
            claimedAt: null, claimExpiresAt: null }, $unset: { offeredAt: '' }, $inc: { rescueDeferrals: 1 } });
        }
      }
      await deliver(podId, step.taskId);
    } catch (error) {
      if (!(error instanceof PlaybookError)) throw error;
      if (error.code !== 'playbook_busy') await blockRun(podId, root.taskId, error.message);
    }
  }
};

export const askAgainForPlaybookPoint = async (podId: string, taskId: string, userId: string) => {
  const row = await askPlaybookPointAgain(podId, taskId, userId);
  await deliver(podId, row.taskId);
  return row;
};
