/**
 * starterTaskService — #916
 *
 * The signup flow seeds three starter tasks (authController.
 * createDefaultWorkspacePod), identified by stable sourceRef keys. TASK-001
 * "Connect your first agent" describes an event the kernel can observe
 * directly: a BYO runtime token authenticating for the first time (#909's
 * verified-listening moment). Completing the card from that fact keeps the
 * board honest — before this, the Guide would narrate "that's your first
 * starter task done" while the card sat in Pending forever.
 *
 * Caller contract: fire-and-forget from the token-auth first-use paths
 * (agentRuntimeAuth HTTP + agentWebSocketService WS), and from the native
 * hosted provision (routes/hosted.ts), where no token exists to be first-used
 * and the agent is live once provisioned. Never throws; a board write must not
 * be able to fail an auth or provision request.
 *
 * TASK-002 "Give your agent its first task" completes on the first ANSWER an
 * agent gives the workspace owner (QA walk 3, 2026-10-16: it stayed pending
 * after four answered asks). Who was answered is agentAnswerService's rule,
 * the same one attention uses. Called fire-and-forget from
 * AgentMessageService.postMessage after a post lands; same contract.
 */
import mongoose from 'mongoose';
import Task from '../models/Task';
import { onTaskClosed } from './roomGrantService';
import { humansAnsweredBy } from './agentAnswerService';
import { recordTaskTransition } from './taskRecordService';

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { ESCALATION_MARKERS } = require('./connectorRelayPolicy');

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { emitTaskUpdated } = require('./taskEventService');

export const CONNECT_AGENT_SOURCE_REF = 'onboarding:connect-agent';
export const FIRST_TASK_SOURCE_REF = 'onboarding:first-task';

const OPEN = { $in: ['pending', 'claimed'] };

/** Marks one pod's starter card done with a system update. Idempotent: only an open card matches. */
const completeStarterTask = async (podId: string, sourceRef: string, text: string): Promise<void> => {
  const task = await Task.findOneAndUpdate(
    { podId: mongoose.Types.ObjectId.createFromHexString(podId), sourceRef, status: OPEN },
    {
      $inc: { grantEpoch: 1 }, $set: { status: 'done', claimedByUserId: null, completedAt: new Date() },
      $push: {
        updates: {
          text, author: 'system', authorId: null, createdAt: new Date(),
        },
      },
    },
    { new: true },
  );
  if (task) {
    recordTaskTransition({ podId, task, from: null, to: 'done', at: task.completedAt || new Date() });
    await onTaskClosed(task);
    emitTaskUpdated(podId, task, 'updated');
  }
};

export const completeConnectAgentStarterTask = async ({
  podIds,
  agentLabel,
}: {
  podIds: Array<string | undefined | null>;
  agentLabel: string;
}): Promise<void> => {
  const uniquePodIds = Array.from(new Set((podIds || []).filter(Boolean).map(String)));
  for (const podId of uniquePodIds) {
    try {
      await completeStarterTask(
        podId, CONNECT_AGENT_SOURCE_REF, `Completed automatically — ${agentLabel} connected and is listening`,
      );
    } catch (err) {
      console.warn(
        `[starter-task] connect-agent auto-complete failed for pod ${podId}:`,
        (err as Error).message,
      );
    }
  }
};

/**
 * An agent's post just landed in podId. If the pod's "Give your agent its first
 * task" card is still open and the post answers the workspace owner, the card
 * is done, unless the post carries an escalation marker. Scout is excluded: it
 * is the guide, not "your agent". The open-card
 * check comes first, so a pod with no open card costs one indexed read.
 */
export const completeFirstTaskOnAnswer = async ({
  podId, agentName, instanceId, replyToMessageId, answeringMessageId, agentLabel, content = '',
}: {
  podId: string;
  agentName: string;
  instanceId?: string;
  replyToMessageId?: unknown;
  answeringMessageId?: unknown;
  agentLabel: string;
  content?: string;
}): Promise<void> => {
  try {
    if (!podId || !agentName || String(agentName).toLowerCase() === 'scout') return;
    // An answer that says it is blocked ([BLOCKED], [DECISION] ...) has not done
    // the task yet. Attention reads the same marker the other way: still an ask.
    if (ESCALATION_MARKERS.test(String(content))) return;
    const open = await Task.exists({
      podId: mongoose.Types.ObjectId.createFromHexString(String(podId)), sourceRef: FIRST_TASK_SOURCE_REF, status: OPEN,
    });
    if (!open) return;
    const pod = await Pod.findById(podId).select('createdBy').lean();
    const owner = pod?.createdBy ? String(pod.createdBy) : '';
    if (!owner) return;
    const answered = await humansAnsweredBy({
      podId, agentName, instanceId, replyToMessageId, answeringMessageId,
    });
    if (!answered.has(owner)) return;
    await completeStarterTask(
      String(podId), FIRST_TASK_SOURCE_REF, `Completed automatically — ${agentLabel} answered your first request`,
    );
  } catch (err) {
    // Constant format string: podId reaches here from a request (CodeQL js/tainted-format-string).
    console.warn('[starter-task] first-task auto-complete failed for pod %s:', String(podId), (err as Error).message);
  }
};

export default {
  CONNECT_AGENT_SOURCE_REF, FIRST_TASK_SOURCE_REF, completeConnectAgentStarterTask, completeFirstTaskOnAnswer,
};
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
