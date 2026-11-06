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
 * answerStaysTopLevel and threadOfRunningTurn, below, are the placement half of
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

/**
 * How long a top-level mention can pull a post into the channel: a long turn,
 * plus some room. Past this the agent is not answering that wake, and an old
 * mention must not move a later note. Event retention is no bound: it runs for
 * days, and it would make the same post land differently once the event was
 * deleted. An in-thread wake has no such limit: it only ever keeps a thread.
 */
export const WAKE_LOOKUP_WINDOW_MS = 2 * 60 * 60 * 1000;

/** The post is waiting on this read, so a slow one fails open like a thrown one. */
export const WAKE_LOOKUP_MAX_TIME_MS = 250;

/**
 * F212: is this post the agent's answer to a person's top-level message, which
 * belongs in the channel whatever the model set? `threadRootId` and a bare
 * `replyToMessageId` both file a post under the message they name (a reply
 * derives its root in models/pg/Message), and a prompt line telling the model
 * not to is advice. So the kernel settles it, for every runtime that posts.
 *
 * The target is the message the post names: the reply edge, else the root.
 * Keeping the thread is the default, and each of these keeps it:
 *   - the target is itself inside a thread, or is the agent's own message
 *     (the overflow rule: post the point, continue under your own root);
 *   - the target's author is another agent, or of unknown kind. Agents talking
 *     to each other belong in one thread: without this, every hop of an
 *     @mention exchange would land in the channel;
 *   - `kind` says it is not an answer (progress, fyi);
 *   - a 1:1 or admin DM. The wrapper's channel line leaves these out too;
 *   - the newest wake naming the target is inside its thread: the conversation
 *     has moved there, so an earlier top-level mention no longer decides.
 *
 * Then the answer is identified, strongest first: the agent's newest wake for
 * the target, within WAKE_LOOKUP_WINDOW_MS, is the top-level mention itself, which needs no `kind` because
 * models leave it off; or it declared `kind: 'answer'` on a reply edge.
 * `kind` alone is not enough on a bare `threadRootId`: there is no reply edge
 * saying what it answers, and that is how an in-thread answer reads too.
 *
 * Reads run only for a post that names a target, on the indexed
 * agent/instance/pod prefix. A failed wake read, a timeout included, leaves only
 * the `kind` branch. Any other failure leaves the post as the model sent it.
 */
