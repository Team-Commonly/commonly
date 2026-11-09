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
 * reply edge), the author of a message it explicitly replies to, and the
 * author of the message its run is answering (answeringMessageId). That last
 * one is set by the native runtime from the run's own trigger, never by the
 * model or a CAP request: since #2269 an agent a person addressed answers even
 * when another agent won the claim, and then holds no claim to be counted by.
 * Reply edges are never added to make this fire: that would thread every answer.
 *
 * Callers decide what the answer means; this only names who was answered. Any
 * failure answers nobody, so every caller falls back to its old behaviour.
 *
 * answerRootOfWake and threadOfRunningTurn, below, are the placement half of
 * the same question.
 */
import { RUNNING_TURN_WINDOW_MS } from './mentionCoalesce';

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const PGMessage = require('../models/pg/Message');

const isPgMessageId = (id: string): boolean => /^\d{1,10}$/.test(id);

export const humansAnsweredBy = async ({
  podId, agentName, instanceId, replyToMessageId, answeringMessageId,
}: {
  podId: unknown;
  agentName: string;
  instanceId?: string;
  replyToMessageId?: unknown;
  answeringMessageId?: unknown;
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
      .filter(isPgMessageId);
    const answering = answeringMessageId ? String(answeringMessageId) : '';
    const answeringId = isPgMessageId(answering) && !sourceIds.includes(answering) ? answering : '';
    const [sources, answeringSource] = await Promise.all([
      Promise.all(sourceIds.map((id) => PGMessage.findById(id))),
      answeringId ? PGMessage.findById(answeringId) : null,
    ]);
    const addAuthor = (source: any) => {
      const author = source?.userId?._id ?? source?.userId;
      if (author) answered.add(String(author));
    };
    sources.forEach(addAuthor);
    // A claim is taken in this pod, and a reply edge is checked against it at
    // write (TASK-278). The run's trigger is named by id alone, so its pod is
    // checked here: a post never answers a message in another pod.
    if (answeringSource && String((answeringSource as any).pod_id) === String(podId)) addAuthor(answeringSource);
  } catch (error) {
    // Nothing is added before the last await, so a failure leaves the set empty.
    console.warn('[agent-answer] answer check failed; treating as answering nobody:', (error as Error).message);
  }
  return answered;
};

/** Kinds that say a post is not the answer. `ask` and `error` still reply to the person. */
const NON_ANSWER_KINDS: ReadonlySet<string> = new Set(['progress', 'fyi']);

/**
 * Every event that can carry `payload.threadRootId`. `message.posted` is here
 * because a follower woken by thread activity is in that thread even though
 * nobody mentioned it.
 */
const WAKE_TYPES = ['chat.mention', 'thread.mention', 'message.posted'];

/** The post is waiting on this read, so a slow one fails open like a thrown one. */
export const WAKE_LOOKUP_MAX_TIME_MS = 250;

const threadRootOf = (payload: unknown): number | null => {
  const root = Number((payload as { threadRootId?: unknown } | null)?.threadRootId);
  return Number.isSafeInteger(root) && root > 0 ? root : null;
};

/**
 * D278: the thread a wake's answer belongs in, or null when it names none.
 *
 * A wake inside a thread is answered there (F245). A top-level `chat.mention`
 * is answered in that message's own thread, so the conversation it starts,
 * and every agent that joins it, stays in one place. This replaced F212
 * (#3536), which kept that answer in the main channel; the shell now previews
 * a thread's latest reply on its parent for everyone, which is what F212 was
 * protecting. Personal pods are the caller's to exclude: this reads no pod.
 *
 * Names no thread: `message.posted` traffic outside a thread (ambient, nobody
 * asked), a post comment (`thread.mention` has no chat root), a mention with
 * no numeric message id, and a row that joined other top-level mentions
 * (`payload.coalesced`), which names more than one message.
 */
export const answerRootOfWake = (event: { type?: unknown; payload?: unknown } | null | undefined): number | null => {
  if (!event || !WAKE_TYPES.includes(String(event.type))) return null;
  const inThread = threadRootOf(event.payload);
  if (inThread != null) return inThread;
  if (String(event.type) !== 'chat.mention') return null;
  const payload = (event.payload || {}) as { messageId?: unknown; coalesced?: unknown };
  if (Array.isArray(payload.coalesced) && payload.coalesced.length > 0) return null;
  const raw = String(payload.messageId ?? '');
  const own = Number(raw);
  return /^\d{1,10}$/.test(raw) && Number.isSafeInteger(own) && own > 0 ? own : null;
};

/**
 * The thread a message belongs to: its own id at the top level, its root when
 * it sits inside a thread. Null when it is gone or in another pod. A wake names
 * a message, not always a root: a welcome wake names a member's first message,
 * which can be a reply inside someone's thread. Naming that message itself as
 * the root would be refused (thread_root_not_a_root) and fail the answer.
 */
export const threadOfMessage = async (
  { podId, messageId }: { podId: unknown; messageId: unknown },
): Promise<number | null> => {
  if (!podId || messageId == null || messageId === '') return null;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { resolveThreadRoot } = require('./threadRootResolver');
    const root = await resolveThreadRoot({ podId: String(podId), replyToMessageId: String(messageId) });
    return Number.isSafeInteger(root) && root > 0 ? root : null;
  } catch (error) {
    console.warn('[agent-answer] message thread lookup failed; leaving the post as sent:', (error as Error).message);
    return null;
  }
};

