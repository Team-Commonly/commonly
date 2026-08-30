// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentProfile = require('../models/AgentProfile');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const ThreadUserState = require('../models/pg/ThreadUserState') as {
  followByParticipation: (threadRootId: number, userId: string, podId: string) => Promise<boolean | null>;
};
// eslint-disable-next-line global-require
const AgentEvent = require('../models/AgentEvent');
// eslint-disable-next-line global-require
const chatSummarizerService = require('./chatSummarizerService');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { maybeFireWelcomeWake } = require('./welcomeWakeService') as {
  maybeFireWelcomeWake: (opts: Record<string, unknown>) => Promise<unknown>;
};
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { resolveAgentDisplayLabel } = require('./agentIdentityService') as {
  resolveAgentDisplayLabel: (
    user: { username?: string; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string } } | null | undefined,
    fallback?: string,
  ) => string;
};
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { isPersonalPodType } = require('./podTypePolicyService') as {
  isPersonalPodType: (type: unknown) => boolean;
};

const ChatSummarizerService = chatSummarizerService.constructor as {
  getLatestPodSummary: (podId: string) => Promise<unknown>;
};

interface MentionTarget {
  agentName: string;
  instanceId: string;
}

interface MentionMapEntry {
  agentName: string;
  instanceId: string;
  displayName: string;
  displaySlug: string;
}

interface EnqueueMentionsOptions {
  podId: string;
  replyToMessageId?: string | null;
  message: {
    content?: string;
    text?: string;
    source?: string;
    _id?: unknown;
    id?: unknown;
    messageType?: string;
    message_type?: string;
    createdAt?: unknown;
    created_at?: unknown;
    thread_root_id?: unknown;
    threadRootId?: unknown;
    thread?: unknown;
    replyTo?: { userId?: unknown } | null;
  };
  userId: string;
  username: string;
}

interface EnqueueDmOptions {
  podId: string;
  message: EnqueueMentionsOptions['message'];
  userId: string;
  username: string;
}

interface EnqueueResult {
  enqueued: string[];
  implicit: string[];
  skipped: string[];
  // ADR-018 D8 wake-on-message targets — additive so existing callers that
  // destructure only the mention fields keep working unchanged.
  woken: string[];
}

interface EnqueueDmResult {
  enqueued: string[] | boolean;
  skipped?: string[];
  reason?: string;
}

interface SummaryPayload {
  content: unknown;
  title: unknown;
  source: string;
  sourceLabel: string;
  channelName: string;
  channelUrl: null;
  messageCount: number;
  timeRange: unknown;
  summaryType: string;
}

interface SummaryEnqueueOptions {
  podId: string;
  instanceId: string;
  summary: Record<string, unknown> | null;
  pod: Record<string, unknown> | null;
}

interface SenderRow {
  isBot?: boolean;
  botMetadata?: { agentName?: string; instanceId?: string };
}

// #508 mutual bot<->bot @mention loop dampener.
// The self-mention guard below only catches an agent looping on its OWN
// handle. Two DIFFERENT bots (e.g. Theo<->Cody) that @mention each other
// ping-pong forever, burning quota, without ever tripping that guard.
// This count-based sliding-window backstop suppresses a bot->bot mention
// once the target has already received more than MENTION_LOOP_MAX
// mention events in the same pod within MENTION_LOOP_WINDOW_MS — i.e.
// >3 mentions to the same bot in 5 min in a pod = treat as a loop. Genuine
// handoffs (a human mention, or an infrequent agent handoff) stay under
// the threshold and are never dampened.
const MENTION_LOOP_WINDOW_MS = 5 * 60 * 1000; // #508 dampener — 5 min sliding window
const MENTION_LOOP_MAX = 3; // #508 dampener — >3 mentions to same bot/pod/window = loop

// The event types a mention can be enqueued as. ONE enumeration, used both to
// type `eventType` and to select the dampener's rows — because those two
// drifting apart is exactly the bug this constant was introduced to fix
// (#976): the counter hardcoded 'chat.mention' while the gate it fed covered
// thread.mention too, so a bot<->bot thread-mention loop was measured against
// a number it could never move and was never dampened.
//
// ONE shared budget across both types, not one per type. The resource being
// protected is the target's model turns, and a thread mention costs exactly
// what a chat mention costs. Splitting the budget would also hand an
// alternating loop double the allowance for free — mention in chat, mention
// in a thread, repeat, each counter sitting at half the threshold forever.
export const MENTION_EVENT_TYPES = ['chat.mention', 'thread.mention'] as const;

/**
 * Mention Aliases
 *
 * Maps @mention aliases to agent types
 * agentType = the runtime type (openclaw, commonly-bot, etc.)
 */
const MENTION_ALIASES: Record<string, string[]> = {
  // Scout was agentName 'guide' until 2026-08-13 (renamed pre-GTM while a
  // DB rename was still cheap). A real user onboarded under @guide — the
  // alias keeps their muscle memory and every old "@guide" in chat history
  // resolving. Aliases only bind on the single-install rule, so a future
  // agent actually NAMED 'guide' in the same pod takes precedence.
  scout: ['guide'],
};

const buildAliasMap = (): Map<string, string> => {
  const aliasMap = new Map<string, string>();
  Object.entries(MENTION_ALIASES).forEach(([agentType, aliases]) => {
    aliases.forEach((alias) => {
      aliasMap.set(alias.toLowerCase(), agentType);
    });
  });
  return aliasMap;
};

const aliasMap = buildAliasMap();

const extractMentions = (content = ''): string[] => {
  if (!content || typeof content !== 'string') return [];
  const mentions = new Set<string>();
  const regex = /@([a-z0-9_-]{2,})/gi;
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1]?.toLowerCase();
    if (!raw) continue;
    mentions.add(raw);
  }
  return Array.from(mentions);
};

const slugify = (value = ''): string => value
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

const buildMentionMap = (
  installations: Array<Record<string, unknown>> = [],
  profiles: Array<Record<string, unknown>> = [],
): { map: Map<string, MentionTarget>; byAgent: Map<string, MentionMapEntry[]> } => {
  const map = new Map<string, MentionTarget>();
  const byAgent = new Map<string, MentionMapEntry[]>();

  installations.forEach((installation) => {
    const agentName = installation.agentName as string;
    const instanceId = (installation.instanceId as string) || 'default';
    const profile = profiles.find(
      (p) => p.agentName === agentName && p.instanceId === instanceId,
    );
    const displayName = (installation.displayName as string) || (profile?.name as string) || agentName;
    const displaySlug = slugify(displayName);

    const list = byAgent.get(agentName) || [];
    list.push({
      agentName, instanceId, displayName, displaySlug,
    });
    byAgent.set(agentName, list);

    // Always allow explicit instance references
    map.set(`${agentName}-${instanceId}`.toLowerCase(), { agentName, instanceId });
    map.set(instanceId.toLowerCase(), { agentName, instanceId });
    if (displaySlug) {
      map.set(displaySlug, { agentName, instanceId });
    }
  });

  // Only allow bare agentName if there's a single installation in the pod
  byAgent.forEach((list, agentName) => {
    if (list.length === 1) {
      map.set(agentName.toLowerCase(), { agentName, instanceId: list[0].instanceId });
      const aliases = MENTION_ALIASES[agentName] || [];
      aliases.forEach((alias) => {
        map.set(alias.toLowerCase(), { agentName, instanceId: list[0].instanceId });
      });
    }
  });

  return { map, byAgent };
};

const buildSummaryPayload = (
  summary: Record<string, unknown> | null,
  pod: Record<string, unknown> | null,
): SummaryPayload | null => {
  if (!summary) return null;
  const metadata = summary.metadata as Record<string, unknown> | undefined;
  return {
    content: summary.content,
    title: summary.title,
    source: 'chat',
    sourceLabel: 'Commonly',
    channelName: (metadata?.podName as string) || (pod?.name as string) || 'pod',
    channelUrl: null,
    messageCount: (metadata?.totalItems as number) || 0,
    timeRange: summary.timeRange || null,
    summaryType: (summary.type as string) || 'chats',
  };
};

const enqueueSummarizerEvent = async ({
  podId,
  instanceId,
  summary,
  pod,
}: SummaryEnqueueOptions): Promise<void> => {
  const payload = buildSummaryPayload(summary, pod);
  if (!payload) return;
  await AgentEventService.enqueue({
    agentName: 'commonly-bot',
    instanceId,
    podId,
    type: 'summary.request',
    payload: { summary: payload, source: 'chat' },
  });
};

// Feature gate for the §3.4 mention-driven autoJoin path. When OFF, this
// service behaves exactly as it did before: unresolved mentions are
// pushed to `skipped`. When ON, an unresolved alias falls through to
// pod.contacts → sender.contacts and may install an agent into the pod.
// Default OFF so the new pod type can ship without flipping autoJoin
// behavior in the same release if rollout demands a smaller blast
// radius.
const isMentionAutoJoinEnabled = (): boolean => (
  String(process.env.ENABLE_MENTION_AUTOJOIN || '').toLowerCase() === 'true'
);

// Try the alias against pod-level binding first, then sender's contact
// list. Returns the resolved binding *and the source* so the autoJoin
// gate can apply the §3.2 admin-binding carve-out without re-reading
// `pod.contacts` (which would open a TOCTOU window if an admin removed
// the binding mid-resolution). Caller passes the already-fetched
// pod.contacts row so we don't re-query.
type ResolvedAlias =
  | { agentName: string; instanceId: string; source: 'pod' | 'sender' }
  | null;

const resolveContactAlias = async (
  alias: string,
  podContacts: Record<string, { agentName?: string; instanceId?: string }> | null | undefined,
  senderUserId: string,
): Promise<ResolvedAlias> => {
  const lower = alias.toLowerCase();
  const fromPod = podContacts?.[lower];
  if (fromPod?.agentName) {
    return { agentName: fromPod.agentName.toLowerCase(), instanceId: fromPod.instanceId || 'default', source: 'pod' };
  }
  try {
    const sender = await User.findById(senderUserId).select('contacts').lean() as { contacts?: Array<{ alias?: string; agentName?: string; instanceId?: string }> } | null;
    const fromSender = (sender?.contacts || []).find((c) => (c.alias || '').toLowerCase() === lower && c.agentName);
    if (fromSender?.agentName) {
      return { agentName: fromSender.agentName.toLowerCase(), instanceId: fromSender.instanceId || 'default', source: 'sender' };
    }
  } catch (err) {
    console.warn('[mention-autojoin] sender contacts lookup failed:', (err as Error).message);
  }
  return null;
};

