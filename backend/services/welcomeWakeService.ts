import mongoose, { Types } from 'mongoose';
import PodMemberFirstMessage from '../models/PodMemberFirstMessage';
import AgentEventService from './agentEventService';

/**
 * First-message welcome wake (#834).
 *
 * A member's first message in a pod reaches no agent today: enqueueMentions
 * returns before enqueueing anything when a message carries no @mention and no
 * replyTo, and the implicit path from #703 is gated on replies. So the one
 * message most likely to need an answer — a newcomer's first — is the one
 * guaranteed not to get one. Observed live in Commonly HQ on 2026-08-04: a new
 * member asked a question and it sat unanswered for fourteen hours, in a room
 * whose pinned welcome promises a support agent answers within a minute.
 *
 * SCOPE, stated because the name has to stay honest: this welcomes a member
 * the first time they speak in a pod. It does NOT route unaddressed messages
 * generally. The member whose day-30 question goes unanswered is out of scope
 * and stays out of scope until ADR-017 ships a real policy layer.
 *
 * Why this can ship before that policy layer, while a general rule cannot:
 * the trigger is a monotone state transition (never-spoken → spoken), so total
 * fires are bounded by the state space — members x pods, amortized one per
 * join — INDEPENDENT of traffic. A message-arrival or clock trigger is bounded
 * only by traffic, and taming those needs the budget machinery ADR-017 and
 * #832 have not shipped. #800's incident was a clock trigger: eleven wakes,
 * zero edges. The test for any future point-fix here: if the fire count is
 * bounded by a finite state space it can ship now; if it is bounded only by
 * traffic it waits.
 */

interface WelcomeWakeOptions {
  podId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  username?: string;
  content?: string;
  messageId?: string;
  /** True when the message already carried an @mention or a replyTo. */
  isRouted: boolean;
  /** Installations already loaded by the caller, to avoid a second query. */
  installations: Array<Record<string, any>>;
}

export interface WelcomeWakeResult {
  claimed: boolean;
  woke: string[];
  reason?: 'not-first' | 'routed' | 'no-greeter' | 'error';
}

const NOOP: WelcomeWakeResult = { claimed: false, woke: [], reason: 'not-first' };

interface RawUpsertResult {
  value?: unknown;
  lastErrorObject?: { updatedExisting?: boolean };
}

/**
 * An install opts in with `config.welcomeWake.enabled === true`.
 *
 * Opt-in, never inferred. "The pod's support agent" is not a first-class
 * concept in the schema, and guessing one — the oldest install, the only
 * install, the one whose name contains "support" — would make the wake target
 * drift silently as installs change. Same shape as the heartbeat flag #833
 * made opt-in for the same reason.
 */
export const isDesignatedGreeter = (installation: Record<string, any> | null | undefined): boolean => (
  installation?.config?.welcomeWake?.enabled === true
);

export const findGreeters = (
  installations: Array<Record<string, any>>,
): Array<Record<string, any>> => (installations || []).filter(isDesignatedGreeter);

/**
 * The handle a HUMAN would type to reach this install — not the agent's own
 * `agentName`.
 *
 * These differ, and the difference is a trap. The support agent's token
 * carries `agentName: 'hq-support'` while everyone in the room sees
 * "Commonly Support" and types `@commonly-support`. An agent asked to name
 * its own handle answers from its token and gets it wrong, so the cue states
 * it rather than delegating the guess.
 *
 * Mirrors buildMentionMap's resolution order: displayName slug first (what
 * the UI renders and therefore what a person copies), instanceId second.
 */
const slugifyHandle = (value = ''): string => value
  .toString().trim().toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

export const mentionHandleFor = (installation: Record<string, any>): string => {
  const display = slugifyHandle(String(installation?.displayName || ''));
  if (display) return display;
  const instanceId = String(installation?.instanceId || '');
  if (instanceId && instanceId !== 'default') return slugifyHandle(instanceId);
  return slugifyHandle(String(installation?.agentName || ''));
};

const WELCOME_CUE = (username: string | undefined, handle: string): string => [
  '[First message from a new member in this pod. They have never posted here before,',
  'and they did not @mention anyone — most likely because they do not yet know they can.',
  'Answer their message directly. Do not list your capabilities and do not paste a menu;',
  'if the message is a question, just answer it. Keep it short.',
  '',
  // The one durable thing this reply can do. This wake fires ONCE per member
  // per pod, so their next unaddressed message reaches nobody — by design,
  // because a continuation window cannot tell a message meant for you from
  // one meant for another human, and with two greeters installed it wakes
  // both on everything. The fix for that is not more routing, it is closing
  // the discoverability gap while they are looking at proof that it works.
  // A pinned room description already failed at this; the agent that just
  // answered them will not.
  `End by telling them how to reach you again: they can @${handle} anytime, or reply`,
  'directly to your message. Say it once, plainly, as the last line — not as a menu.',
  '',
  'If their message needs no reply at all, return NO_REPLY as your ENTIRE reply —',
  'anything written after the token is posted publicly.]',
  '',
  username ? `${username} wrote:` : 'They wrote:',
].join('\n');