/** The most deliveries one pod's turn can hold: the runner renews 50 at a time. */
const MAX_TURN_DELIVERIES = 50;

/**
 * How long an acked wake still speaks for the turn. A model can send a post and
 * commonly_checkpoint_event side by side, and the ack can land first (F292: one
 * second apart, on a pi seat). Long enough for that, short enough that the next
 * turn's post isn't judged by the last turn's ack.
 */
export const JUST_ACKED_MS = 5 * 1000;

/**
 * F245: the thread a plain CAP post answers, or null to post it as sent. A
 * model told nothing about the thread, or holding a tool with no thread field
 * (OpenClaw's commonly_post_message takes only podId and content), sends a plain
 * post. The native runtime knows its trigger and passes the root itself. A
 * model's tool call over HTTP names no event, and the one driver that names one
 * (OpenClaw's channel dispatcher, metadata.sourceEventId on its reply) is not
 * all of a turn's posts. So the kernel reads the turn from the deliveries this
 * agent holds in this pod: `delivered` is between the fetch and the ack, and a
 * live driver renews it, so past RUNNING_TURN_WINDOW_MS no turn holds it.
 *
 * The post goes in the thread only when every delivery agrees: each one names
 * the same thread through answerRootOfWake, either a wake inside that thread or
 * the lone top-level mention it grows under (D278). A turn holding a second
 * thread, a second top-level mention, ambient channel traffic, a heartbeat or a
 * task beside it cannot say which of them a plain post answers, so that post
 * stays as sent, and the wake cue is what asks the model to name the thread.
 * Unrelated work in a turn is the same limit:
 * only `progress`, `fyi` and the caller's own opt-out (mainChannel on the CAP
 * route) say a post is not the answer. So is a post after the event is acked,
 * including one after a mid-turn checkpoint, though a wake acked in the last
 * JUST_ACKED_MS still gets a say in the agreement. And a held row need not be the
 * running turn's: a carried or crashed row in thread N files a plain post from
 * a turn that holds nothing else in this pod, until the row is acked or ages out.
 *
 * Comment wakes carry no thread root. Personal pods keep their plain post: a
 * 1:1 conversation has no channel to keep clear. A message that is gone, or in
 * another pod, is no reason to refuse a post that named no thread.
 */
export const threadOfRunningTurn = async ({
  podId, agentName, instanceId, kind,
}: {
  podId: unknown;
  agentName: string;
  instanceId?: string;
  kind?: string | null;
}): Promise<number | null> => {
  if (!podId || !agentName || (kind && NON_ANSWER_KINDS.has(kind))) return null;
  try {
    /* eslint-disable global-require, @typescript-eslint/no-require-imports */
    const AgentEvent = require('../models/AgentEvent');
    const Pod = require('../models/Pod');
    const { isPersonalPodType } = require('./podTypePolicyService');
    /* eslint-enable global-require, @typescript-eslint/no-require-imports */
    const held: Array<{ type?: string; payload?: unknown }> = await AgentEvent.find({
      agentName: { $eq: String(agentName).toLowerCase() },
      instanceId: { $eq: String(instanceId || 'default') },
      status: 'delivered',
      podId: { $eq: String(podId) },
      deliveryMode: { $ne: 'digest' },
      deliveredAt: { $gte: new Date(Date.now() - RUNNING_TURN_WINDOW_MS) },
    }).sort({ createdAt: -1, _id: -1 }).select('type payload').limit(MAX_TURN_DELIVERIES)
      .maxTimeMS(WAKE_LOOKUP_MAX_TIME_MS)
      .lean();
    const wakeRoot = (event: { type?: string; payload?: unknown }): number | null => answerRootOfWake(event);
    const roots = new Set(held.map(wakeRoot));
    const [root] = [...roots];
    if (roots.size !== 1 || root == null) return null;
    const pod = await Pod.findOne({ _id: { $eq: String(podId) } }).select('type').lean();
    if (!pod || isPersonalPodType(pod.type)) return null;
    // Only a disagreement counts: an ack alone still files nothing, as above.
    // No `createdAt` bound: a wake can wait hours and arrive beside a new one,
    // so its age says nothing here. Retention bounds the rows read.
    const justAcked: Array<{ type?: string; payload?: unknown }> = await AgentEvent.find({
      agentName: { $eq: String(agentName).toLowerCase() },
      instanceId: { $eq: String(instanceId || 'default') },
      status: 'acked',
      podId: { $eq: String(podId) },
      deliveryMode: { $ne: 'digest' },
      updatedAt: { $gte: new Date(Date.now() - JUST_ACKED_MS) },
    }).select('type payload').limit(MAX_TURN_DELIVERIES + 1).maxTimeMS(WAKE_LOOKUP_MAX_TIME_MS)
      .lean();
    // A full page can hide the disagreement, so it counts as one.
    if (justAcked.length > MAX_TURN_DELIVERIES || justAcked.some((event) => wakeRoot(event) !== root)) return null;
    // The agreed id is a root, or a mention's own message, which may sit inside
    // a thread: the message's own thread is the answer's either way.
    return await threadOfMessage({ podId, messageId: root });
  } catch (error) {
    console.warn('[agent-answer] running-turn thread check failed; leaving the post as sent:', (error as Error).message);
    return null;
  }
};

export default { humansAnsweredBy, answerRootOfWake, threadOfMessage, threadOfRunningTurn };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