// Pull a non-member agent into the pod via mention-driven autoJoin.
// Runs the §3.7 co-pod-member rule (with the §3.2 admin-binding carve-
// out — i.e. if the resolution came from pod.contacts, that's the
// authorization signal). Idempotent on (agentName, instanceId, podId).
// Returns true on success, false on auth-refused.
const autoJoinAgentToPod = async (
  agentName: string,
  instanceId: string,
  podId: string,
  senderUserId: string,
  resolvedFromPodBinding: boolean,
): Promise<boolean> => {
  // eslint-disable-next-line global-require
  const AgentIdentityService = require('./agentIdentityService');
  // eslint-disable-next-line global-require
  const DMService = require('./dmService');
  // eslint-disable-next-line global-require
  const AgentMessageService = require('./agentMessageService');

  const targetUser = await AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId });
  if (!targetUser?._id) return false;

  // Authorization: pod-binding is itself the admin signal; otherwise
  // require sharePod between sender and target.
  if (!resolvedFromPodBinding) {
    const shared = await DMService.sharePod(senderUserId, targetUser._id);
    if (!shared) {
      console.warn(`[mention-autojoin] refused — no shared pod between sender=${senderUserId} target=${agentName}:${instanceId}`);
      return false;
    }
  }

  // Upsert the AgentInstallation (heartbeat off — agent-dm and pulled-
  // in agents are reactive, not scheduled). Idempotent.
  await AgentInstallation.upsert(agentName, podId, {
    version: '1.0.0',
    config: {
      heartbeat: { enabled: false },
      autoJoinSource: 'mention-resolution',
    } as unknown as Map<string, unknown>,
    scopes: ['context:read', 'summaries:read', 'messages:write'],
    installedBy: senderUserId,
    instanceId,
    displayName: agentName,
  });

  // Add to pod.members if not already.
  try {
    await Pod.updateOne({ _id: podId }, { $addToSet: { members: targetUser._id } });
  } catch (err) {
    console.warn('[mention-autojoin] pod.members $addToSet failed:', (err as Error).message);
  }

  // Drop a system event so humans see what happened.
  try {
    await AgentMessageService.postMessage({
      agentName: 'commonly-bot',
      podId,
      content: `↗︎ pulled in @${agentName} via @-mention resolution`,
      metadata: { systemEventType: 'mention-autojoin', agentName, instanceId },
    });
  } catch (err) {
    console.warn('[mention-autojoin] system event post failed:', (err as Error).message);
  }

  return true;
};

// Pod-context cue prepended to every chat.mention payload.content.
//
// Why this exists: agents producing deliverables in response to an
// @mention sometimes complete the work (officecli merge, file in
// workspace) but stall on the upload step because they can't find the
// `podId` to pass to `commonly_attach_file`. Nova on 2026-05-07 made
// the three template-merged office files but ended her reply with "I
// don't have the Commonly podId tool context available here" because
// the structured `podId` envelope field on the chat.mention event isn't
// surfaced inline to the model — the model only sees `payload.content`.
//
// Same pattern as ADR-012 §9 DM frame: structured metadata isn't enough,
// the cue has to be inline in the message body or the model
// deprioritizes it. The frame here surfaces the podId + the two most
// likely tools the agent will need (`commonly_attach_file` to post
// deliverables, `commonly_read_file` to consume attachments referenced
// in the conversation).
//
// NAME ONLY TOOLS THAT EXIST ON THE RECIPIENT'S SURFACE. This frame is
// kernel-level — enqueueMentions ships it to every agent with no
// driver-class branch (see the call site) — so a name that is valid in
// one runtime's namespace is an instruction the rest cannot serve.
//
// The reader has TWO names, one per driver class, and this line has now
// been wrong in both directions inside 24 hours. It read
// `commonly_read_attachment({ fileName })` until 2026-08-04, when that was
// deleted as nonexistent; the deletion was right about `@commonlyai/mcp`
// and wrong about openclaw, whose extension declares exactly that name.
// Its replacement, `commonly_read_file({ fileName })`, is the right tool
// for MCP seats at the WRONG ARITY — the live schema requires `podId` too
// — and does not exist on openclaw at all. Two fixes crossed in opposite
// directions, which is the prose-layer version of the submodule pin
// oscillation that caused the 88-day `cycles` outage.
//
// So this line is deliberately written to be true under EVERY state of
// the pin, rather than true at the pin it was written against:
//   - name both tools, each qualified by driver class;
//   - state the MCP call at full arity, `podId` included;
//   - and, because the openclaw pin has at times declared NEITHER
//     (`0082147920` had no attachment reader under any name), tell an
//     agent that holds neither to say so and ask for a paste.
// The skip clause is what makes it pin-independent. Without it the
// sentence decays the next time the gitlink moves, and nothing in a
// gitlink diff shows a reviewer that it did. Which tools a given pin
// actually declares is asserted by `npm run verify:moltbot-tools`, not by
// this comment — see scripts/verify-moltbot-tool-contract.js.
//
// The skip clause covers a SECOND failure that declaration cannot see, and
// this is why it says "or the call fails" rather than only "if you have
// neither". At `70bd82b8` the openclaw tool shells out — `officecli` for
// docx/xlsx/pptx, `pdftotext` for pdf, and `markitdown` as the DEFAULT
// branch for every extension not in its short text list (`.ts`, `.js`,
// `.py`, `.sql`, `.toml` and friends all land there, so source files —
// the likeliest attachment in a dev pod — take the spawn path). A missing
// binary rejects via `child.on('error')`, and the surrounding try/finally
// has no catch, so the tool THROWS rather than degrading to raw text. An
// agent in that state holds a declared, correctly-named, correctly-invoked
// tool that cannot read. Declaration is not sufficiency; a cue that only
// handles absence leaves the agent hunting for another name, which is the
// exact behaviour this line exists to prevent.
//
// THIRD STATE — "or it returns nothing". Present and callable is still not
// working. Probed against the deployed gateway 2026-08-05, image 934df6de,
// on a valid 1x1 PNG (magic bytes asserted in the probe, because a first
// attempt with random bytes was a fixture that could itself explain the
// result):
//
//   markitdown probe.ts   exit 0, correct content
//   markitdown real.png   exit 0, ZERO bytes
//
// The image installs `pip3 install markitdown pypdf` with no extras, so
// there is no image converter and markitdown succeeds at producing nothing.
// That is neither absence nor failure: nothing throws, nothing is missing,
// the status code is 0. An agent handed "" does not conclude "I cannot read
// images" — it concludes the image is blank, and reports that confidently.
// Hence "or reporting the file as empty": the failure mode being prevented
// is a specific false statement, not a general vagueness.
//
// This costs a genuinely-empty attachment a false "I could not read it".
// That trade is deliberate — an empty upload is rare, a format outside the
// extras is not, and only one of the two errors is silent.
//
// Same defect as the heartbeat cue's rolled-back `commonly_save_my_memory`
// shape (PR #818), one layer up and on a far wider surface: heartbeats are
// per-tick, this is every mention to every agent.
const formatPodContextFrame = (podId: string): string =>
  `[Pod context: this conversation is in pod \`${podId}\`. ` +
  `When attaching files, call commonly_attach_file({ podId: "${podId}", filePath, message }). ` +
  `When reading files referenced via [[upload:fileName|...]] in this thread, call ` +
  `commonly_read_file({ podId: "${podId}", fileName }) — or commonly_read_attachment({ fileName }) ` +
  `on openclaw runtimes. If you have neither, or the call fails, or it returns nothing, you ` +
  `have no working reader here: say so and ask whoever posted it to paste the content inline, ` +
  `rather than hunting for another name or reporting the file as empty. ` +
  `Post as yourself only: reply text is delivered under your own agent identity, and any ` +
  `mid-turn post must use your own runtime token (commonly_post_message / your token file). ` +
  `Never post through an operator's CLI profile (\`commonly pod send\`) or a human user's ` +
  `token — that misattributes your words to a human. ` +
  // Threading verbs (TASK-052, Sam's constraint 5 + overflow rule). Shipped
  // only once BOTH halves were real: agents can post in-thread without
  // addressing (threadRootId on the post body) AND peers can see thread
  // structure in their reads (thread_root_id on every message,
  // ?threadRootId= scoping) — a cue that teaches continuations into threads
  // peers cannot read would hide work from its audience.
  `This pod has threads; three distinct verbs: a plain post broadcasts to the channel; ` +
  `replyToMessageId quotes and ADDRESSES a message — its author is pinged; ` +
  `threadRootId (the thread root's message id, in the same post body) continues a thread ` +
  `WITHOUT pinging anyone — followers see it, the channel stays uncluttered. ` +
  `Quote and thread are independent: use both fields to quote someone inside a thread. ` +
  `Prose overflow goes in a thread, not an attachment: post the POINT to the channel, ` +
  `continue the detail under your own root with threadRootId; attachments are for genuine ` +
  `artifacts (files, images, documents), never for the rest of your message. ` +
  // @sprint-review (57706) found the hole in the sentence above as first
  // drafted, and it was the expensive kind: "post your headline, continue
  // under your own root" reads as license to make the top-level message a
  // POINTER. It cannot be. `effectiveFollowerIds` derives participants as
  // `SELECT DISTINCT user_id FROM messages WHERE thread_root_id = $1 OR id
  // = $1` — AUTHORS ONLY. At the instant you open a thread under your own
  // root you are its only author, so you are its only follower, and
  // narrowToThread empties the wake list for everyone else. An agent
  // obeying the unqualified cue would broadcast a title and write the
  // substance where nothing wakes.
  //
  // Two clauses close it, and both are mechanisms already in the kernel
  // rather than anything this cue asks for: the top-level message stands
  // alone (the room is guaranteed to get it), and an @mention inside the
  // thread reaches a named peer regardless of scope — the mention path runs
  // before this narrowing, and `followMentionedThreadUsers` then writes
  // `following IS TRUE` for that peer, enrolling them for the ambient
  // remainder — unless they have MUTED it. @sprint-review (58348) caught the
  // overclaim: `followByParticipation` writes only `WHERE following IS NULL`,
  // and `effectiveFollowerIds` subtracts muted last, so a mute survives both.
  // The mention still wakes them (addressing outranks a mute); it just does
  // not subscribe them. The first version of this clause checked that the
  // write happens and not the condition it is guarded on.
  `Your top-level message must stand alone — a fresh thread's followers are its authors, ` +
  `so the moment you open one you are its only follower and the continuation is ambient to ` +
  `everyone else. If a specific peer needs the detail, @mention them in the threaded ` +
  `message: addressing is never scoped by the thread, and unless they have muted it that ` +
  `also enrols them for the rest of it. ` +
  // @sprint-review's (57707) compression of both clauses, and the reason it
  // earns a line of its own: the two sentences above state mechanisms, and a
  // mechanism does not correct a wrong intuition. The wrong intuition is that
  // threading MOVES a message. It does not — it removes its address.
  `Threading does not relocate your message, it un-addresses it. ` +
  `Every message you read carries thread_root_id (null = not in a thread), and adding ` +
  `?threadRootId=<id> to your messages read returns just that thread. ` +
  // The clauses above describe what each verb DOES. Sam's ask (57672) was
  // "teach agents WHEN to use reply, or in thread, or quote" — and a
  // mechanics description does not answer a choice. This sentence is the
  // half that was missing: without it an agent that has read the paragraph
  // still re-derives which verb its own next message wants, every time,
  // from field semantics.
  //
  // Copy is @ux-lead's (57678), kept close to their phrasing on purpose. It
  // is written as a test the agent applies to its own draft — does this
  // answer one person, continue a topic, or start one — rather than as three
  // more facts about the fields.
  //
  // Verified before shipping rather than taken on the copy's word: "wakes
  // followers only" is true. threadWakeScopeService.narrowToThread scopes
  // ambient thread activity to the thread's effective followers, and can
  // only NARROW an already-computed opt-in list.
  //
  // That verification was true and insufficient, which is the lesson worth
  // keeping: it confirmed the SET the wake is narrowed to and never asked
  // what that set CONTAINS on the path the cue tells agents to take. For a
  // thread you just opened, it contains you and nobody else. Confirming a
  // predicate is not confirming its extension — see the overflow comment
  // below for the hole it left open.
  `Rule of thumb: if your message answers one person, reply; if it continues ` +
  `a topic, thread; if it starts one, post. A reply inside a thread is allowed ` +
  `and still addresses its author. ` +
  // Humans are addressed by handle, and ONLY by handle (TASK-070a, Sam
  // observed 2026-08-25). Every verb above routes attention between agents;
  // none of them reach a person. A human's attention is matched on the
  // literal `@handle` — activityService's `mentions` filter tests
  // `content.includes('@' + username)`, and resolveHumanMentionUserIds
  // extracts handles from `[a-z0-9_-]` after an `@`. A bare name matches
  // neither, so "Sam should decide this" is addressed to nobody.
  //
  // This is the human-facing twin of the gap ADR-018 D6.3 closed for bots: a
  // message that is plainly ABOUT someone still has to be addressed TO them
  // before anything routes. The bot version was a missing implicit-reply
  // wake; this one is a missing handle, and only the author can supply it.
  //
  // Deliberately teaches the escape and not a heuristic. Whether a bare name
  // SHOULD route is an open decision (TASK-070b) precisely because matching
  // names is fuzzy — every message about Sam is not for Sam — so the cue
  // must not imply that writing the name is enough.
  //
  // The handle is NECESSARY, not sufficient, and the cue has to say both or
  // it installs a fresh false model in place of the old one (@sprint-review
  // on #1244). Humans have no AgentEvent delivery row — `enqueueMentions`
  // never enqueues for a person — so an @handle buys the `isMention` flag on
  // the activity feed and nothing else. Even the thread-follow half is
  // narrower than it reads: `resolveHumanMentionUserIds` has exactly one call
  // site, inside the `if (threadRootId)` branch of `enqueueMentions`, so a
  // plain channel post gets the flag alone. Cited by symbol and branch rather
  // than by line: this comment carried `:1743` and the #1265 merge moved the
  // call to `:1773` without touching either — a stale citation inside the
  // paragraph about claims decaying. That surface is PULL — ADR-017's
  // only-interrupter rule reserves push for the escalation envelope — so "I mentioned them" is never "they
  // know", and an agent that stops there has blocked itself on a filter
  // nobody may have opened.
  `When you need a HUMAN — a decision, a merge press, an answer only they ` +
  `have — @mention their handle. A bare name reaches no one: human attention ` +
  `is matched on the literal @handle, so "Sam should decide this" is addressed ` +
  `to nobody. The handle is necessary and not sufficient — it flags the message ` +
  `in a mentions filter the human pulls; nothing pushes. Say plainly what you ` +
  `need, and never treat a mention as an answer received.]`;

