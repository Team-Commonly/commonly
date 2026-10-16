/**
 * agentAnswerService: who is an agent's post ANSWERING?
 *
 * One rule, read by two writers (stickiness Phase 1b, ux-lead's ruling in
 * Sharpen 78222-78224, 2026-10-16):
 *   - attention: an answer to the person who asked opens no needs-you row
 *     (attentionItemService);
 *   - onboarding: the first answer an agent gives the workspace owner completes
 *     "Give your agent its first task" (starterTaskService).
 *
 * An agent's post answers the authors of the messages it holds a LIVE claim on
 * in that pod (a native turn claims the message that woke it and carries no
 * reply edge), plus the author of a message it explicitly replies to. Reply
 * edges are never added to make this fire: that would thread every answer.
 *
 * Callers decide what the answer means; this only names who was answered. Any
 * failure answers nobody, so every caller falls back to its old behaviour.
 */
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const PGMessage = require('../models/pg/Message');

export const humansAnsweredBy = async ({
  podId, agentName, instanceId, replyToMessageId,
}: {
  podId: unknown;
  agentName: string;
  instanceId?: string;
  replyToMessageId?: unknown;
}): Promise<Set<string>> => {
  const answered = new Set<string>();
  if (!podId || !agentName) return answered;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const MessageClaimService = require('./messageClaimService');
    const claimed: string[] = await MessageClaimService.liveClaimsHeldBy({
      podId: String(podId), agentName, instanceId: instanceId || 'default',
    });
    const sourceIds = [...new Set([...claimed, ...(replyToMessageId ? [String(replyToMessageId)] : [])])]
      .filter((id) => /^\d{1,10}$/.test(id));
    const sources = await Promise.all(sourceIds.map((id) => PGMessage.findById(id)));
    sources.forEach((source: any) => {
      const author = source?.userId?._id ?? source?.userId;
      if (author) answered.add(String(author));
    });
  } catch (error) {
    // Nothing is added before the last await, so a failure leaves the set empty.
    console.warn('[agent-answer] answer check failed; treating as answering nobody:', (error as Error).message);
  }
  return answered;
};

export default { humansAnsweredBy };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
