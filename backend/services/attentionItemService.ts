// Recipient-owned attention is written beside its authoritative source. It is
// intentionally not rebuilt from message history or task prose at read time.
// A one-time direct-source backfill materializes facts that predate adoption.
// eslint-disable-next-line global-require
const AttentionItem = require('../models/AttentionItem');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Message = require('../models/Message');
// eslint-disable-next-line global-require
const PGMessage = require('../models/pg/Message');
const Task = require('../models/Task');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const { sendNeedsYouEmail } = require('./needsYouEmailService');
// eslint-disable-next-line global-require
const { ESCALATION_MARKERS } = require('./connectorRelayPolicy');
// eslint-disable-next-line global-require
const { humansAnsweredBy } = require('./agentAnswerService');
// eslint-disable-next-line global-require
const { isListedPodMember } = require('../utils/isPodMember');

type SourceType = 'message' | 'approval' | 'approval_action' | 'decision_request' | 'task' | 'initiative';
type Kind = 'mention' | 'approval' | 'decision' | 'handoff' | 'blocked';
type MentionOptions = {
  isAlreadyAcknowledged?: (recipientUserId: unknown, legacyMentionId: string) => boolean;
  suppressEmail?: boolean;
};
type TaskAttentionOptions = { includeBlocked?: boolean; suppressEmail?: boolean };
type RecordOptions = { suppressEmail?: boolean };

const compact = (value: unknown, max = 220): string => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const sourceKey = (type: SourceType, id: unknown): string => String(id || '').trim();
// Membership is Pod.members and nothing else (isListedPodMember, TASK-161/170):
// createdBy keeps a departed creator's id after leavePod, so counting it gave
// that person "waiting on you" rows from a pod they can no longer open.
const currentHumanMembers = async (podId: unknown): Promise<Array<{ _id: unknown; username?: string }>> => {
  const pod = await Pod.findById(podId).select('_id name members').lean();
  if (!pod) return [];
  const ids = (pod.members || []).map((member: any) => String(member?._id || member)).filter(Boolean);
  const users = await User.find({ _id: { $in: ids }, isBot: { $ne: true } })
    .select('_id username isBot').lean();
  return users.filter((user: any) => isListedPodMember(pod, user._id));
};

const installerForAgent = async (
  agentUserId: unknown, podId: unknown, declaredName?: unknown, declaredInstanceId?: unknown,
): Promise<string | null> => {
  try {
    const agent = agentUserId
      ? await User.findById(agentUserId).select('isBot username botMetadata').lean() : null;
    const name = String(declaredName || (agent?.isBot && (agent.botMetadata?.agentName || agent.username)) || '').toLowerCase();
    if (name) {
      const instanceId = String(declaredInstanceId || agent?.botMetadata?.instanceId || 'default');
      const installation = await AgentInstallation.findOne({
        podId, agentName: name, instanceId, status: { $ne: 'uninstalled' },
      }).select('installedBy').lean();
      if (installation?.installedBy) return String(installation.installedBy);
    }
    return agent?.isBot && agent.botMetadata?.ownerUserId
      ? String(agent.botMetadata.ownerUserId) : null;
  } catch (error) {
    // The attention row still matters if its optional email owner cannot be
    // resolved. Never send to the pod creator as a fallback.
    console.warn('[attention] email owner lookup failed:', (error as Error).message);
    return null;
  }
};

const recordForRecipients = async (
  recipients: Array<{ _id: unknown }>,
  payload: Record<string, unknown>,
): Promise<void> => {
  await Promise.all(recipients.map(async (recipient) => {
    const result = await AttentionItem.updateOne(
      { recipientUserId: recipient._id, 'source.type': payload.sourceType, 'source.id': payload.sourceId },
      {
        $setOnInsert: {
          recipientUserId: recipient._id,
          podId: payload.podId,
          kind: payload.kind,
          source: { type: payload.sourceType, id: payload.sourceId },
          title: payload.title,
          detail: payload.detail,
          podName: payload.podName,
          actorName: payload.actorName,
          actorUserId: payload.actorUserId,
          messageId: payload.messageId,
          threadRootId: payload.threadRootId,
          options: payload.options,
          sourceCreatedAt: payload.sourceCreatedAt,
          status: 'open',
        },
      },
      { upsert: true },
    );
    // Only the authoritative first insert can email. A retry, a backfill, or
    // another member's copy of the same ask cannot send a second alert.
    if (result?.upsertedId && !payload.suppressEmail && payload.kind !== 'mention'
      && String(payload.emailRecipientId || '') === String(recipient._id)) {
      await sendNeedsYouEmail({
        _id: result.upsertedId, recipientUserId: recipient._id,
        title: String(payload.title || ''), detail: String(payload.detail || ''),
        podName: String(payload.podName || ''), actorName: String(payload.actorName || ''),
      });
    }
  }));
};

const resolveAuthorName = async (authorId: unknown): Promise<string> => {
  if (!authorId) return 'Someone';
  try {
    const author = await User.findById(authorId).select('username botMetadata').lean();
    return author?.botMetadata?.displayName || author?.username || 'Someone';
  } catch {
    return 'Someone';
  }
};

/**
 * The people an agent's message is ANSWERING (stickiness Phase 1b; shape ruled
 * by ux-lead, Sharpen 78222-78224, 2026-10-16). An answer you asked for is not
 * waiting on you: you see it where you asked. So it opens no needs-you row;
 * the message and its @mention stay. Before this, almost every agent-mention
 * row was bulk-acknowledged or left open, and well under 1% was answered.
 *
 * Who counts as answered is agentAnswerService's rule, shared with the
 * onboarding checklist. Asks still reach them: decisions and approvals have
 * their own writers, and an answer that carries an escalation marker
 * ([BLOCKED] ...) is not treated as an answer. Any failure reads as
 * "answering nobody": an extra row beats a lost ask.
 */