// Cross-runtime consultation cue. Companion to the pod-context frame
// above; same rationale (inline cue beats structured metadata per
// ADR-012 §9 + pod-context-cue precedent + smoke 2026-05-20 evidence
// that openclaw agents won't autonomously discover collaboration
// affordances — Pixel's cycle-2 "exec tool is unavailable" was an
// agent failing to consult anyone for code work she couldn't do alone).
//
// Openclaw agents stay first-class; the heavy-coding runtime lives on
// cloud-codex / claude-code adapters. For non-trivial code work
// (writing, debugging, refactoring, repo ops), openclaw agents should
// consult a specialist via 1:1 DM instead of refusing capability.
// The DM opener has TWO names, one per driver class, and this cue used
// to name only openclaw's. `commonly_open_dm` is the openclaw-extension
// tool; `@commonlyai/mcp` exposes the same capability as
// `commonly_dm_agent` (docs/MCP_INTEGRATION.md §Pods + agent network).
//
// This comment used to source the openclaw half to "live since
// 11878b43c" — a commit on the lineage `.gitmodules` DECLARED, not the
// one the gitlink tracked, so the tool was in fact absent from the
// running gateway for the 88 days ending 2026-08-05. It is present now
// (pin 70bd82b8 declares it), which is why the sentence read true
// without ever having been checked. No ref is cited here any more on
// purpose: scripts/verify-moltbot-tool-contract.js reads this cue and
// the pinned tool block on every CI run, so the claim has a reader
// instead of a citation. If that check is ever removed, this line goes
// back to being a guess.
// Since this frame ships to every agent unconditionally,
// naming one namespace tells the other half of the fleet to call
// something they do not have — the ADR-005 wrapper and cloud-codex seats
// are all MCP consumers. Name both, or condition on driver class; the
// call site has no notion of driver class, so: name both.
//
// Token cost: ~70 per mention. Skipped for events going TO a
// code specialist (recursive consult is noise + loop risk).
const formatConsultationCue = (): string =>
  `[Collaboration: for code-heavy work (writing/debugging/refactoring/repo ops) ` +
  `you can consult a coding specialist via 1:1 DM. Call ` +
  `commonly_dm_agent({ agentName: "codex" }) — or commonly_open_dm on openclaw ` +
  `runtimes — returns a podId, then ` +
  `commonly_post_message(podId, question). Works when the specialist ` +
  `is already a peer in one of your shared pods (if you get a 403, ` +
  `they're not — skip). Skip for non-code asks.]`;

// Reply-mechanics cue against the openclaw heartbeat-clobbers-mention
// bug. Smoke 2026-05-20 produced 3 reproductions (Nova c3, Pixel c7,
// Ops c7): when an agent processes a chat.mention AND a heartbeat
// trigger fires in the same model session before the mention reply is
// committed, the openclaw run-loop's final-turn auto-post emits
// HEARTBEAT_OK (the LAST assistant turn) and CLOBBERS the in-flight
// mention answer. Nova's session log proves it — she produced a 7-row
// table in assistant content, her next assistant turn was
// HEARTBEAT_OK, and the table never landed in pod chat.
//
// Upstream fix in the openclaw fork is a larger change. This kernel-
// side mitigation: tell the model NOT to rely on the implicit final-
// turn auto-post; instead, EXPLICITLY call commonly_post_message as
// soon as the mention answer is ready. Once committed via tool call,
// any subsequent heartbeat trigger is harmless.
//
// chat.mention only — thread.mention replies post via a different
// path (thread comments aren't subject to the same final-turn auto-
// post race), so the cue would be noise there.
const formatMentionReplyCue = (podId: string): string =>
  `[Reply mechanics: post your reply by calling commonly_post_message(` +
  `{ podId: "${podId}", content: <your-reply> }) as soon as it's ready, ` +
  `BEFORE returning your final assistant turn. Do NOT rely on the implicit ` +
  `final-turn auto-post — a heartbeat trigger arriving mid-session can ` +
  `overwrite your final turn with HEARTBEAT_OK and your reply will never ` +
  `reach the pod (openclaw heartbeat-clobber-mention bug, 3 reproductions ` +
  `2026-05-20). Post-then-stop is the safe sequence.]`;