/**
 * Claim the member's first-message marker and, when that message was
 * unaddressed, wake the pod's designated greeter(s).
 *
 * The marker is claimed for EVERY first message, addressed or not. Claiming
 * only on the unaddressed ones would mean a member whose first message was
 * `@codex help` gets a welcome wake on their SECOND message, which is worse
 * than never getting one.
 *
 * Best-effort throughout: the message is already persisted by the time this
 * runs, so nothing here may turn a successful send into a failure.
 */
export async function maybeFireWelcomeWake({
  podId,
  userId,
  username,
  content,
  messageId,
  isRouted,
  installations,
}: WelcomeWakeOptions): Promise<WelcomeWakeResult> {
  if (!mongoose.Types.ObjectId.isValid(String(podId))
    || !mongoose.Types.ObjectId.isValid(String(userId))) {
    return NOOP;
  }

  const safePodId = new mongoose.Types.ObjectId(String(podId));
  const safeUserId = new mongoose.Types.ObjectId(String(userId));
  // Not conditioned on isRouted: `wokeGreeter` below already carries that
  // term, and the routed case returns before the enqueue. An `isRouted ? [] :`
  // guard here reads as though it decides something and does not — it survived
  // a mutation test unchanged, which is how it was caught.
  const greeters = findGreeters(installations);

  let result: RawUpsertResult;
  try {
    result = await PodMemberFirstMessage.findOneAndUpdate(
      { podId: safePodId, userId: safeUserId },
      {
        $setOnInsert: {
          podId: safePodId,
          userId: safeUserId,
          messageId: messageId ? String(messageId) : undefined,
          wokeGreeter: !isRouted && greeters.length > 0,
          createdAt: new Date(),
        },
      },
      {
        upsert: true,
        new: false,
        // Mongoose 7 replacement for the deprecated rawResult. The driver's
        // updatedExisting flag is the only way to tell the winning insert
        // from a no-op update, which is the whole decision here.
        includeResultMetadata: true,
        setDefaultsOnInsert: true,
      },
    ) as unknown as RawUpsertResult;
  } catch (error) {
    // Concurrent first messages both miss the read; the unique index elects a
    // winner and the loser lands here. Expected, not an error.
    if ((error as { code?: number })?.code === 11000) return NOOP;
    console.warn('[welcome-wake] marker upsert failed', {
      pod: String(safePodId),
      user: String(safeUserId),
      error: (error as Error).message,
    });
    return { claimed: false, woke: [], reason: 'error' };
  }

  const alreadyExisted = result?.lastErrorObject?.updatedExisting === true || result?.value != null;
  if (alreadyExisted) return NOOP;

  if (isRouted) return { claimed: true, woke: [], reason: 'routed' };

  if (greeters.length === 0) {
    // The one failure mode that would otherwise be invisible: the feature is
    // live, the marker is claimed, and nothing happens because no install in
    // this pod opted in. Say so, or the next person debugging "the welcome
    // never fired" has to read this file to discover the flag exists.
    console.warn('[welcome-wake] first message from a new member, but no install in this pod '
      + 'sets config.welcomeWake.enabled — nobody was woken', {
      pod: String(safePodId),
      user: String(safeUserId),
      installs: (installations || []).length,
    });
    return { claimed: true, woke: [], reason: 'no-greeter' };
  }

  const woke: string[] = [];
  await Promise.all(greeters.map(async (installation) => {
    const agentName = String(installation?.agentName || '').toLowerCase();
    const instanceId = String(installation?.instanceId || 'default');
    if (!agentName) return;
    try {
      await AgentEventService.enqueue({
        agentName,
        instanceId,
        podId: safePodId,
        // Deliberately chat.mention rather than a new event type. A new type
        // needs a wrapper release: the CLI wrapper's extractPrompt has no
        // branch for one and falls through to null, so a bespoke
        // `pod.first_message` would be silently dropped by every
        // already-deployed wrapper — the #611 failure mode. (The boundary is
        // the branch, not the set: extractPrompt also handles heartbeat,
        // agent.ask and agent.ask.response outside PROMPT_EVENT_TYPES.) An
        // additive payload flag costs nothing and works on drivers shipped
        // before this existed.
        type: 'chat.mention',
        payload: {
          messageId: messageId ? String(messageId) : undefined,
          // The cue rides inline in content, not in metadata: models
          // deprioritize structured fields and act on the narrative frame.
          // Same rule as the DM cue (ADR-012 §9) and the pod-context cue.
          content: `${WELCOME_CUE(username, mentionHandleFor(installation))}\n${String(content || '').trim()}`,
          userId: String(safeUserId),
          username,
          mentions: [],
          source: 'chat',
          messageType: 'text',
          createdAt: new Date(),
          welcomeWake: true,
        },
      });
      woke.push(agentName);
    } catch (error) {
      console.warn('[welcome-wake] event enqueue failed', {
        agent: agentName,
        pod: String(safePodId),
        error: (error as Error).message,
      });
    }
  }));

  return { claimed: true, woke };
}

export default { maybeFireWelcomeWake, isDesignatedGreeter, findGreeters };