export const answerStaysTopLevel = async ({
  podId, agentName, instanceId, agentUserId, replyToMessageId, threadRootId, kind,
}: {
  podId: unknown;
  agentName: string;
  instanceId?: string;
  agentUserId: unknown;
  replyToMessageId?: unknown;
  threadRootId?: unknown;
  kind?: string | null;
}): Promise<boolean> => {
  const named = replyToMessageId || threadRootId;
  if (!named || !podId || !agentName || (kind && NON_ANSWER_KINDS.has(kind))) return false;
  try {
    const target = await PGMessage.findById(String(named));
    if (!target || target.thread_root_id != null) return false;
    const author = target.userId?._id ?? target.userId;
    if (!author || String(author) === String(agentUserId)) return false;
    if (target.is_bot !== false) return false;

    /* eslint-disable global-require, @typescript-eslint/no-require-imports */
    const Pod = require('../models/Pod');
    const { isPersonalPodType } = require('./podTypePolicyService');
    const AgentEvent = require('../models/AgentEvent');
    /* eslint-enable global-require, @typescript-eslint/no-require-imports */
    const pod = await Pod.findOne({ _id: { $eq: String(podId) } }).select('type').lean();
    if (!pod || isPersonalPodType(pod.type)) return false;

    // A reconciled row is known by both ids, and a mention names `target.id`.
    const pgId = String(target.pgId);
    const targetIds = [pgId, String(target.id)];
    // A failed read means no wake is known, not that the post is settled: the
    // declared-answer branch below needs no wake.
    let wake: { type?: string; createdAt?: Date; payload?: Record<string, unknown> } | null = null;
    try {
      wake = await AgentEvent.findOne({
        agentName: { $eq: String(agentName).toLowerCase() },
        instanceId: { $eq: String(instanceId || 'default') },
        podId: { $eq: String(podId) },
        type: { $in: WAKE_TYPES },
        $or: [
          { 'payload.messageId': { $in: targetIds } },
          // A second mention can join an earlier row (ADR-018 D6.5).
          { 'payload.coalesced.messageId': { $in: targetIds } },
          { 'payload.threadRootId': { $in: [...targetIds, Number(pgId)] } },
        ],
      }).sort({ createdAt: -1 }).select('type payload createdAt').maxTimeMS(WAKE_LOOKUP_MAX_TIME_MS)
        .lean();
    } catch (lookupError) {
      console.warn('[agent-answer] wake lookup failed; deciding on kind alone:', (lookupError as Error).message);
    }

    const wakePayload = wake?.payload || {};
    if (wakePayload.threadRootId != null && wakePayload.threadRootId !== '') return false;
    const mentionIsCurrent = wake?.type === 'chat.mention'
      && new Date(wake.createdAt as Date).getTime() >= Date.now() - WAKE_LOOKUP_WINDOW_MS;
    if (mentionIsCurrent) return true;
    return kind === 'answer' && Boolean(replyToMessageId);
  } catch (error) {
    console.warn('[agent-answer] top-level check failed; leaving the post as sent:', (error as Error).message);
    return false;
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

const threadRootOf = (payload: unknown): number | null => {
  const root = Number((payload as { threadRootId?: unknown } | null)?.threadRootId);
  return Number.isSafeInteger(root) && root > 0 ? root : null;
};

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
 * The post goes in the thread only when every delivery agrees: each one is a
 * message wake inside the same thread. A turn holding a top-level mention, a
 * second thread, a heartbeat or a task beside it cannot say which of them a
 * plain post answers, so that post stays as sent, and the wake cue is what asks
 * the model to name the thread. Unrelated work in a turn is the same limit:
 * only `progress`, `fyi` and the caller's own opt-out (mainChannel on the CAP
 * route) say a post is not the answer. So is a post after the event is acked,
 * including one after a mid-turn checkpoint, though a wake acked in the last
 * JUST_ACKED_MS still gets a say in the agreement. And a held row need not be the
 * running turn's: a carried or crashed row in thread N files a plain post from
 * a turn that holds nothing else in this pod, until the row is acked or ages out.
 *
 * Comment wakes carry no thread root. Personal pods keep their plain post, as
 * the top-level rule leaves them alone. A root that fails the resolver's checks
 * (deleted, say) is no reason to refuse a post that named no thread.
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
    const { resolveThreadRoot } = require('./threadRootResolver');
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
    const wakeRoot = (event: { type?: string; payload?: unknown }): number | null => (
      WAKE_TYPES.includes(String(event.type)) ? threadRootOf(event.payload) : null
    );
    const roots = new Set(held.map(wakeRoot));
    const [root] = [...roots];
    if (roots.size !== 1 || root == null) return null;
    const pod = await Pod.findOne({ _id: { $eq: String(podId) } }).select('type').lean();
    if (!pod || isPersonalPodType(pod.type)) return null;
    // Only a disagreement counts: an ack alone still files nothing, as above.
    // `createdAt` is what the index can use: an ack can't be newer than this
    // unless its wake sat for hours, and then it says nothing about this turn.
    const justAcked: Array<{ type?: string; payload?: unknown }> = await AgentEvent.find({
      agentName: { $eq: String(agentName).toLowerCase() },
      instanceId: { $eq: String(instanceId || 'default') },
      status: 'acked',
      podId: { $eq: String(podId) },
      deliveryMode: { $ne: 'digest' },
      createdAt: { $gte: new Date(Date.now() - WAKE_LOOKUP_WINDOW_MS) },
      updatedAt: { $gte: new Date(Date.now() - JUST_ACKED_MS) },
    }).select('type payload').limit(MAX_TURN_DELIVERIES).maxTimeMS(WAKE_LOOKUP_MAX_TIME_MS)
      .lean();
    if (justAcked.some((event) => wakeRoot(event) !== root)) return null;
    return await resolveThreadRoot({ podId: String(podId), threadRootId: root });
  } catch (error) {
    console.warn('[agent-answer] running-turn thread check failed; leaving the post as sent:', (error as Error).message);
    return null;
  }
};

export default { humansAnsweredBy, answerStaysTopLevel, threadOfRunningTurn };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