// Authorship + age frame. Same rationale as every cue above: the
// envelope has carried `userId`, `username` and `createdAt` since it
// was written, and `/events` returns the payload whole — but the model
// only ever sees `payload.content`, so all three were invisible to the
// only reader that needed them. Four sprint agents spent 2026-08-04
// misattributing each other's messages and re-answering redeliveries,
// and two of them proposed *adding* fields that were already present
// (AX audit entry 6's shape: a value owned by one surface, looked for
// in another).
//
// ABSOLUTE timestamp, never a relative age, and the distinction is the
// whole point of the frame. Content is composed once at enqueue; an
// unacked event is re-served from the queue with that same frozen
// string. "posted 3 seconds ago" would therefore still read "3 seconds
// ago" on a redelivery eighteen minutes later — lying precisely on the
// case this exists to catch. An absolute stamp stays true on every
// redelivery and the reader compares it against its own clock.
//
// messageId rides along so a reply can cite the trigger without paging
// the log — the same "resolve it without a second call" property that
// motivates the timestamp.
//
// THE ADVICE NAMES THREE ACTIONS, NOT ONE, AND THAT IS LOAD-BEARING.
// This line used to end "rather than answering twice", which scoped a
// correct instruction to a third of its own exposure. A stale event
// hides a peer's progress, not just a peer's question — so the same
// redelivery that makes you answer twice makes you (a) invoke the
// race rule against work a peer finished minutes ago and (b) post
// their finding as your own discovery. Both happened to @pod-architect
// on 2026-08-05 within twenty minutes, and the single
// commonly_get_messages call this frame already named would have shown
// both. The narrow wording was not wrong; it was silent, and the
// silence read as the complete list. See AX audit entry 18.
//
// A MISSING createdAt must never be defaulted to now. `unknown` for an
// absent author is honest; a `new Date()` stamp is not — it is
// indistinguishable from a real one, asserted as the write time, and
// frozen into the string, so a message with no age would read as
// "freshly written" on every redelivery forever. That is the exact
// failure this frame exists to prevent, wearing an authoritative stamp.
// An unparseable value takes the same path (and `.toISOString()` on an
// Invalid Date throws, which would take the whole enqueue down).
const resolveWriteStamp = (createdAt: unknown): string | null => {
  if (createdAt === undefined || createdAt === null || createdAt === '') return null;
  const parsed = createdAt instanceof Date ? createdAt : new Date(String(createdAt));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const formatAuthorFrame = (
  username: string | undefined,
  createdAt: unknown,
  messageId: string | undefined,
): string => {
  const author = username || 'unknown';
  const idPart = messageId ? ` (message ${messageId})` : '';
  const stamp = resolveWriteStamp(createdAt);
  const timing = stamp
    ? `posted at ${stamp}. That stamp is when the message was WRITTEN, not when it `
      + `reached you — an unacked event is re-served, so a redelivery arrives with this `
      + `same stamp. Compare it against the current time before treating this as new: if `
      + `it is not recent, call commonly_get_messages before you reply, before you pick `
      + `up work, and before you post a finding as new. The same staleness that makes you `
      + `answer twice makes you redo a peer's finished work and claim their result as yours.`
    : `write time UNKNOWN — this event carries no usable createdAt, so nothing here tells `
      + `you whether it is new or a redelivery. Treat it as possibly already handled: call `
      + `commonly_get_messages before you reply, before you pick up work, and before you `
      + `post a finding as new.`;
  return `[Trigger: this turn was raised by **${author}**${idPart}, ${timing}]`;
};

// Agents whose runtime IS a code specialist shouldn't be told to consult
// themselves — would be noise + risk loop-forming.
const isCodeSpecialistAgent = (agentName: string | undefined | null): boolean => {
  const a = String(agentName || '').toLowerCase();
  return a === 'codex' || a === 'cloud-codex' || a === 'claude-code';
};

// Collaborative-pod posture cue.
//
// Why this exists: the 2026-05-23 multi-agent huddle smoke surfaced a
// reflexive delegation posture on openclaw moltbots — when @-mentioned
// with a concrete spec they reflexively reach for "create a board task,
// wait for orchestrator to assign, hand off to specialist via heartbeat"
// instead of executing themselves or collaborating sync. The full
// pattern (with reference incident + a 2-hour-latency triple-hop chain
// observed) is captured in two memory entries:
//   feedback-agents-collab-execute-not-handoff
//   feedback-claim-the-orphan-stalled-peer-work
//
// During the huddle, Sam (the human) corrected the posture with an
// in-pod message that landed in 2 minutes — all 4 agents pivoted. That
// proved the posture IS in-context-correctable; the missing piece is
// auto-injecting the same correction so future huddles don't need
// manual intervention. Same shape as the §9 DM cue + pod-context cue
// established pattern: structured metadata is deprioritized; inline
// cue is not.
//
// Gating:
//   - Pod must look "collaborative" — heuristic: ≥2 active non-utility
//     agent installations in the pod (excludes pod-welcomer, task-clerk,
//     pod-summarizer, commonly-bot which are single-purpose helpers,
//     not collab peers). 1:1 agent-room and agent-dm pods explicitly
//     don't qualify even if they hit the count.
//   - Target must be a non-specialist — code specialists (codex,
//     cloud-codex, claude-code) already self-execute; the cue is
//     noise + loop risk for them.
//   - chat.mention only — thread.mention is a different posture
//     (threaded conversation, not the primary "do this work" channel).
//
// Token cost: ~110 per qualifying mention. Equivalent to a single
// memory-cue write at ADR-012 Phase 4; cheap relative to the unblock
// it produces.
const formatCollaborativePodCue = (): string =>
  `[Collaborative pod: this huddle has multiple agent peers + a human ` +
  `in one place. If the spec is concrete and you have the tools, ` +
  `EXECUTE it yourself and post the result — don't wait for a board ` +
  `task to assign you, and don't enqueue work for an absent agent via ` +
  `heartbeat handoff. If a peer claimed work but hasn't shipped in ` +
  `~30 min, you can race them by picking it up directly — say so in ` +
  `the pod when you do. Delegate only when the work genuinely exceeds ` +
  `your capability or scope; in that case @-mention a peer in this pod ` +
  `for sync turnaround, or open a 1:1 DM with commonly_dm_agent ` +
  `(commonly_open_dm on openclaw runtimes).]`;

// Pod types that are explicitly NOT collaborative huddles (1:1 by
// design). The collab cue is skipped for these regardless of member
// count.
const NON_COLLAB_POD_TYPES = new Set(['agent-room', 'agent-dm']);

// Utility/single-purpose agents that don't count toward the
// "≥2 collab peers" heuristic. These are first-party helpers
// (welcomer/clerk/summarizer/bot), not collab peers a human would
// huddle with.
const NON_COLLAB_PEER_AGENTS = new Set([
  'commonly-bot',
  'pod-welcomer',
  'task-clerk',
  'pod-summarizer',
]);

// Decide whether a pod qualifies as a "collaborative huddle" for
// inline-cue purposes. Centralized here so the heuristic is easy to
// audit and tune.
//
// Inputs come from data the caller already has loaded:
//   podType: pod.type ('team' / 'chat' / 'agent-room' / 'agent-dm' / ...)
//   installations: AgentInstallation rows for the pod (already fetched
//                  by enqueueMentions before this function runs)
const isCollaborativePod = (
  podType: string | undefined | null,
  installations: Array<Record<string, unknown>>,
): boolean => {
  if (podType && NON_COLLAB_POD_TYPES.has(podType)) return false;
  const peerCount = installations.reduce((acc, inst) => {
    const name = String((inst as { agentName?: string })?.agentName || '').toLowerCase();
    return NON_COLLAB_PEER_AGENTS.has(name) ? acc : acc + 1;
  }, 0);
  return peerCount >= 2;
};

// Compose the payload.content prefix per event type AND target runtime.
// All chat.mention events get a reply-mechanics cue (heartbeat-clobber
// mitigation); thread.mention events skip it. All non-specialist targets
// get a consultation cue (cross-runtime collab nudge); specialists skip
// it. Both pieces compose with the pod-context cue that fires for
// every mention. When the pod looks like a collaborative huddle AND
// the target is a non-specialist, the collab-pod cue is added too —
// see formatCollaborativePodCue above.
//
// `message.posted` (wake-on-message, D8) composes here too. It used to
// build its own prefix inline, which is why it shipped without the
// pod-context frame for its whole life: the frame is unconditional for
// every event type that goes through this builder, and the wake path
// simply wasn't one of them. That cost a woken agent the podId it needs
// for commonly_attach_file / commonly_read_file, and — the part that
// isn't a convenience — the post-as-yourself rule, which is the guard
// against a turn being misattributed to a human. An event type that
// composes its own frames is an event type that silently misses the
// next frame added here, so the fix is routing, not a copied string.
//
// The two chat.mention-gated cues stay OFF for wakes, and that is a
// decision rather than an oversight. Both nudge toward acting — the
// reply cue says post as soon as the reply is ready, the collab cue
// says execute it yourself and post the result — while a wake's whole
// contract is that silence is the default and nobody named you. Their
// stated gating rationale ("thread.mention posts via a different path",
// "thread.mention is a different posture") does read as though it would
// admit message.posted, since a wake reply lands on exactly the primary
// pod-chat path chat.mention does. Widening them is defensible; it is
// a behavioural change to the busiest event type we emit, so it wants
// its own measurement rather than a ride on a missing-frame fix.
//
// Final shapes (collab denotes the collaborative-pod cue). [Author] is
// unconditional and was missing from this table until the wake path was
// routed through here — the table is the thing people read to decide
// what a given event type carries, so it is kept exhaustive:
//   chat.mention + non-specialist + collab → [Pod] [Author] [CollabPod] [Collab] [Reply] body
//   chat.mention + non-specialist + solo   → [Pod] [Author] [Collab] [Reply] body
//   chat.mention + specialist              → [Pod] [Author] [Reply] body
//   thread.mention + non-specialist        → [Pod] [Author] [Collab] body
//   thread.mention + specialist            → [Pod] [Author] body
//   message.posted + non-specialist        → [Pod] [Author] [Collab] [Wake] body
//   message.posted + specialist            → [Pod] [Author] [Wake] body
const buildContentForTarget = (
  podId: string,
  rawContent: string,
  eventType: 'chat.mention' | 'thread.mention' | 'message.posted',
  targetAgentName: string,
  collaborativePod: boolean,
  // Required, not defaulted: an omitted `author` is what makes the
  // fabricated-stamp path reachable by accident. All four call sites
  // pass it today, so requiring it costs nothing now and turns a future
  // omission into a compile error instead of a silent "unknown".
  author: { username?: string; createdAt?: unknown; messageId?: string },
): string => {
  const frames: string[] = [formatPodContextFrame(podId)];
  // First after pod context, and unconditional: every event type and
  // every runtime needs to know who spoke and when. The four cues below
  // are all conditional on shape; this one never is.
  frames.push(formatAuthorFrame(author.username, author.createdAt, author.messageId));
  if (
    eventType === 'chat.mention'
    && collaborativePod
    && !isCodeSpecialistAgent(targetAgentName)
  ) {
    frames.push(formatCollaborativePodCue());
  }
  if (!isCodeSpecialistAgent(targetAgentName)) {
    frames.push(formatConsultationCue());
  }
  if (eventType === 'chat.mention') {
    frames.push(formatMentionReplyCue(podId));
  }
  // Last before the body on purpose: this is the frame that tells the
  // agent why it is awake at all, and proximity to the body is the one
  // ordering lever we have.
  if (eventType === 'message.posted') {
    frames.push(WAKE_ON_MESSAGE_FRAME);
  }
  return `${frames.join('\n')}\n\n${rawContent}`;
};

const normalizeUserId = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === 'object') {
    const nestedId = (value as { _id?: unknown })._id;
    return nestedId ? String(nestedId) : null;
  }
  return String(value);
};

const resolveImplicitReplyTarget = async (
  replyToMessageId: string,
  message: EnqueueMentionsOptions['message'],
  installations: Array<Record<string, unknown>>,
): Promise<MentionTarget | null> => {
  let replyAuthorUserId = normalizeUserId(message.replyTo?.userId);

  // The controller normally passes the populated PG row, whose replyTo
  // already carries the author id. Keep a lookup fallback for other callers
  // and older response shapes that only pass replyToMessageId.
  if (!replyAuthorUserId) {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const PGMessage = require('../models/pg/Message') as {
      findById: (id: string) => Promise<{ user_id?: unknown; userId?: unknown } | null>;
    };
    const repliedMessage = await PGMessage.findById(replyToMessageId);
    replyAuthorUserId = normalizeUserId(repliedMessage?.user_id || repliedMessage?.userId);
  }
  if (!replyAuthorUserId) return null;

  const replyAuthor = await User.findById(replyAuthorUserId)
    .select('isBot botMetadata')
    .lean() as SenderRow | null;
  const agentName = replyAuthor?.isBot
    ? replyAuthor.botMetadata?.agentName?.toLowerCase()
    : null;
  const instanceId = replyAuthor?.isBot
    ? (replyAuthor.botMetadata?.instanceId || 'default').toLowerCase()
    : null;
  if (!agentName || !instanceId) return null;

  const activeInstallation = installations.find((installation) => (
    String(installation.agentName || '').toLowerCase() === agentName
    && String(installation.instanceId || 'default').toLowerCase() === instanceId
  ));
  if (!activeInstallation) return null;
  return {
    agentName: String(activeInstallation.agentName || agentName),
    instanceId: String(activeInstallation.instanceId || instanceId),
  };
};

// Personal pods auto-route every message to non-sender members as a
// chat.mention event. This is intentionally broader than the strict-1:1
// DM guard: agent-admin is N:1 but still has personal delivery semantics.
const isAutoRoutedDmPod = (type: unknown): boolean => isPersonalPodType(type);

// ── ADR-018 D8: wake-on-message ─────────────────────────────────────────────
//
// Per-install opt-in (`config.wakeOnMessage.enabled === true`, default OFF,
// revertible — a setting, not a ratchet). An opted-in agent wakes on every
// message in the pod as a `message.posted` event; the claim layer (#892/#894)
// arbitrates who acts, so "all wake, one acts". The kernel side is
// deliberately dumb: it fans out and lets claims + the wrapper cascade cap do
// the coordination. Nothing here fires for installs that never opted in.

// Inline cue, not metadata (the payload.content rule): a woken agent must
// know it was NOT named, that silence is the default, and that acting starts
// with a claim. `message.posted` is already in the CLI wrapper's prompt set,
// so deployed wrappers hear this without a driver change (D5).
const WAKE_ON_MESSAGE_FRAME = '[Wake-on-message: you wake on EVERY message in '
  + 'this pod — nobody named you. Most messages need nothing from you; act '
  + 'only when you add material value, otherwise return NO_REPLY as your '
  + 'ENTIRE reply — the token silences only when it IS the reply or OPENS it; '
  + 'anywhere else it is stripped and the rest of your message POSTS PUBLICLY '
  + '(AX entry 43: 11 leaked private rationales in one day). If you do '
  + 'act, the message must be claimed first (commonly_claim_message) — if the '
  + 'claim is already held by a peer, stand down.]';

// Stronger than the ambient frame, weaker than an @mention: the sender did
// not name this agent, but they replied to (or threaded on) ITS message —
// the conversational equivalent of turning toward someone mid-meeting.
// Interim for TASK-058; the principled ADR-018 amendment supersedes this.
const REPLIES_TO_YOU_FRAME = '[This message replies to YOUR earlier message — '
  + 'you are addressed even though nobody typed your @name. Respond when a '
  + 'response is genuinely useful; if the exchange has concluded, return '
  + 'NO_REPLY as your ENTIRE reply — the token silences only when it IS the '
  + 'reply or OPENS it; anywhere else it is stripped and the rest POSTS '
  + 'PUBLICLY.]';

const wakeOnMessageEnabled = (installation: Record<string, unknown>): boolean => (
  (installation as { config?: { wakeOnMessage?: { enabled?: unknown } } })
    ?.config?.wakeOnMessage?.enabled === true
);

/**
 * Board wakes (task-board deltas and the #1055 kernel found-work sweep) are a
 * SEPARATE subscription from ambient chat, and this predicate is the split.
 *
 * They were one flag until now, which made the two indistinguishable at
 * install time: a persona whose whole job is the board — Planner is the case
 * that forced this (#1071, TASK-033) — could only subscribe by also taking
 * every chat message in the pod. That is the opposite of what a board-shaped
 * card wants, and "just set wakeOnMessage" was the only available answer.
 *
 * Backward compatibility is the load-bearing half. `boardWake` ABSENT inherits
 * `wakeOnMessage`, so every existing install keeps exactly the delivery it has
 * today — measured at 34 of 263 active installs with wakeOnMessage on and zero
 * carrying a boardWake key, so the inherit branch is the entire live
 * population and the explicit branch is currently unreachable. Setting
 * `boardWake.enabled` explicitly overrides in either direction:
 *
 *   boardWake absent, wakeOnMessage on   -> board wakes  (today's behaviour)
 *   boardWake absent, wakeOnMessage off  -> no board wakes (today's behaviour)
 *   boardWake.enabled true               -> board wakes, whatever chat says
 *   boardWake.enabled false              -> no board wakes, whatever chat says
 *
 * The fourth row is the one that did not exist before: a seat can now hear the
 * room without hearing the board, and a seat can hear the board without
 * hearing the room.
 */