const peopleThisAgentIsAnswering = async (
  message: any,
  authorId: unknown,
  content: string,
  podId: unknown,
): Promise<Set<string>> => {
  if (!authorId || ESCALATION_MARKERS.test(content)) return new Set<string>();
  try {
    const author = await User.findById(authorId).select('isBot username botMetadata').lean();
    if (!author?.isBot) return new Set<string>();
    return await humansAnsweredBy({
      podId,
      agentName: String(author.botMetadata?.agentName || author.username || ''),
      instanceId: String(author.botMetadata?.instanceId || 'default'),
      replyToMessageId: message?.reply_to_message_id ?? message?.replyToMessageId,
      // Carried from the post, never stored on the row (agentAnswerService).
      // Only the PG write carries it: the Mongo fallback's post-save hook
      // (models/Message.ts) passes the document, so with PG down an unclaimed
      // addressed answer still opens a row. That fails toward showing an ask.
      answeringMessageId: message?.answeringMessageId,
    });
  } catch (error) {
    console.warn('[attention] answer check failed; recording the mention:', (error as Error).message);
    return new Set<string>();
  }
};

export const recordMentionedUsers = async (message: any, options: MentionOptions = {}): Promise<void> => {
  try {
    const podId = message?.podId || message?.pod_id;
    const messageId = message?._id || message?.id;
    if (!podId || messageId === undefined || messageId === null) return;
    const authorId = message?.userId?._id || message?.userId || message?.user_id;
    const content = String(message?.content || message?.text || '');
    if (/^\s*\[BLOCKED\]/i.test(content)) {
      try {
        const installerId = await installerForAgent(authorId, podId);
        if (installerId) {
          const members = await currentHumanMembers(podId);
          const installer = members.find((member) => String(member._id) === installerId);
          if (installer) {
            const pod = await Pod.findById(podId).select('name').lean();
            const actorName = await resolveAuthorName(authorId);
            await recordForRecipients([installer], {
              podId, kind: 'blocked' as Kind, sourceType: 'message' as SourceType,
              sourceId: sourceKey('message', messageId),
              title: `${actorName} is blocked`, detail: compact(content),
              actorName, actorUserId: authorId, podName: pod?.name || 'Pod',
              messageId: String(messageId),
              threadRootId: String(message?.threadRootId || message?.thread_root_id || messageId),
              sourceCreatedAt: message?.createdAt || message?.created_at || undefined,
              emailRecipientId: installerId, suppressEmail: options.suppressEmail,
            });
          }
        }
      } catch (error) {
        // A failing ownership lookup must not hide an explicit @mention.
        console.warn('[attention] blocked-message materialization failed:', (error as Error).message);
      }
    }
    // Message delivery invokes this writer for every post. Avoid two Mongo
    // reads on the common no-mention path; every valid @mention contains this
    // sentinel, so the guard cannot hide a recipient.
    if (!content.includes('@')) return;
    const members = await currentHumanMembers(podId);
    const recipients = members.filter((member) => {
      const handle = String(member.username || '').trim();
      if (!handle || String(member._id) === String(authorId)) return false;
      if (options.isAlreadyAcknowledged?.(member._id, 'msg_' + String(messageId))) return false;
      return new RegExp(`(^|[^A-Za-z0-9_-])@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i').test(content);
    });
    if (!recipients.length) return;
    const answering = await peopleThisAgentIsAnswering(message, authorId, content, podId);
    const waitingOn = recipients.filter((member) => !answering.has(String(member._id)));
    if (!waitingOn.length) return;
    const pod = await Pod.findById(podId).select('name').lean();
    // PG rows arrive with user_id only, so 'Someone' was what every live
    // mention showed. Resolve the author the way chat renders them.
    const authorName = message?.username || message?.userId?.username || await resolveAuthorName(authorId);
    await recordForRecipients(waitingOn, {
      podId, kind: 'mention' as Kind, sourceType: 'message' as SourceType, sourceId: sourceKey('message', messageId),
      title: `${authorName} mentioned you`, actorName: authorName, actorUserId: authorId || undefined, detail: compact(content), podName: pod?.name || 'Pod',
      messageId: String(messageId), threadRootId: String(message?.threadRootId || message?.thread_root_id || messageId),
      sourceCreatedAt: message?.createdAt || message?.created_at || undefined,
    });
  } catch (error) {
    console.warn('[attention] mention materialization failed:', (error as Error).message);
  }
};

const validDate = (value: unknown): Date | null => {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Sam's 2026-09-06 ruling: only a later post in the mention's thread or an
 * explicit reply to its message is a reply. An unrelated pod post is not.
 */
export const resolveMentionAttentionForReply = async ({
  recipientUserId,
  podId,
  repliedAt,
  threadRootId,
  replyToMessageId,
}: {
  recipientUserId: unknown;
  podId: unknown;
  repliedAt: unknown;
  threadRootId?: unknown;
  replyToMessageId?: unknown;
}): Promise<number> => {
  const at = validDate(repliedAt);
  if (!recipientUserId || !podId || !at) return 0;
  const targets: Record<string, unknown>[] = [];
  if (threadRootId) targets.push({ threadRootId: String(threadRootId) });
  if (replyToMessageId) targets.push({ messageId: String(replyToMessageId) });
  // Also avoids a Mongo round-trip on ordinary, unthreaded chat writes.
  if (!targets.length) return 0;
  try {
    const result = await AttentionItem.updateMany(
      {
        recipientUserId,
        podId,
        kind: 'mention',
        status: 'open',
        $and: [{ $or: targets }],
        // sourceCreatedAt is written on all new rows. The createdAt fallback
        // gives the one-shot sweep's legacy population an honest temporary
        // path until it is examined against its source message.
        $or: [
          { sourceCreatedAt: { $lt: at } },
          { sourceCreatedAt: { $exists: false }, createdAt: { $lt: at } },
        ],
      },
      { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'replied' } },
    );
    return Number(result.modifiedCount || 0);
  } catch (error) {
    // A message post is authoritative even if this recipient projection is
    // unavailable. Leave the row open rather than failing the chat write.
    console.warn('[attention] reply resolution storage failed; leaving item visible:', (error as Error).message);
    return 0;
  }
};

const sourceTimeForMention = async (row: any): Promise<Date | null> => {
  const stored = validDate(row?.sourceCreatedAt);
  if (stored) return stored;
  const sourceId = String(row?.source?.id || '');
  if (!sourceId) return null;
  if (/^\d+$/.test(sourceId)) {
    const message = await PGMessage.findById(sourceId);
    return validDate(message?.createdAt);
  }
  const message = await Message.findById(sourceId).select('createdAt').lean();
  return validDate(message?.createdAt);
};

const recipientRepliedAfterMention = async (row: any, sourceCreatedAt: Date): Promise<boolean> => {
  const sourceId = String(row?.source?.id || '');
  if (/^\d+$/.test(sourceId)) {
    return PGMessage.hasReplyByUserAfter(
      String(row.podId),
      String(row.recipientUserId),
      sourceCreatedAt,
      { messageId: row.messageId || sourceId, threadRootId: row.threadRootId },
    );
  }
  // Mongo fallback messages have no persisted reply/thread edges. There is
  // no evidence of a reply to use here; explicit acknowledgement still works.
  return false;
};

/**
 * One-shot repair for mentions created before reply-resolution existed. It
 * reads each source directly, resolves only rows whose recipient actually
 * replied later in the same thread or to the source message, and records the
 * same `replied` stamp as the live write path. Call from the explicit
 * maintenance script; retries are
 * safe because only still-open rows are updated.
 */
export const sweepResolvedMentionAttention = async ({ apply = false }: { apply?: boolean } = {}) => {
  const rows = await AttentionItem.find({ kind: 'mention', status: 'open' })
    .sort({ createdAt: 1 }).lean();
  let eligible = 0;
  let resolved = 0;
  let unavailable = 0;
  for (const row of rows) {
    try {
      const sourceCreatedAt = await sourceTimeForMention(row);
      if (!sourceCreatedAt || !await recipientRepliedAfterMention(row, sourceCreatedAt)) continue;
      eligible += 1;
      if (!apply) continue;
      // The condition is repeated at write time so a concurrent explicit
      // acknowledgement cannot be overwritten with the wrong resolution.
      const result = await AttentionItem.updateOne(
        { _id: row._id, kind: 'mention', status: 'open' },
        {
          $set: {
            status: 'resolved',
            resolvedAt: new Date(),
            resolvedBy: 'replied',
            ...(row.sourceCreatedAt ? {} : { sourceCreatedAt }),
          },
        },
      );
      resolved += Number(result.modifiedCount || 0);
    } catch (error) {
      unavailable += 1;
      console.warn('[attention] mention sweep skipped an unreadable source:', (error as Error).message);
    }
  }
  return { scanned: rows.length, eligible, resolved, unavailable };
};

/**
 * A thread reply is the only reply (Sam, 2026-09-06), so an agent's mention
 * nobody answers in its thread stays open for good. Seats post status and gate
 * notes that name a person, and the 2026-10-20 audit found one founder's queue
 * holding 113 of them, the oldest five weeks old. After
 * AGENT_MENTION_MISSED_DAYS without a reply, such a row leaves the needs-you
 * queue as `missed`: resolved, never counted as acted on, kept in the store,
 * and its message still in the pod.
 *
 * Only an agent's mention expires this way. A person's mention, a decision, an
 * approval and a handoff stay until answered: the person waiting on them is
 * real. A row with no recorded actor is left alone, since it can't be shown to
 * be an agent's.
 */
export const AGENT_MENTION_MISSED_DAYS = 7;

export const sweepMissedAgentMentions = async (
  { now = new Date(), apply = true }: { now?: Date; apply?: boolean } = {},
) => {
  const cutoff = new Date(now.getTime() - AGENT_MENTION_MISSED_DAYS * 24 * 60 * 60 * 1000);
  const rows = await AttentionItem.find({
    kind: 'mention',
    status: 'open',
    actorUserId: { $exists: true, $ne: null },
    $or: [
      { sourceCreatedAt: { $lt: cutoff } },
      { sourceCreatedAt: { $exists: false }, createdAt: { $lt: cutoff } },
    ],
  }).select('_id actorUserId').lean();
  if (!rows.length) return { scanned: 0, eligible: 0, missed: 0 };
  const actorIds = [...new Set((rows as any[]).map((row) => String(row.actorUserId || '')).filter(Boolean))];
  const bots = await User.find({ _id: { $in: actorIds }, isBot: true }).select('_id').lean();
  const botIds = new Set((bots as any[]).map((bot) => String(bot._id)));
  const ids = (rows as any[]).filter((row) => botIds.has(String(row.actorUserId || ''))).map((row) => row._id);
  if (!apply || !ids.length) return { scanned: rows.length, eligible: ids.length, missed: 0 };
  // Still open at write time: a reply or an acknowledgement that lands during
  // the sweep keeps its own resolution.
  const result = await AttentionItem.updateMany(
    { _id: { $in: ids }, kind: 'mention', status: 'open' },
    { $set: { status: 'resolved', resolvedAt: now, resolvedBy: 'missed' } },
  );
  return { scanned: rows.length, eligible: ids.length, missed: Number(result.modifiedCount || 0) };
};

export const recordApproval = async (approval: any, options: RecordOptions = {}): Promise<void> => {
  try {
    const podId = approval?.podId;
    const id = approval?._id || approval?.id;
    if (!podId || !id) return;
    const recipients = await currentHumanMembers(podId);
    const pod = await Pod.findById(podId).select('name').lean();
    const agentName = approval?.agentMetadata?.agentName;
    const emailRecipientId = await installerForAgent(
      approval?.agentUserId, podId, agentName,
    );
    await recordForRecipients(recipients, {
      podId, kind: 'approval' as Kind, sourceType: 'approval' as SourceType, sourceId: sourceKey('approval', id),
      title: agentName ? `${agentName} requests approval` : 'Approval requested', actorName: agentName || undefined,
      // The approval writer has no agent user id of its own today; take the
      // requester when the source carries one, else leave it unset.
      actorUserId: approval?.approval?.requestedBy || approval?.agentUserId || approval?.actorId || undefined,
      detail: compact(approval?.content, 180), podName: pod?.name || 'Pod',
      emailRecipientId, suppressEmail: options.suppressEmail,
    });
  } catch (error) {
    console.warn('[attention] approval materialization failed:', (error as Error).message);
  }
};

// An agent's action proposal (approvalActionService, the runtime `propose-action`
// path) is an ask like any other: it rings, counts and badges in the inbox
// (ux-lead ruling on #1650). It is its own source type because it resolves
// through /api/approvals/:id/resolve, not the Activity approve/reject verbs —
// the page branches on `sourceType`, never on a guess about the id.
export const recordActionApproval = async (row: any, displayName?: string | null, options: RecordOptions = {}): Promise<void> => {
  try {
    const podId = row?.podId;
    const id = row?._id || row?.id;
    if (!podId || !id) return;
    // Only the owner can decide an action proposal (resolveApproval 403s
    // anyone else), so only the owner is asked — a member whose Approve would
    // fail must not carry it on their badge (sprint-review on #1652).
    const owner = row?.ownerUserId ? String(row.ownerUserId) : '';
    const members = await currentHumanMembers(podId);
    const recipients = members.filter((member: any) => String(member?._id ?? member) === owner);
    if (!recipients.length) return;
    const pod = await Pod.findById(podId).select('name').lean();
    const label = String(displayName || row?.agentName || '').trim();
    await recordForRecipients(recipients, {
      podId, kind: 'approval' as Kind, sourceType: 'approval_action' as SourceType, sourceId: sourceKey('approval_action', id),
      title: label ? `${label} requests approval` : 'Approval requested', actorName: label || undefined,
      actorUserId: row?.agentUserId ? String(row.agentUserId) : undefined,
      detail: compact(row?.summary, 180), podName: pod?.name || 'Pod',
      emailRecipientId: owner, suppressEmail: options.suppressEmail,
    });
  } catch (error) {
    console.warn('[attention] action-approval materialization failed:', (error as Error).message);
  }
};

export const recordDecision = async (decision: any, options: RecordOptions = {}): Promise<void> => {
  try {
    const podId = decision?.podId;
    const id = decision?._id || decision?.id;
    if (!podId || !id) return;
    const recipients = await currentHumanMembers(podId);
    const pod = await Pod.findById(podId).select('name').lean();
    const emailRecipientId = await installerForAgent(decision.agentUserId, podId, decision.agentName, decision.instanceId);
    const choiceOptions = (decision.options || []).filter((option: any) => option?.label).map((option: any) => ({
      label: String(option.label), ...(option.description ? { description: String(option.description) } : {}),
      ...(option.recommended ? { recommended: true } : {}),
    }));
    await recordForRecipients(recipients, {
      podId, kind: 'decision' as Kind, sourceType: 'decision_request' as SourceType, sourceId: sourceKey('decision_request', id),
      title: String(decision.title || 'Decision requested'), detail: compact(decision.question || decision.context, 1000),
      actorName: decision.agentName || undefined, actorUserId: decision.agentUserId || undefined,
      podName: pod?.name || 'Pod', messageId: decision.messageId ? String(decision.messageId) : undefined,
      threadRootId: String(decision.threadRootId || decision.messageId || ''), options: choiceOptions,
      emailRecipientId, suppressEmail: options.suppressEmail,
    });
  } catch (error) {
    console.warn('[attention] decision materialization failed:', (error as Error).message);
  }
};

// A task may be ordinary board history, or it may state a concrete blocked /
// handoff fact. Capture only the latter at the write boundary; no reader
// should parse arbitrary historic task prose into a queue card.
//
// A handoff ASKS for someone: "awaiting", "waiting on/for", "ready for" or
// "needs", followed by "the human" or the username of one of the pod's own
// human members, or "human (merge) press". A report of a ruling already made
// ("X's ruling, 10-19: ...") asks nothing, and no instance's names live here:
// the previous pattern spelled one person's name, and one report beginning
// "Sam's ruling" opened 40 rows across a pod's four humans (2026-10-19).
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HANDOFF_LEAD = String.raw`(?:awaiting|waiting\s+(?:on|for)|ready\s+for|needs?)`;
const HUMAN_PRESS_RE = /\bhuman\s+(?:merge\s+)?press\b/i;
const ASKS_A_HUMAN_RE = new RegExp(String.raw`\b${HANDOFF_LEAD}\s+(?:the\s+|a\s+)?human\b`, 'i');
// Cheap gate before any member lookup, and the backfill's Mongo prefilter.
// Every text isHandoffRequest accepts matches it.
export const TASK_HANDOFF_CANDIDATE_RE = /human|awaiting|waiting\s+(?:on|for)|ready\s+for|\bneeds?\b/i;

const named = (text: string, username: string): boolean => Boolean(username)
  && new RegExp(String.raw`(^|[^A-Za-z0-9_-])@?${escapeRegExp(username)}(?![A-Za-z0-9_-])`, 'i').test(text);

export const isHandoffRequest = (text: string, memberUsernames: string[] = []): boolean => {
  const value = String(text || '');
  if (HUMAN_PRESS_RE.test(value) || ASKS_A_HUMAN_RE.test(value)) return true;
  const names = memberUsernames.map((name) => String(name || '').trim()).filter(Boolean).map(escapeRegExp);
  if (!names.length) return false;
  return new RegExp(String.raw`\b${HANDOFF_LEAD}\s+@?(?:${names.join('|')})(?![A-Za-z0-9_-])`, 'i').test(value);
};

// Who a blocked or handoff card goes to: the human members the update names
// (@handle or username), otherwise the pod's creator. Paging every member made
// each status flip in a shared work pod a card for every human in it. If the
// creator has left, the card goes to the current members rather than to nobody.
export const handoffRecipients = <T extends { _id: unknown; username?: string }>(
  members: T[], text: string, createdBy: unknown,
): T[] => {
  const mentioned = members.filter((member) => named(String(text || ''), String(member.username || '')));
  if (mentioned.length) return mentioned;
  const creator = members.filter((member) => String(member._id) === String(createdBy || ''));
  return creator.length ? creator : members;
};

export const recordTaskAttention = async (task: any, options: TaskAttentionOptions = {}): Promise<void> => {
  try {
    const last = Array.isArray(task?.updates) ? task.updates[task.updates.length - 1] : null;
    const blocked = task?.status === 'blocked';
    const text = String(last?.text || '');
    const mightAsk = Boolean(last) && TASK_HANDOFF_CANDIDATE_RE.test(text);
    if (!task?.podId || (!mightAsk && !(options.includeBlocked && blocked))) return;
    const members = await currentHumanMembers(task.podId);
    const handoff = mightAsk && isHandoffRequest(text, members.map((member) => String(member.username || '')));
    if (!handoff && !(options.includeBlocked && blocked)) return;
    const pod = await Pod.findById(task.podId).select('name createdBy').lean();
    const namedRecipient = members.find((member) => String(member.username || '').toLowerCase() === String(task.assignee || '').toLowerCase())
      || members.find((member) => named(text, String(member.username || '')));
    const emailRecipientId = namedRecipient
      ? String(namedRecipient._id)
      : await installerForAgent(last?.authorId, task.podId);
    const installerRecipient = members.find((member) => String(member._id) === emailRecipientId);
    const recipients = namedRecipient ? [namedRecipient]
      : installerRecipient ? [installerRecipient] : handoffRecipients(members, text, pod?.createdBy);
    const taskKey = String(task._id || task.taskId);
    const sequence = String(last?._id || last?.createdAt?.getTime?.() || task.updatedAt?.getTime?.() || taskKey);
    await recordForRecipients(recipients, {
      podId: task.podId, kind: (blocked ? 'blocked' : 'handoff') as Kind, sourceType: 'task' as SourceType,
      sourceId: `${taskKey}:${sequence}`,
      title: String(task.title || 'Task needs attention'), detail: compact(last?.text || task.notes, 220),
      podName: pod?.name || 'Pod',
      emailRecipientId, suppressEmail: options.suppressEmail,
    });
  } catch (error) {
    console.warn('[attention] task materialization failed:', (error as Error).message);
  }
};

// Initiative v1 design (#2788) §4: one nudge per stall
// episode. The episode start is part of the source id, so every run inside one
// episode upserts onto the same row and the next episode opens a new one. The
// row goes to one current human member of the pod: the owner when the owner is
// a person, otherwise the agent's installer. No agent is woken. The unique
// index includes the recipient, so an owner change mid-episode would open a
// second card; the episode's existing row, to anyone, is checked first.
const INITIATIVE_STALL = 'stall';
export const initiativeStallSourceId = (initiativeId: unknown, episodeStart: Date): string => (
  `initiative:${String(initiativeId)}:${INITIATIVE_STALL}:${episodeStart.toISOString()}`
);

export const recordInitiativeStall = async (stall: {
  initiativeId: unknown; title: string; podId: unknown; episodeStart: Date;
  ownerUserId?: unknown; ownerAgentUserId?: unknown;
}, options: RecordOptions = {}): Promise<{ recipientUserId: string | null; failed?: true }> => {
  try {
    const { podId } = stall;
    if (!podId || !stall.initiativeId) return { recipientUserId: null };
    const sourceId = initiativeStallSourceId(stall.initiativeId, stall.episodeStart);
    const existing = await AttentionItem.findOne({ 'source.type': 'initiative', 'source.id': sourceId })
      .select('recipientUserId').lean();
    if (existing) return { recipientUserId: String(existing.recipientUserId) };
    const target = stall.ownerUserId ? String(stall.ownerUserId)
      : stall.ownerAgentUserId ? await installerForAgent(stall.ownerAgentUserId, podId) : null;
    if (!target) return { recipientUserId: null };
    const recipient = (await currentHumanMembers(podId)).find((member) => String(member._id) === target);
    if (!recipient) return { recipientUserId: null };
    const pod = await Pod.findById(podId).select('name').lean();
    await recordForRecipients([recipient], {
      podId, kind: 'blocked' as Kind, sourceType: 'initiative' as SourceType,
      sourceId,
      title: `Stalled: ${compact(stall.title, 200)}`,
      detail: `No merge or ruling since ${stall.episodeStart.toISOString().slice(0, 10)}.`,
      podName: pod?.name || 'Pod', emailRecipientId: target, suppressEmail: options.suppressEmail,
    });
    return { recipientUserId: target };
  } catch (error) {
    console.warn('[attention] initiative stall materialization failed:', (error as Error).message);
    return { recipientUserId: null, failed: true };
  }
};

// Closes this initiative's open stall rows, except the current episode's. A
// card for a stall that has ended would otherwise sit in the queue forever.
export const resolveInitiativeStalls = async (initiativeId: unknown, keepSourceId?: string): Promise<void> => {
  const prefix = escapeRegExp(`initiative:${String(initiativeId)}:${INITIATIVE_STALL}:`);
  try {
    await AttentionItem.updateMany(
      {
        'source.type': 'initiative',
        'source.id': keepSourceId ? { $regex: `^${prefix}`, $ne: keepSourceId } : { $regex: `^${prefix}` },
        status: 'open',
      },
      { $set: { status: 'resolved', resolvedAt: new Date() } },
    );
  } catch (error) {
    console.warn('[attention] initiative stall resolution failed; leaving items visible:', (error as Error).message);
  }
};

export const resolveTaskAttention = async (task: any): Promise<void> => {
  const taskKey = String(task?._id || task?.taskId || '').trim();
  if (!taskKey) return;
  try {
    const escaped = taskKey.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
    await AttentionItem.updateMany(
      { 'source.type': 'task', 'source.id': { $regex: new RegExp('^' + escaped + ':') }, status: 'open' },
      { $set: { status: 'resolved', resolvedAt: new Date() } },
    );
  } catch (error) {
    console.warn('[attention] task resolution storage failed; leaving item visible:', (error as Error).message);
  }
};

/**
 * One-shot repair for handoff cards whose task finished without telling the
 * attention store (the complete route never called resolveTaskAttention until
 * 2026-09-19). Reads each open handoff's task by the id prefix of its source
 * key; resolves only those whose task is `done`. A task that no longer exists
 * is counted as missing and left alone. Dry run unless `apply`.
 */
export const sweepDoneTaskHandoffs = async ({ apply = false }: { apply?: boolean } = {}) => {
  const rows = await AttentionItem.find({ kind: 'handoff', 'source.type': 'task', status: 'open' })
    .sort({ createdAt: 1 }).lean();
  // The source key's prefix is `task._id || task.taskId`, so a row may carry a
  // `TASK-134`-style key. Feeding that to `_id` throws a CastError and would
  // abort the whole run; look each shape up by its own field.
  const keys: string[] = [...new Set<string>((rows as any[]).map((row: any) => String(row.source?.id || '').split(':')[0]).filter(Boolean))];
  const objectIds = keys.filter((key) => /^[0-9a-f]{24}$/i.test(key));
  const taskKeys = keys.filter((key) => !/^[0-9a-f]{24}$/i.test(key));
  const clauses = [
    ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ...(taskKeys.length ? [{ taskId: { $in: taskKeys } }] : []),
  ];
  const tasks = clauses.length ? await Task.find({ $or: clauses }).select('status taskId').lean() : [];
  const statusById = new Map<string, string>();
  for (const task of tasks as any[]) {
    statusById.set(String(task._id), task.status);
    if (task.taskId) statusById.set(String(task.taskId), task.status);
  }
  const eligibleIds: unknown[] = [];
  let missing = 0;
  for (const row of rows as any[]) {
    const taskId = String(row.source?.id || '').split(':')[0];
    const status = statusById.get(taskId);
    if (status === undefined) { missing += 1; continue; }
    if (status === 'done') eligibleIds.push(row._id);
  }
  let resolved = 0;
  if (apply && eligibleIds.length) {
    const result = await AttentionItem.updateMany(
      { _id: { $in: eligibleIds }, kind: 'handoff', status: 'open' },
      { $set: { status: 'resolved', resolvedAt: new Date() } },
    );
    resolved = Number(result.modifiedCount || 0);
  }
  return { scanned: rows.length, eligible: eligibleIds.length, resolved, missing, apply };
};

/**
 * Close a source's open rows as `actioned`: the recipient did what the row
 * asked, somewhere other than its thread. Used only where that action is
 * observable, today the stalled-connect nudge, whose ask ("start me") is met
 * when the agent first connects. Growth counts `actioned` as acted on.
 */
export const resolveActioned = async (sourceType: SourceType, sourceId: unknown): Promise<void> => {
  const id = sourceKey(sourceType, sourceId);
  if (!id) return;
  try {
    await AttentionItem.updateMany(
      { 'source.type': sourceType, 'source.id': id, status: 'open' },
      { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'actioned' } },
    );
  } catch (error) {
    console.warn('[attention] actioned resolution failed; leaving item visible:', (error as Error).message);
  }
};

export const resolve = async (sourceType: SourceType, sourceId: unknown): Promise<void> => {
  const id = sourceKey(sourceType, sourceId);
  if (!id) return;
  try {
    await AttentionItem.updateMany({ 'source.type': sourceType, 'source.id': id, status: 'open' }, { $set: { status: 'resolved', resolvedAt: new Date() } });
  } catch (error) {
    // The owning source already completed. Leave stale attention visible over
    // returning a false failure from a completed source action.
    console.warn('[attention] resolution storage failed; leaving item visible:', (error as Error).message);
  }
};

export const resolveMany = async (sourceType: SourceType, sourceIds: unknown[]): Promise<void> => {
  const ids = sourceIds.map((id) => sourceKey(sourceType, id)).filter(Boolean);
  if (!ids.length) return;
  try {
    await AttentionItem.updateMany({ 'source.type': sourceType, 'source.id': { $in: ids }, status: 'open' }, { $set: { status: 'resolved', resolvedAt: new Date() } });
  } catch (error) {
    console.warn('[attention] bulk resolution storage failed; leaving items visible:', (error as Error).message);
  }
};

// `${podId}:${messageId}` keys for messages that already have a decision row
// for this recipient — in ANY state, not only open. A decision card born from a
// message carries that message's id, and the mention row for the same message
// is the same ask to the same person, so it is not a second item.
const decisionBackedMessages = async (recipientUserId: unknown, rows: any[]): Promise<Set<string>> => {
  const messageIds = [...new Set(rows
    .filter((row: any) => row.kind === 'mention' && row.messageId)
    .map((row: any) => String(row.messageId)))];
  if (!messageIds.length) return new Set();
  const decisions = await AttentionItem.find({ recipientUserId, kind: 'decision', messageId: { $in: messageIds } })
    .select('podId messageId').lean();
  return new Set(decisions
    .filter((row: any) => row.messageId)
    .map((row: any) => `${String(row.podId)}:${String(row.messageId)}`));
};

interface OpenQueueOptions {
  podId?: unknown;
  messageIds?: unknown;
  limit?: number;
  offset?: number;
  since?: unknown;
}

export const getOpenQueue = async (recipientUserId: unknown, options: OpenQueueOptions = {}): Promise<{
  items: any[];
  count: number;
  countsByPod: Record<string, number>;
  countsByKind: Record<string, number>;
  composePodId: string | null;
  windowCount: number;
  nextSince: string | null;
  offset: number;
  limit: number;
  remaining: number;
  hasMore: boolean;
}> => {
  const requestedPodId = typeof options.podId === 'string' ? options.podId.trim() : '';
  const hasMessageFilter = Array.isArray(options.messageIds);
  const messageIds = hasMessageFilter
    ? [...new Set((options.messageIds as unknown[]).map((id) => String(id).trim()).filter(Boolean))]
    : [];
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit as number, 1), 50) : 50;
  const offset = Number.isInteger(options.offset) ? Math.max(options.offset as number, 0) : 0;
  // `since` opens a WINDOW: work created AT OR AFTER an instant. It is what makes
  // a watcher tick one request instead of a full-queue paging loop (`/api/activity`
  // is 60 requests a minute per client IP, shared with every session on the host
  // and with the person's own Activity page).
  //
  // The counts below do NOT narrow with it. `count`, `countsByKind`, `countsByPod`
  // and `composePodId` describe the whole open set, exactly as they did before this
  // parameter existed, so an Activity badge or any caller that passes no bound sees
  // no change; a bounded call gets `windowCount` for the window. `offset`/`limit`/
  // `remaining`/`hasMore` page WITHIN the window, which is the only reading of
  // "pagination" that can terminate: rows outside the window are never delivered,
  // so a page count that included them could never be worked off.
  //
  // The comparison is INCLUSIVE. A caller's cursor is a bare timestamp, and one
  // sitting at millisecond T cannot know about a row INSERTED at T after it was
  // written — an exclusive bound would drop that row from that read and from every
  // later read, silently and permanently. Re-delivering a row the caller already
  // has is the recoverable direction, and callers dedupe on `attentionItemId`.
  //
  // `createdAt` is stamped by mongoose at insert, from the model's own `now`, and
  // no writer in this codebase sets it (the source's own time lives in
  // `sourceCreatedAt`), so it orders rows by when they were STAMPED. That is what
  // makes the existing `find().sort({ createdAt: -1 })` cheap on the
  // `{recipientUserId, status, createdAt}` index. This bound never touches that
  // index: the whole-set counts above require the whole open set, so the window is
  // applied in memory below, after the read. What it cuts is the size of the
  // response and the number of round trips (the watcher tick that motivated it
  // went from eleven requests to one), not the database work.
  //
  // Stamp order is NOT commit order, and that is where the residual lives — not in
  // backdating alone. A row stamped before a cursor can become visible after it
  // (its write had not committed when the caller read), and a writer whose clock
  // lags stamps a new row behind a cursor the caller already advanced past; this
  // bound misses both. Only a caller-side lookback W closes them, and W has to
  // exceed write-commit latency PLUS writer clock offset — an earlier revision of
  // this comment said "not skew", and that was wrong. So the bound is a narrowing,
  // not a guarantee: a caller that must not miss a row re-reads from
  // `nextSince - W` and dedupes on `attentionItemId`.
  //
  // A value that cannot be parsed narrows nothing rather than raising: the route
  // refuses it with a 400 first, so this is the second line, and of the two ways
  // to be wrong here, returning a superset is the one that cannot hide a row.
  // (`podId` above already treats a malformed scope the same way.)
  const since = options.since instanceof Date
    ? options.since
    : (typeof options.since === 'string' && options.since.trim() ? new Date(options.since) : null);
  const sinceAt = since && Number.isFinite(since.getTime()) ? since : null;
  // Route callers carry a real Mongo id. Returning an empty queue for a bad
  // value keeps malformed/read-only callers from turning a cast error into a
  // 500 and makes the authorization boundary explicit.
  if (!/^[a-f\d]{24}$/i.test(String(recipientUserId))) {
    return {
      items: [], count: 0, countsByPod: {}, countsByKind: {}, composePodId: null,
      windowCount: 0, nextSince: null, offset, limit, remaining: 0, hasMore: false,
    };
  }
  // Counts include every accessible open item. The selected pod scope is
  // applied before pagination so a scoped list cannot show a positive count
  // with zero rows merely because its rows fell beyond the global page.
  const rows = await AttentionItem.find({
    recipientUserId,
    status: 'open',
    ...(hasMessageFilter ? { messageId: { $in: messageIds } } : {}),
  }).sort({ createdAt: -1 }).lean();
  // Suppressed before anything is counted, so every number the caller reads —
  // per-pod, per-kind, total, remaining — counts rows the person can actually
  // see, in every scope. Keyed on a decision row existing in any state: hiding
  // only while the decision is open would surface the leftover mention the
  // moment the decision is answered, i.e. the duplicate arriving in two acts.
  // The decision row is that message's one presentation for good.
  const superseded = await decisionBackedMessages(recipientUserId, rows);
  const visible = superseded.size
    ? rows.filter((row: any) => !(row.kind === 'mention'
        && row.messageId && superseded.has(`${String(row.podId)}:${String(row.messageId)}`)))
    : rows;
  const podIds = [...new Set(visible.map((row: any) => String(row.podId)))];
  const pods = await Pod.find({ _id: { $in: podIds } }).select('_id name members').lean();
  const allowed = new Map(pods.filter((pod: any) => isListedPodMember(pod, recipientUserId)).map((pod: any) => [String(pod._id), pod]));
  const priority: Record<string, number> = { approval: 0, decision: 1, handoff: 1, blocked: 1, mention: 2 };
  const renderKind = (row: any): Kind => (
    row.kind === 'decision' && row.source?.type === 'task' ? 'handoff' : row.kind
  );
  const valid = visible.filter((row: any) => allowed.has(String(row.podId))).sort((a: any, b: any) => (
    (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9)
    || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ));
  const countsByPod = valid.reduce((counts: Record<string, number>, row: any) => {
    const podId = String(row.podId);
    counts[podId] = (counts[podId] || 0) + 1;
    return counts;
  }, {});
  // The composer target is an account-level fact, not a property of the
  // rendered page. A priority-heavy first page can contain no mentions even
  // while an accessible mention exists later in the global ordering.
  const composeMention = valid.find((row: any) => row.kind === 'mention');
  const composePodId = composeMention?.podId ? String(composeMention.podId) : null;
  const scoped = requestedPodId
    ? valid.filter((row: any) => String(row.podId) === requestedPodId)
    : valid;
  // Per-kind totals describe the requested view, but are calculated before
  // pagination. Legacy task rows are projected through renderKind so their
  // handoff bucket agrees with the card and acknowledgement semantics.
  const countsByKind = scoped.reduce((counts: Record<string, number>, row: any) => {
    const kind = renderKind(row);
    counts[kind] = (counts[kind] || 0) + 1;
    return counts;
  }, {});
  // The window is applied AFTER the whole-set counts and BEFORE the slice, so
  // the counts keep their meaning and the page is drawn from the window.
  const window = sinceAt
    ? scoped.filter((row: any) => new Date(row.createdAt).getTime() >= sinceAt.getTime())
    : scoped;
  const page = window.slice(offset, offset + limit);
  const picked: any[] = [];
  for (const row of page) {
    picked.push({
      id: String(row.source.id), attentionItemId: String(row._id), kind: renderKind(row), sourceType: row.source.type, title: row.title, actorName: row.actorName || undefined, actorUserId: row.actorUserId ? String(row.actorUserId) : undefined, detail: row.detail || '',
      podId: String(row.podId), podName: (allowed.get(String(row.podId)) as any)?.name || row.podName || 'Pod',
      messageId: row.messageId, threadRootId: row.threadRootId, options: row.options || [], createdAt: row.createdAt,
    });
  }
  const remaining = Math.max(window.length - offset - picked.length, 0);
  // The newest instant actually DELIVERED, so a caller can resume from it. It is
  // the max over the page rather than over the window: a value the caller has not
  // seen must not be skipped past.
  const nextSince = picked.length
    ? new Date(Math.max(...picked.map((row: any) => new Date(row.createdAt).getTime()))).toISOString()
    : null;
  return {
    items: picked,
    count: scoped.length,
    countsByPod,
    countsByKind,
    composePodId,
    windowCount: window.length,
    nextSince,
    offset,
    limit,
    remaining,
    hasMore: remaining > 0,
  };
};

export const acknowledgeAttention = async (recipientUserId: unknown, attentionItemId: string): Promise<{ success: boolean; error?: string }> => {
  if (!/^[a-f\d]{24}$/i.test(String(attentionItemId))) return { success: false, error: 'Invalid attention item' };
  // Same guard `getOpenQueue` already carries (`:466`), for the same reason and
  // one more. A recipient id that is not an ObjectId does not reach the update
  // as "no recipient": it is cast on the way in and throws a CastError, which
  // the route reports as a 500 'Failed to acknowledge attention'. A malformed
  // caller id is a client-side fact, so it belongs in the 400 lane beside the
  // item-id refusal, not in an unhandled throw.
  //
  // The cross-recipient read this was first proposed for is NOT what happens:
  // measured on `bbab5c31`, `recipientUserId: undefined` and `null` are refused
  // ('Attention item not found') and the other recipient's row stays open, while
  // `''` and `'not-an-id'` throw. Refuse both shapes here rather than rely on the
  // filter's behaviour for one of them.
  if (!/^[a-f\d]{24}$/i.test(String(recipientUserId))) return { success: false, error: 'Invalid recipient' };
  const result = await AttentionItem.updateOne(
    {
      _id: attentionItemId,
      recipientUserId,
      status: 'open',
      $or: [
        { kind: 'mention' },
        { kind: 'handoff' },
        { kind: 'blocked' },
        { kind: 'decision', 'source.type': 'task' },
      ],
    },
    { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'acknowledged' } },
  );
  return result.modifiedCount === 1 ? { success: true } : { success: false, error: 'Attention item not found' };
};

/**
 * Whether this recipient has ever had an attention item, regardless of its
 * current status. Resolved rows are retained deliberately, so this answers
 * the Activity day-zero question without reconstructing history from source
 * stores (or imposing a retention window).
 */
export const hasEverHadAttention = async (recipientUserId: unknown): Promise<boolean> => {
  if (!recipientUserId) return false;
  const row = await AttentionItem.exists({ recipientUserId });
  return Boolean(row);
};

// Kept as the public name for the existing Activity route. The selector is
// now deliberately recipient-owned and covers mentions plus handoffs while
// excluding true decisions and approvals.
export const acknowledgeMention = acknowledgeAttention;

export default { recordMentionedUsers, resolveMentionAttentionForReply, sweepResolvedMentionAttention, sweepMissedAgentMentions, sweepDoneTaskHandoffs, recordApproval, recordActionApproval, recordDecision, recordTaskAttention, resolveTaskAttention, recordInitiativeStall, resolveInitiativeStalls, initiativeStallSourceId, resolve, resolveActioned, resolveMany, getOpenQueue, hasEverHadAttention, acknowledgeAttention, acknowledgeMention };
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { recordMentionedUsers, resolveMentionAttentionForReply, sweepResolvedMentionAttention, sweepMissedAgentMentions, AGENT_MENTION_MISSED_DAYS, sweepDoneTaskHandoffs, recordApproval, recordActionApproval, recordDecision, recordTaskAttention, resolveTaskAttention, recordInitiativeStall, resolveInitiativeStalls, initiativeStallSourceId, resolve, resolveActioned, resolveMany, getOpenQueue, hasEverHadAttention, acknowledgeAttention, acknowledgeMention, TASK_HANDOFF_CANDIDATE_RE, isHandoffRequest, handoffRecipients };
