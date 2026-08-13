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
 * (agentRuntimeAuth HTTP + agentWebSocketService WS). Never throws; a board
 * write must not be able to fail an auth request.
 */
import mongoose from 'mongoose';
import Task from '../models/Task';

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { emitTaskUpdated } = require('./taskEventService');

export const CONNECT_AGENT_SOURCE_REF = 'onboarding:connect-agent';

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
      const task = await Task.findOneAndUpdate(
        {
          podId: mongoose.Types.ObjectId.createFromHexString(podId),
          sourceRef: CONNECT_AGENT_SOURCE_REF,
          status: { $in: ['pending', 'claimed'] },
        },
        {
          $set: { status: 'done', completedAt: new Date() },
          $push: {
            updates: {
              text: `Completed automatically — ${agentLabel} connected and is listening`,
              author: 'system',
              authorId: null,
              createdAt: new Date(),
            },
          },
        },
        { new: true },
      );
      if (task) emitTaskUpdated(podId, task, 'updated');
    } catch (err) {
      console.warn(
        `[starter-task] connect-agent auto-complete failed for pod ${podId}:`,
        (err as Error).message,
      );
    }
  }
};

export default { CONNECT_AGENT_SOURCE_REF, completeConnectAgentStarterTask };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