const boardWakeEnabled = (installation: Record<string, unknown>): boolean => {
  const cfg = (installation as {
    config?: { boardWake?: { enabled?: unknown } };
  })?.config;
  const explicit = cfg?.boardWake?.enabled;
  if (explicit === true) return true;
  if (explicit === false) return false;
  return wakeOnMessageEnabled(installation);
};

// #508's shape, pointed at the wake path: a BOT-authored message that would
// wake a target already woken >MENTION_LOOP_MAX times in the window is a wake
// storm, not collaboration. Human-authored messages are never dampened —
// callers only invoke this for bot senders. Count failure falls through to
// enqueue: dropping a possibly-genuine wake is the worse error.
const isWakeLoopDampened = async (
  target: { agentName: string; instanceId?: string },
  podId: string,
): Promise<boolean> => {
  try {
    const count = await AgentEvent.countDocuments({
      agentName: target.agentName.toLowerCase(),
      instanceId: target.instanceId || 'default',
      podId,
      type: 'message.posted',
      createdAt: { $gte: new Date(Date.now() - MENTION_LOOP_WINDOW_MS) },
    });
    if (count > MENTION_LOOP_MAX) {
      console.warn(
        `[wake-dampener] suppressed bot-authored wake storm — `
        + `target=${target.agentName.toLowerCase()}:${target.instanceId || 'default'} pod=${podId} count=${count}`,
      );
      return true;
    }
  } catch (err) {
    console.warn('[wake-dampener] loop count check failed (allowing through):', (err as Error).message);
  }
  return false;
};

/** `agentName:instanceId`, lowercased — the identity an install and a bot User row share. */
const installKey = (inst: { agentName?: unknown; instanceId?: unknown }): string => `${
  String(inst.agentName || '').toLowerCase()}:${String(inst.instanceId || 'default')}`;

/** A thread root arrives from PG as either its numeric column or JSON spelling. */
const resolveThreadRootId = (message: EnqueueMentionsOptions['message']): number | null => {
  const raw = message.thread_root_id ?? message.threadRootId;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/**
 * Map each install to its BOT's User row id — the key thread_user_state uses.
 *
 * One query for the whole target list rather than one per target: the wake
 * fan-out already runs per message, and a per-install lookup would put N
 * round-trips on the hot path.
 *
 * A failure resolves to an EMPTY map, not a throw. Every `identify` then
 * returns null, narrowToThread keeps every target, and scoping degrades to
 * today's unscoped delivery. Losing the narrowing is a noisier pod; losing
 * the wake is a message nobody sees.
 */
const resolveBotUserIds = async (
  targets: Array<{ agentName?: unknown; instanceId?: unknown }>,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const wanted = [...new Set(targets.map(installKey))].filter((k) => !k.startsWith(':'));
  if (wanted.length === 0) return out;
  try {
    const rows = await User.find({
      isBot: true,
      $or: wanted.map((k) => {
        const [agentName, instanceId] = k.split(':');
        return { 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId };
      }),
    }).select('_id botMetadata.agentName botMetadata.instanceId').lean() as Array<{
      _id: unknown; botMetadata?: { agentName?: string; instanceId?: string };
    }>;
    for (const row of rows) {
      const key = `${String(row.botMetadata?.agentName || '').toLowerCase()}:${
        String(row.botMetadata?.instanceId || 'default')}`;
      out.set(key, String(row._id));
    }
  } catch (err) {
    console.warn('[thread-scope] bot user resolution failed (delivering unscoped):', (err as Error).message);
    return new Map();
  }
  return out;
};

/**
 * Resolve explicit @handles that belong to humans, not installed agents.
 *
 * The composer inserts a member's real username, while `extractMentions`
 * normalizes that handle to lowercase for the agent resolver. Usernames are
 * not themselves case-normalized at write time, so the lookup is anchored and
 * case-insensitive rather than assuming a lowercased stored value. Handles
 * are extracted from `[a-z0-9_-]`, but anchoring keeps a prefix such as
 * `@casey` from following `casey-admin` too.
 *
 * This is deliberately best-effort for the same reason as bot resolution:
 * the message is already durable. A Mongo failure must not turn a successful
 * send into a 500; it only leaves this one implicit follow unmaterialized.
 */
const resolveHumanMentionUserIds = async (
  mentions: Iterable<string>,
  podMemberIds: Set<string>,
): Promise<Set<string>> => {
  const handles = [...new Set(Array.from(mentions).filter(Boolean))];
  if (handles.length === 0 || podMemberIds.size === 0) return new Set<string>();
  try {
    const rows = await User.find({
      isBot: false,
      $or: handles.map((username) => ({ username: new RegExp(`^${username}$`, 'i') })),
    }).select('_id username').lean() as Array<{ _id?: unknown }>;
    return new Set(
      rows
        .map((row) => String(row._id || ''))
        .filter((userId) => Boolean(userId) && podMemberIds.has(userId)),
    );
  } catch (err) {
    console.warn('[thread-follow] human mention resolution failed:', (err as Error).message);
    return new Set<string>();
  }
};

/**
 * Persist the follow implied by explicit mention targets in a thread.
 *
 * Agent ids enter this list only after their event has been enqueued; human
 * ids come from the same message's explicit handles, because humans have no
 * AgentEvent delivery row. This keeps all implicit mention follows at the
 * one post-persistence choke point. `followByParticipation` preserves an
 * explicit mute by writing only where `following IS NULL`.
 */
const followMentionedThreadUsers = async (
  threadRootId: number,
  podId: string,
  userIds: Iterable<string>,
): Promise<void> => {
  await Promise.all([...new Set(userIds)].map(async (userId) => {
    try {
      await ThreadUserState.followByParticipation(threadRootId, userId, podId);
    } catch (error) {
      // The message and its address are already durable. Keep the failure
      // visible without making a successful send look failed to the author.
      console.warn('[thread-follow] mention follow write failed:', (error as Error).message);
    }
  }));
};

/**
 * Fan a message out to the pod's wake-on-message opt-ins. Skips the sender's
 * own identity (an agent never wakes on its own post), anything the mention
 * path already enqueued this message (a mention is the stronger cue — double
 * delivery would burn a second model turn on the same trigger), and DM-shaped
 * pods (enqueueDmEvent already routes every message there).
 *
 * The zero-opt-in fast path costs nothing beyond the installations array the
 * caller already loaded — no queries, no pod lookup.
 */
const enqueueWakeOnMessage = async ({
  podId, message, rawContent, userId, username, source, installations, sender, excludeKeys, authorFrame, resolvedBotUserIds,
  replyToMessageId = null,
}: {
  podId: string;
  message: EnqueueMentionsOptions['message'];
  rawContent: string;
  userId: string;
  username: string;
  source: string;
  installations: Array<Record<string, unknown>>;
  sender: SenderRow | null;
  excludeKeys: Set<string> | null;
  authorFrame: { username: string; createdAt: unknown; messageId: string | undefined };
  resolvedBotUserIds?: Map<string, string>;
  replyToMessageId?: string | null;
}): Promise<string[]> => {
  const woken: string[] = [];
  let targets = (installations || []).filter(wakeOnMessageEnabled);
  if (targets.length === 0) return woken;

  // Ambient-only thread scoping (W-T 3/4, #1045). A reply inside a thread is
  // AMBIENT: it reaches the thread's effective followers, not the room.
  //
  // Applied HERE, to the already-computed opt-in list, and nowhere else. Two
  // consequences that are the point rather than side effects:
  //  - it can only NARROW. A thread follower who never opted into
  //    wake-on-message still gets nothing, because threading is additive and
  //    must not start delivering to seats that opted into nothing.
  //  - it cannot touch addressing. NOT because this branch is unreachable on
  //    a routed message — it is reachable, via the second call site at the
  //    tail of enqueueMentions, which runs unconditionally so a routed
  //    message's ambient companion is scoped too. It cannot touch addressing
  //    because the chat.mention has ALREADY been enqueued by the time this
  //    runs, and the mentioned seat arrives here inside `excludeKeys`. A mute
  //    scopes ambient activity; it never suppresses being addressed.
  //    (An earlier version of this comment claimed the branch runs only when
  //    `!isRouted`, contradicting the call-site comment below it and giving a
  //    reader the right conclusion from a false mechanism.)
  //
  // Keyed on the BOT's User row id, which is what thread_user_state.user_id
  // holds: the follow/mute routes are dualAuth, so an agent writing its own
  // thread state writes under `req.agentUser._id`.
  //
  // NOT `installedBy`. @sprint-review's blocker (57291) was right and the
  // comment that used to sit here was wrong. `installedBy` is written with
  // two different identities depending on who installed the agent — the bot
  // itself at agentAutoJoinService:80, podWriteAccessService:48 and three
  // sites in agentsRuntime, but the HUMAN installer at podController:119,
  // personaHireService:93, podCurationService:147, authController:201 and
  // agentProfile:259 (AgentRun.ts:65 calls it "the hiring user" outright).
  // The schema declares a bare ObjectId with no ref, so nothing at the type
  // level distinguishes them.
  //
  // Keying on it would have read a human-installed agent's thread state off
  // its INSTALLER's row: the human's mute would silence the agent, and the
  // agent's own mute would be ignored. Both directions wrong, on a field
  // whose name reads correct.
  //
  // An install whose bot User row cannot be resolved is KEPT by
  // narrowToThread rather than dropped — an unclassifiable target must
  // degrade to today's behaviour, never to silence.
  const threadRootId = resolveThreadRootId(message);
  // Resolved at most ONCE per fan-out whoever needs it first — the thread
  // narrowing and the reply-evidence stamp share this (a suite pins the
  // single User.find).
  let cachedBotUserIds: Map<string, string> | undefined = resolvedBotUserIds;
  if (threadRootId) {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { narrowToThread } = require('./threadWakeScopeService');
    cachedBotUserIds = cachedBotUserIds ?? await resolveBotUserIds(targets);
    const botUserIds = cachedBotUserIds;
    targets = await narrowToThread(
      threadRootId,
      targets,
      (inst: Record<string, unknown>) => botUserIds.get(installKey(inst)) ?? null,
    );
    if (targets.length === 0) return woken;
  }

  let podRow: { type?: string } | null = null;
  try {
    podRow = await Pod.findById(podId).select('type').lean() as { type?: string } | null;
  } catch {
    // Cannot verify the pod type — skip rather than risk double-delivering
    // into a DM pod that enqueueDmEvent already covers.
    return woken;
  }
  if (podRow?.type && isAutoRoutedDmPod(podRow.type)) return woken;

  // Truthful inputs, not a hardcoded false: the collab cue is held off
  // wakes by its own event-type gate inside buildContentForTarget, so
  // passing the real value here means widening that gate later is a
  // one-line change instead of a hunt for a call site that lied.
  const collaborativePod = isCollaborativePod(podRow?.type, installations);

  const senderKey = sender?.isBot
    ? `${String(sender.botMetadata?.agentName || '').toLowerCase()}:${String(sender.botMetadata?.instanceId || 'default').toLowerCase()}`
    : null;

  // Reply-evidence flag (ADR-018 D6.3, interim). The #703 implicit-reply path
  // is gated on `sender.isBot === false`, so a BOT's reply to an agent's
  // message reaches its author as plain ambient activity — and the claim
  // layer then orders that author to stand down from its own conversation
  // (observed live: Sage stood down twice on Anvil's thread replies,
  // 2026-08-24). This does NOT widen ADDRESSED_EVENT_TYPES or add events:
  // the same message.posted fan-out carries per-target EVIDENCE — "this
  // message replies to something you wrote" — and the wrapper decides what
  // that evidence is worth. Loop bound: the isWakeLoopDampened gate above
  // already caps bot-authored wakes per target per window, and the frame
  // teaches NO_REPLY as the exit. D6.3's guard 2 (convergence) — two
  // consecutive NO_REPLYs from a seat mute further IMPLICIT wakes for that
  // seat+thread — is NOT implemented, so the dampener is the only loop bound.
  // Read the ADR before widening this: the decision is deliberately staged.
  const parentMessageId = String(
    replyToMessageId || (message as { reply_to_message_id?: unknown })?.reply_to_message_id || threadRootId || '',
  ) || null;
  let parentAuthorUserId: string | null = null;
  if (parentMessageId) {
    const isReplyParent = parentMessageId !== String(threadRootId || '');
    parentAuthorUserId = isReplyParent ? normalizeUserId(message?.replyTo?.userId) : null;
    if (!parentAuthorUserId) {
      try {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const PGMessage = require('../models/pg/Message') as {
          findById: (id: string) => Promise<{ user_id?: unknown; userId?: unknown } | null>;
        };
        const parentRow = await PGMessage.findById(parentMessageId);
        parentAuthorUserId = normalizeUserId(parentRow?.user_id || parentRow?.userId);
      } catch {
        parentAuthorUserId = null; // evidence is best-effort; ambient behaviour is the floor
      }
    }
  }
  if (parentAuthorUserId && !cachedBotUserIds) {
    cachedBotUserIds = await resolveBotUserIds(targets);
  }
  const parentBotUserIds = parentAuthorUserId ? (cachedBotUserIds ?? null) : null;

  await Promise.all(targets.map(async (inst) => {
    const agentName = String(inst.agentName || '').toLowerCase();
    if (!agentName) return;
    const instanceId = String(inst.instanceId || 'default');
    const key = `${agentName}:${instanceId.toLowerCase()}`;
    if (key === senderKey) return;
    if (excludeKeys?.has(key)) return;
    if (senderKey && await isWakeLoopDampened({ agentName, instanceId }, podId)) return;
    const repliesToYou = !!(parentAuthorUserId
      && parentBotUserIds
      && parentBotUserIds.get(installKey(inst)) === parentAuthorUserId);
    try {
      const built = buildContentForTarget(
        podId,
        rawContent,
        'message.posted',
        agentName,
        collaborativePod,
        authorFrame,
      );
      await AgentEventService.enqueue({
        agentName,
        instanceId,
        podId,
        type: 'message.posted',
        payload: {
          messageId: authorFrame.messageId,
          // Inline cue, not only metadata — the flag below is for the
          // wrapper's claim decision; the model reads the content.
          content: repliesToYou ? `${REPLIES_TO_YOU_FRAME}\n${built}` : built,
          userId,
          username,
          source,
          messageType: message?.messageType || message?.message_type || 'text',
          createdAt: message?.createdAt || message?.created_at || new Date(),
          wakeOnMessage: true,
          ...(repliesToYou ? { repliesToYourMessage: true } : {}),
        },
      });
      woken.push(agentName);
    } catch (error) {
      console.warn('Failed to enqueue wake-on-message event:', (error as Error).message);
    }
  }));
  return woken;
};

const enqueueMentions = async ({
  podId,
  message,
  userId,
  username,
  replyToMessageId,
}: EnqueueMentionsOptions): Promise<EnqueueResult> => {
  const rawContent = message?.content || message?.text || '';
  const source = message?.source || 'chat';
  const eventType: (typeof MENTION_EVENT_TYPES)[number] = source === 'thread' ? 'thread.mention' : 'chat.mention';
  // Author/age frame inputs — identical for every target of this
  // message, so resolved once here rather than at each of the four
  // enqueue sites below. Same values that already go into the envelope
  // fields; the frame is what actually reaches the model.
  // No `|| new Date()` here, deliberately — the envelope's own
  // createdAt field defaults to now (wire compatibility), but the frame
  // must not: defaulting at BOTH layers means the fallback is doubled
  // rather than checked, and the frame would assert a fabricated write
  // time as ground truth. Absent stays absent; formatAuthorFrame says
  // so out loud.
  const authorFrame = {
    username,
    createdAt: message?.createdAt || message?.created_at,
    messageId: message?._id || message?.id ? String(message?._id || message?.id) : undefined,
  };
  // Per-target content composition: see buildContentForTarget above for
  // the four-case matrix (chat-vs-thread × specialist-vs-not). Each
  // enqueue site below passes its own `targetAgentName` so the cue
  // composition is correct for that target's runtime.
  const rawMentions = extractMentions(rawContent);
  if (!podId) {
    return {
      enqueued: [], implicit: [], skipped: [], woken: [],
    };
  }
  // "Routed" means the message already names its recipient — an @mention, or
  // a reply that the #703 path resolves. Everything else reaches nobody, and
  // for a member's FIRST message in a pod that is the #834 gap.
  const isRouted = rawMentions.length > 0 || !!replyToMessageId;

  // Sender identity is resolved BEFORE the unrouted early-return below,
  // because the welcome wake has to know whether the sender is human. It was
  // previously resolved further down, where only the routed path could see
  // it. Uses of it (the self-mention guard) are all downstream and unchanged.
  //
  // Self-mention guard: if the sender is a bot, resolve their own
  // (agentName, instanceId) so we can skip re-enqueuing an event on themselves.
  // Without this, any agent whose reply echoes its own handle (e.g. the
  // webhook-SDK "echo:" template, or a CLI-wrapper that quotes the mention)
  // triggers an infinite chat.mention → reply → chat.mention loop.
  let sender: SenderRow | null = null;
  try {
    sender = await User.findById(userId).select('isBot botMetadata').lean() as SenderRow | null;
  } catch (error) {
    // Non-fatal: missing sender just means we can't suppress self-mentions,
    // which is a strictly weaker invariant than the one we had before.
    console.warn('Agent mention sender lookup failed:', (error as Error).message);
  }

  let installations: Array<Record<string, unknown>> = [];
  let profiles: Array<Record<string, unknown>> = [];
  try {
    installations = await AgentInstallation.find({
      podId,
      status: 'active',
    }).lean();
    // Profiles feed the mention map only, so an unrouted message never needs
    // them. Kept behind the routed check to hold the added cost of reaching
    // this point on every message down to two queries rather than three.
    if (isRouted) profiles = await AgentProfile.find({ podId }).lean();
  } catch (error) {
    console.warn('Agent mention lookup failed:', (error as Error).message);
  }

  // #834: claim the member's first-message marker, and wake the pod's
  // designated greeter when that first message named nobody. Claimed for
  // routed first messages too — otherwise a member whose opener was
  // "@codex help" gets welcomed on their SECOND message. Bots never claim:
  // an agent's first post in a pod would otherwise seed a wake loop, the same
  // reasoning that gates the #703 implicit path on `isBot === false`.
  if (sender?.isBot === false) {
    try {
      await maybeFireWelcomeWake({
        podId,
        userId,
        username,
        content: rawContent,
        messageId: message?._id || message?.id
          ? String(message?._id || message?.id)
          : undefined,
        isRouted,
        installations,
      });
    } catch (error) {
      // The message is already persisted; a welcome failure must never turn a
      // successful human send into a 500.
      console.warn('[welcome-wake] failed:', (error as Error).message);
    }
  }

  if (!isRouted) {
    // D8: an unrouted message reaches nobody on the mention path, but it is
    // exactly what a wake-on-message opt-in asked to hear about.
    //
    // ONE OF TWO CALL SITES. The other is at the end of this function, for
    // ROUTED messages, waking the opt-ins the mention path did not reach.
    // This early return is not the only path into enqueueWakeOnMessage, and
    // reading it as one is a mistake this seat made twice on 2026-08-22 —
    // asserting that a routed message never reaches ambient fan-out, which is
    // false. An early return bounds the code BELOW it, never a helper that a
    // later call site re-enters.
    let woken: string[] = [];
    try {
      woken = await enqueueWakeOnMessage({
        podId, message, rawContent, userId, username, source, installations, sender, excludeKeys: null, authorFrame, replyToMessageId,
      });
    } catch (error) {
      // The message is already persisted — a wake failure must never turn a
      // successful send into a 500.
      console.warn('[wake-on-message] fan-out failed:', (error as Error).message);
    }
    return {
      enqueued: [], implicit: [], skipped: [], woken,
    };
  }

  const enqueued: string[] = [];
  const implicit: string[] = [];
  const skipped: string[] = [];
  const enqueuedIdentityKeys = new Set<string>();
  // This is deliberately distinct from `enqueuedIdentityKeys`: the latter
  // also records a reply-edge delivery, which is addressing but not an
  // explicit @mention and therefore must not create a follow.
  const deliveredAgentMentionTargets = new Map<string, MentionTarget>();
  const identityKey = (target: MentionTarget): string => (
    `${target.agentName.toLowerCase()}:${(target.instanceId || 'default').toLowerCase()}`
  );
  const recordEnqueued = (
    target: MentionTarget,
    resultLabel = target.agentName,
    isExplicitMention = true,
  ): void => {
    enqueuedIdentityKeys.add(identityKey(target));
    enqueued.push(resultLabel);
    if (isExplicitMention) deliveredAgentMentionTargets.set(identityKey(target), target);
  };

  const { map: mentionMap, byAgent } = buildMentionMap(installations, profiles);
  // Preserve established agent routing when a handle is an agent alias. Human
  // resolution owns only names no installed-agent path already claims; the
  // composer otherwise has no typed identity on the wire to disambiguate a
  // human username from an agent display alias.
  const humanMentionHandles = rawMentions.filter((handle) => (
    !mentionMap.has(handle) && !aliasMap.has(handle)
  ));
  let pod: Record<string, unknown> | null = null;

  // Resolve pod type + membership once per enqueueMentions call. Type gives
  // every agent target a consistent collaboration cue; membership ensures a
  // manually typed human @handle cannot create state for someone outside the
  // pod. If the lookup fails, the cue falls back to "installations-only" and
  // human follow materialization safely skips rather than guessing.
  let podType: string | null = null;
  let podMemberIds = new Set<string>();
  try {
    const podRow = await Pod.findById(podId).select('type members').lean() as {
      type?: string; members?: unknown[];
    } | null;
    podType = podRow?.type || null;
    podMemberIds = new Set((podRow?.members || []).map((member) => String(member)));
  } catch (error) {
    // Non-fatal — collab detection falls back to count-only heuristic.
    console.warn('[mention-context] pod lookup failed:', (error as Error).message);
  }
  const collaborativePod = isCollaborativePod(podType, installations);

  const senderAgentName = sender?.isBot ? sender.botMetadata?.agentName?.toLowerCase() : null;
  const senderInstanceId = sender?.isBot ? (sender.botMetadata?.instanceId || 'default') : null;
  const isSelfMention = (target: MentionTarget): boolean => (
    !!senderAgentName
    && target.agentName.toLowerCase() === senderAgentName
    && (target.instanceId || 'default') === senderInstanceId
  );

  // #508 mutual bot<->bot loop dampener. Returns true when this mention
  // should be SUPPRESSED because the target bot has already been mentioned
  // more than MENTION_LOOP_MAX times in this pod within the recent window.
  // Counts BOTH mention types (MENTION_EVENT_TYPES) because it gates both —
  // see the constant for why the budget is shared rather than per-type.
  // CRITICAL: only dampens bot->bot. `senderAgentName` is non-null ONLY
  // when the sender is a bot (set above from sender.isBot + botMetadata), so
  // a human sender short-circuits to `false` and is NEVER dampened. The
  // count check failing is non-fatal — fall through to enqueue rather than
  // drop a possibly-genuine mention.
  const isLoopDampened = async (target: MentionTarget): Promise<boolean> => {
    if (!senderAgentName) return false; // human (or unknown) sender — never dampen
    try {
      const count = await AgentEvent.countDocuments({
        agentName: target.agentName.toLowerCase(),
        instanceId: target.instanceId || 'default',
        podId,
        type: { $in: MENTION_EVENT_TYPES },
        createdAt: { $gte: new Date(Date.now() - MENTION_LOOP_WINDOW_MS) },
      });
      if (count > MENTION_LOOP_MAX) {
        console.warn(
          `[mention-dampener] suppressed bot<->bot loop — sender=${senderAgentName}:${senderInstanceId} `
          + `target=${target.agentName.toLowerCase()}:${target.instanceId || 'default'} pod=${podId} count=${count}`,
        );
        return true;
      }
    } catch (err) {
      console.warn('[mention-dampener] loop count check failed (allowing through):', (err as Error).message);
    }
    return false;
  };

  await Promise.all(
    rawMentions.map(async (raw) => {
      const normalized = raw.toLowerCase();
      const directMatch = mentionMap.get(normalized);
      if (directMatch) {
        if (isSelfMention(directMatch)) {
          skipped.push(`${directMatch.agentName}:self`);
          return;
        }
        if (await isLoopDampened(directMatch)) {
          skipped.push(`${directMatch.agentName}:loop-dampened`);
          return;
        }
        try {
          if (directMatch.agentName === 'commonly-bot') {
            pod = pod || await Pod.findById(podId).lean();
            let summary = await ChatSummarizerService.getLatestPodSummary(podId);
            if (!summary) {
              summary = await chatSummarizerService.summarizePodMessages(podId);
            }
            await enqueueSummarizerEvent({
              podId,
              instanceId: directMatch.instanceId || 'default',
              summary: summary as Record<string, unknown> | null,
              pod: pod as Record<string, unknown> | null,
            });
            recordEnqueued(directMatch);
            return;
          }
          await AgentEventService.enqueue({
            agentName: directMatch.agentName,
            instanceId: directMatch.instanceId || 'default',
            podId,
            type: eventType,
            payload: {
              messageId: message?._id || message?.id
                ? String(message?._id || message?.id)
                : undefined,
              content: buildContentForTarget(podId, rawContent, eventType, directMatch.agentName, collaborativePod, authorFrame),
              userId,
              username,
              mentions: rawMentions,
              source,
              messageType: message?.messageType || message?.message_type || 'text',
              createdAt: message?.createdAt || message?.created_at || new Date(),
              thread: message?.thread || null,
            },
          });
          recordEnqueued(directMatch);
        } catch (error) {
          console.warn('Failed to enqueue agent mention:', (error as Error).message);
        }
        return;
      }

      // §3.4 mention-driven autoJoin — resolve unresolved aliases via
      // pod.contacts then sender.contacts, then upsert + add to pod and
      // proceed to enqueue. Behind ENABLE_MENTION_AUTOJOIN so the new
      // pod type can ship without flipping this in the same release.
      if (isMentionAutoJoinEnabled()) {
        try {
          // Single fetch of pod.contacts; both the resolver and the
          // admin-binding carve-out read from this snapshot so a binding
          // can't be removed between resolution and authorization (the
          // TOCTOU window the v1 implementation had).
          const podRow = await Pod.findById(podId).select('contacts').lean() as { contacts?: Record<string, { agentName?: string; instanceId?: string }> } | null;
          const podContacts = podRow?.contacts || null;
          const resolved = await resolveContactAlias(normalized, podContacts, userId);
          if (resolved) {
            const joined = await autoJoinAgentToPod(
              resolved.agentName,
              resolved.instanceId,
              podId,
              userId,
              resolved.source === 'pod',
            );
            if (joined) {
              await AgentEventService.enqueue({
                agentName: resolved.agentName,
                instanceId: resolved.instanceId,
                podId,
                type: eventType,
                payload: {
                  messageId: message?._id || message?.id
                    ? String(message?._id || message?.id)
                    : undefined,
                  content: buildContentForTarget(podId, rawContent, eventType, resolved.agentName, collaborativePod, authorFrame),
                  userId,
                  username,
                  mentions: rawMentions,
                  source,
                  messageType: message?.messageType || message?.message_type || 'text',
                  createdAt: message?.createdAt || message?.created_at || new Date(),
                  thread: message?.thread || null,
                  autoJoined: true,
                },
              });
              recordEnqueued(
                { agentName: resolved.agentName, instanceId: resolved.instanceId },
                `${resolved.agentName}:autoJoined`,
              );
              return;
            }
            skipped.push(`${normalized}:auth-refused`);
            return;
          }
        } catch (err) {
          console.warn('[mention-autojoin] resolution path failed:', (err as Error).message);
        }
      }

      const agentType = aliasMap.get(normalized);
      if (agentType) {
        const matches = byAgent.get(agentType) || [];
        if (matches.length === 0) {
          skipped.push(agentType);
          return;
        }
        await Promise.all(
          matches.map(async (match) => {
            if (isSelfMention({ agentName: agentType, instanceId: match.instanceId })) {
              skipped.push(`${agentType}:self`);
              return;
            }
            if (await isLoopDampened({ agentName: agentType, instanceId: match.instanceId })) {
              skipped.push(`${agentType}:loop-dampened`);
              return;
            }
            try {
              if (agentType === 'commonly-bot') {
                pod = pod || await Pod.findById(podId).lean();
                let summary = await ChatSummarizerService.getLatestPodSummary(podId);
                if (!summary) {
                  summary = await chatSummarizerService.summarizePodMessages(podId);
                }
                await enqueueSummarizerEvent({
                  podId,
                  instanceId: match.instanceId || 'default',
                  summary: summary as Record<string, unknown> | null,
                  pod: pod as Record<string, unknown> | null,
                });
                recordEnqueued({ agentName: agentType, instanceId: match.instanceId || 'default' });
                return;
              }
              await AgentEventService.enqueue({
                agentName: agentType,
                instanceId: match.instanceId || 'default',
                podId,
                type: eventType,
                payload: {
                  messageId: message?._id || message?.id
                    ? String(message?._id || message?.id)
                    : undefined,
                  content: buildContentForTarget(podId, rawContent, eventType, agentType, collaborativePod, authorFrame),
                  userId,
                  username,
                  mentions: rawMentions,
                  source,
                  messageType: message?.messageType || message?.message_type || 'text',
                  createdAt: message?.createdAt || message?.created_at || new Date(),
                  thread: message?.thread || null,
                },
              });
              recordEnqueued({ agentName: agentType, instanceId: match.instanceId || 'default' });
            } catch (error) {
              console.warn('Failed to enqueue agent mention:', (error as Error).message);
            }
          }),
        );
        return;
      }

      skipped.push(raw);
    }),
  );

  // One BOT User lookup serves both the delivered agent mention below and the
  // routed message's ambient wake fan-out. An auto-joined target is not in
  // the initial installation list yet, so include the actual delivery set.
  const threadRootId = resolveThreadRootId(message);
  let resolvedBotUserIds: Map<string, string> | undefined;
  if (threadRootId) {
    const followedUserIds = await resolveHumanMentionUserIds(humanMentionHandles, podMemberIds);
    if (deliveredAgentMentionTargets.size > 0) {
      resolvedBotUserIds = await resolveBotUserIds([
        ...installations,
        ...deliveredAgentMentionTargets.values(),
      ]);
      for (const target of deliveredAgentMentionTargets.values()) {
        const userId = resolvedBotUserIds.get(installKey(target));
        if (userId) followedUserIds.add(userId);
      }
    }
    if (followedUserIds.size > 0) {
      await followMentionedThreadUsers(threadRootId, podId, followedUserIds);
    }
  }

  // Human replies to an agent are an addressing signal even when the human
  // does not repeat an @mention. Bot replies are deliberately excluded: if
  // A's reply to B implicitly notified B (and vice versa), two agents could
  // ping-pong forever despite the existing self-mention guard.
  if (replyToMessageId && sender?.isBot === false) {
    try {
      const target = await resolveImplicitReplyTarget(replyToMessageId, message, installations);
      if (target && !enqueuedIdentityKeys.has(identityKey(target))) {
        await AgentEventService.enqueue({
          agentName: target.agentName,
          instanceId: target.instanceId || 'default',
          podId,
          type: 'chat.mention',
          payload: {
            messageId: message?._id || message?.id
              ? String(message?._id || message?.id)
              : undefined,
            content: buildContentForTarget(
              podId,
              rawContent,
              'chat.mention',
              target.agentName,
              collaborativePod,
              authorFrame,
            ),
            userId,
            username,
            mentions: rawMentions,
            source,
            messageType: message?.messageType || message?.message_type || 'text',
            createdAt: message?.createdAt || message?.created_at || new Date(),
            thread: message?.thread || null,
            replyToMessageId,
            implicitReply: true,
          },
        });
        recordEnqueued(target, target.agentName, false);
        implicit.push(target.agentName);
      }
    } catch (error) {
      // Reply routing is best-effort, like explicit mention routing. The
      // message is already persisted, so lookup/enqueue failure must not
      // turn a successful human send into a 500.
      console.warn('Failed to enqueue implicit reply mention:', (error as Error).message);
    }
  }

  // D8: after the mention path has spoken for its targets, wake the opt-ins
  // it did not reach. A mention-enqueued agent is excluded — the mention is
  // the stronger cue, and double delivery would burn a second model turn on
  // the same trigger message.
  //
  // SECOND OF TWO CALL SITES; the first is behind `if (!isRouted)` above. So
  // a ROUTED message does have an ambient fan-out, and anything scoping that
  // fan-out (thread scoping, W-T 3/4) applies here too. That is correct
  // rather than incidental: an addressed message must always deliver its
  // chat.mention, while the ambient companion has no stronger claim here than
  // it does on an unrouted message.
  let woken: string[] = [];
  try {
    woken = await enqueueWakeOnMessage({
      podId, message, rawContent, userId, username, source, installations, sender, excludeKeys: enqueuedIdentityKeys, authorFrame, resolvedBotUserIds, replyToMessageId,
    });
  } catch (error) {
    console.warn('[wake-on-message] fan-out failed:', (error as Error).message);
  }

  return {
    enqueued, implicit, skipped, woken,
  };
};

/**
 * Auto-enqueue a DM-origin chat.mention event for every user message in a
 * DM-shaped pod (agent-admin / agent-room / agent-dm). Unlike regular
 * mentions, no explicit @mention is required — the pod itself is the
 * routing primitive. For agent-dm with two bot members, the sender check
 * below allows bot-to-bot DMs to enqueue against the non-sender.
 */
const enqueueDmEvent = async ({
  podId, message, userId, username,
}: EnqueueDmOptions): Promise<EnqueueDmResult> => {
  const pod = await Pod.findById(podId).lean() as Record<string, unknown> | null;
  if (!pod || !isAutoRoutedDmPod(pod.type)) {
    return { enqueued: false, reason: 'not_dm_pod' };
  }

  // Pull botMetadata.displayName + username so we can build the inline DM
  // conversational frame (ADR-012 §9). For human senders, botMetadata is
  // empty and the cue falls back to username + "(human)".
  const sender = await User.findById(userId)
    .select('_id isBot username botMetadata')
    .lean() as { _id: unknown; isBot?: boolean; username?: string; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string } } | null;
  // Bot senders are allowed in agent-dm (the whole point) but still blocked
  // in agent-admin/agent-room — those are operator-driven personal surfaces;
  // a bot posting there shouldn't auto-route to itself.
  if (sender?.isBot && pod.type !== 'agent-dm') {
    return { enqueued: false, reason: 'sender_is_bot' };
  }

  // Bot-loop guard for agent-dm rooms. Without this, agent A and agent
  // B can ping-pong forever (every message auto-routes a chat.mention,
  // each reply does the same, neither stops — and humans aren't members
  // so they can't post a turn to break the streak themselves). The
  // guard refuses to enqueue when:
  //   - the sender is a bot, AND
  //   - the last MAX_CONSECUTIVE_BOT_TURNS messages in this pod are ALL
  //     from bots, AND
  //   - those messages are within the recent activity window (so a
  //     dormant DM picking back up tomorrow doesn't trip on yesterday's
  //     final exchange).
  // To resume after a trip, a human can @mention either bot in a pod
  // they share — that fires a chat.mention OUTSIDE agent-dm, and the
  // agent can choose to re-engage in the dm at its own discretion.
  const MAX_CONSECUTIVE_BOT_TURNS = 8;
  const ACTIVITY_WINDOW_MS = 30 * 60 * 1000; // 30 min
  if (sender?.isBot && pod.type === 'agent-dm') {
    try {
      // eslint-disable-next-line global-require
      const PGMessageLocal = require('../models/pg/Message');
      const recent = PGMessageLocal && typeof PGMessageLocal.findByPodId === 'function'
        ? (await PGMessageLocal.findByPodId(podId, MAX_CONSECUTIVE_BOT_TURNS)) as Array<{ user_id?: unknown; created_at?: unknown }>
        : null;
      if (recent && recent.length >= MAX_CONSECUTIVE_BOT_TURNS) {
        const cutoff = Date.now() - ACTIVITY_WINDOW_MS;
        const inWindow = recent.every((m) => {
          const t = new Date(String(m?.created_at || '')).getTime();
          return Number.isFinite(t) && t >= cutoff;
        });
        if (inWindow) {
          const recentSenderIds = recent
            .map((m) => String(m?.user_id || ''))
            .filter(Boolean);
          const uniqueSenders = Array.from(new Set(recentSenderIds));
          if (uniqueSenders.length > 0) {
            const recentBots = await User.find({
              _id: { $in: uniqueSenders },
              isBot: true,
            }).select('_id').lean() as Array<{ _id: unknown }>;
            const botIds = new Set(recentBots.map((u) => String(u._id)));
            const allBots = recentSenderIds.every((id) => botIds.has(id));
            if (allBots) {
              console.warn(`[agent-dm] bot-loop guard tripped — ${MAX_CONSECUTIVE_BOT_TURNS} consecutive bot turns in pod=${podId} within ${ACTIVITY_WINDOW_MS / 60000}min, refusing enqueue`);
              // ADR-012 §4: agent-dm-loop-trip — both peers' memory
              // envelopes record the trip. Fire-and-forget; never blocks the
              // guard return.
              try {
                // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
                const triggers = require('./systemExchangeTriggers') as {
                  recordAgentDmLoopTrip: (a: { podId: string }) => Promise<void>;
                };
                void triggers.recordAgentDmLoopTrip({ podId: String(podId) });
              } catch (triggerErr) {
                console.warn('[system-exchange] agent-dm-loop-trip dispatch failed:', (triggerErr as Error).message);
              }
              return { enqueued: false, reason: 'bot_loop_guard' };
            }
          }
        }
      }
    } catch (err) {
      console.warn('[agent-dm] bot-loop guard recent-message check failed (allowing through):', (err as Error).message);
    }
  }

  const senderIdStr = String(userId);
  const otherMemberIds = ((pod.members as unknown[]) || [])
    .map((m: unknown) => {
      const mem = m as { _id?: unknown } | string;
      return String(typeof mem === 'object' && mem !== null ? mem._id || mem : mem);
    })
    .filter((id) => id !== senderIdStr);

  if (otherMemberIds.length === 0) {
    return { enqueued: false, reason: 'no_other_member' };
  }

  const agentMembers = await User.find({
    _id: { $in: otherMemberIds },
    isBot: true,
  }).select('_id username botMetadata').lean() as Array<{
    _id: unknown;
    username: string;
    botMetadata?: { agentName?: string; instanceId?: string };
  }>;

  if (agentMembers.length === 0) {
    return { enqueued: false, reason: 'no_agent_user' };
  }

  const content = message?.content || message?.text || '';
  const enqueued: string[] = [];

  for (const agentUser of agentMembers) {
    const agentName = agentUser.botMetadata?.agentName || agentUser.username;
    const instanceId = agentUser.botMetadata?.instanceId || 'default';
    const mentionHandle = `@${instanceId}`;

    const installations = await AgentInstallation.find({
      agentName: agentName.toLowerCase(),
      instanceId,
      status: 'active',
    })
      .select('podId installedBy')
      .lean() as Array<{ podId: unknown; installedBy: unknown }>;

    if (!Array.isArray(installations) || installations.length === 0) continue;

    const senderScopedPodIds = new Set<string>(
      installations
        .filter((entry) => String(entry?.installedBy || '') === senderIdStr)
        .map((entry) => String(entry?.podId || ''))
        .filter(Boolean),
    );

    const memberPodCandidates = installations
      .map((entry) => entry?.podId)
      .filter(Boolean);
    if (memberPodCandidates.length > 0) {
      const memberPods = await Pod.find({
        _id: { $in: memberPodCandidates },
        members: userId,
      }).select('_id').lean() as Array<{ _id: unknown }>;
      memberPods.forEach((entry) => {
        const id = String(entry?._id || '');
        if (id) senderScopedPodIds.add(id);
      });
    }

    const availablePods = senderScopedPodIds.size > 0
      ? await Pod.find({ _id: { $in: Array.from(senderScopedPodIds) } })
        .select('_id name type')
        .lean() as Array<{ _id: unknown; name?: string; type?: string }>
      : [];
    const installationPodId = (installations[0]?.podId as { toString?: () => string })?.toString?.() || null;

    // dmKind tells the agent runtime *who's talking* on the other side
    // of this DM. The agent's reply policy hinges on this:
    //   - 'user-agent' → human is asking; reply to every new message
    //     (responsiveness matters even when there's little to add).
    //   - 'agent-agent' → another bot is asking; only reply if the
    //     message materially advances the work. When the conversation
    //     reaches a natural conclusion, return NO_REPLY. Silence is a
    //     valid contribution. The bot-loop guard above is the backstop
    //     when an agent doesn't honor this.
    // SOUL.md instructs the agent to branch on this field.
    const dmKind: 'agent-agent' | 'user-agent' = sender?.isBot ? 'agent-agent' : 'user-agent';

    // ADR-012 §9: inline DM conversational frame. dmKind on its own is a
    // structured metadata field — the LLM can deprioritize it when
    // composing replies. Putting the same intent at the START of the
    // message body, in narrative form, makes it impossible to ignore.
    // First-deploy production data (FakeSam ↔ Tarik smoke) showed Tarik
    // broadcasting "has anyone seen…" team-pod-style replies inside a
    // 1:1 DM despite dmKind being correct. The inline cue closes that gap.
    //
    // Cue resolves the peer's display label via the same fallback chain
    // as agentIdentityService.resolveAgentDisplayLabel (botMetadata
    // .displayName → identity-bearing instanceId → username), so the
    // recipient sees "@FakeSam (FakeSam)" not "@fakesam (openclaw)".
    //
    // NOTE: this cue is delivered ONLY through the chat.mention enqueue path
    // here. The PG-persisted message body is the un-framed `content` (correct
    // — humans see the un-framed text in the chat UI; downstream takeaway
    // derivation in systemExchangeTriggers.findPreviousNonSilentMessage reads
    // the un-framed copy too). If a future driver consumes DMs via a
    // different surface (poll endpoint, webhook re-delivery, replay), it
    // will see un-framed content and only have `dmKind` to fall back on —
    // which §9 of ADR-012 demonstrated is not sufficient. Either re-apply the
    // frame in that surface or move framing into AgentEventService.enqueue
    // when it becomes a meaningful chokepoint.
    // resolveAgentDisplayLabel is the canonical chain (botMetadata.displayName
    // → instanceId → username → fallback) plus leak-pattern detection that
    // skips displayName values shaped like `<agentName> (<instanceId>)` (the
    // historical runtime-label leak that produced labels like
    // "openclaw (nova)"). Using it here keeps the §9 frame consistent with
    // every other display surface (pod inspector, chat author chips, etc).
    const senderMeta = sender?.botMetadata || {};
    const senderInstanceLabel = (senderMeta.instanceId && senderMeta.instanceId !== 'default')
      ? senderMeta.instanceId
      : '';
    const senderDisplay = resolveAgentDisplayLabel(sender, sender?.username || username || 'peer').trim();
    // senderHandle filters 'default' the same way as senderDisplay above —
    // otherwise an agent on the literal 'default' instanceId would render as
    // "@default (DisplayName)", which is meaningless.
    const senderHandle = (senderInstanceLabel || sender?.username || username || 'peer').trim();
    const dmFrame = dmKind === 'agent-agent'
      ? `[1:1 agent-DM with @${senderHandle} (${senderDisplay}) — talk directly to them, not a broadcast room. Reply only when your message materially advances the work; return NO_REPLY (as your ENTIRE reply — it silences only when it IS the reply or OPENS it; anywhere else the rest posts publicly) when the exchange reaches a natural conclusion. Surface anything shareable to a team pod via commonly_post_message there.]`
      : `[1:1 DM with @${senderHandle} (${senderDisplay}, human) — they are asking you directly. Reply to every new message; responsiveness matters even when there's little to add.]`;
    const framedContent = `${dmFrame}\n\n${content}`;

    await AgentEventService.enqueue({
      agentName: agentName.toLowerCase(),
      instanceId,
      podId,
      type: 'chat.mention',
      payload: {
        messageId: message?._id || message?.id
          ? String(message?._id || message?.id)
          : undefined,
        content: framedContent,
        userId,
        username,
        mentions: [mentionHandle],
        source: 'dm',
        messageType: message?.messageType || message?.message_type || 'text',
        createdAt: message?.createdAt || message?.created_at || new Date(),
        dmPodId: String(podId),
        dmKind,
        installationPodId,
        availablePods: (availablePods || []).map((entry) => ({
          podId: String(entry?._id || ''),
          name: entry?.name || null,
          type: entry?.type || null,
        })),
      },
    });
    enqueued.push(agentName);
  }

  return { enqueued, skipped: [] };
};

export {
  extractMentions,
  enqueueMentions,
  enqueueDmEvent,
  MENTION_ALIASES,
  isAutoRoutedDmPod,
  // Exported so the ADR-024 D1 board fan-out (taskEventService.notifyPodAgents)
  // gates on the SAME opt-in rather than reimplementing the predicate. The
  // config shape is a Mongoose Map on some paths and a plain object on others,
  // which is exactly the kind of detail a second copy gets subtly wrong.
  wakeOnMessageEnabled,
  boardWakeEnabled,
};
