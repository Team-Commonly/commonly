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

type SourceType = 'message' | 'approval' | 'decision_request' | 'task';
type Kind = 'mention' | 'approval' | 'decision' | 'handoff';
type MentionOptions = {
  isAlreadyAcknowledged?: (recipientUserId: unknown, legacyMentionId: string) => boolean;
};
type TaskAttentionOptions = { includeBlocked?: boolean };

const compact = (value: unknown, max = 220): string => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const sourceKey = (type: SourceType, id: unknown): string => String(id || '').trim();
const isCurrentMember = (pod: any, userId: unknown): boolean => (
  String(pod?.createdBy || '') === String(userId)
  || (pod?.members || []).some((member: any) => String(member?.userId || member?._id || member) === String(userId))
);

const currentHumanMembers = async (podId: unknown): Promise<Array<{ _id: unknown; username?: string }>> => {
  const pod = await Pod.findById(podId).select('_id name createdBy members').lean();
  if (!pod) return [];
  const ids = new Set<string>([String(pod.createdBy || '')]);
  for (const member of (pod.members || [])) {
    const id = (member as any)?.userId || (member as any)?._id || member;
    if (id) ids.add(String(id));
  }
  const users = await User.find({ _id: { $in: [...ids].filter(Boolean) }, isBot: { $ne: true } })
    .select('_id username isBot').lean();
  return users.filter((user: any) => isCurrentMember(pod, user._id));
};

const recordForRecipients = async (
  recipients: Array<{ _id: unknown }>,
  payload: Record<string, unknown>,
): Promise<void> => {
  await Promise.all(recipients.map((recipient) => AttentionItem.updateOne(
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
        messageId: payload.messageId,
        threadRootId: payload.threadRootId,
        options: payload.options,
        sourceCreatedAt: payload.sourceCreatedAt,
        status: 'open',
      },
    },
    { upsert: true },
  )));
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

export const recordMentionedUsers = async (message: any, options: MentionOptions = {}): Promise<void> => {
  try {
    const podId = message?.podId || message?.pod_id;
    const messageId = message?._id || message?.id;
    if (!podId || messageId === undefined || messageId === null) return;
    const authorId = message?.userId?._id || message?.userId || message?.user_id;
    const content = String(message?.content || message?.text || '');
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
    const pod = await Pod.findById(podId).select('name').lean();
    // PG rows arrive with user_id only, so 'Someone' was what every live
    // mention showed. Resolve the author the way chat renders them.
    const authorName = message?.username || message?.userId?.username || await resolveAuthorName(authorId);
    await recordForRecipients(recipients, {
      podId, kind: 'mention' as Kind, sourceType: 'message' as SourceType, sourceId: sourceKey('message', messageId),
      title: `${authorName} mentioned you`, actorName: authorName, detail: compact(content), podName: pod?.name || 'Pod',
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

export const recordApproval = async (approval: any): Promise<void> => {
  try {
    const podId = approval?.podId;
    const id = approval?._id || approval?.id;
    if (!podId || !id) return;
    const recipients = await currentHumanMembers(podId);
    const pod = await Pod.findById(podId).select('name').lean();
    const agentName = approval?.agentMetadata?.agentName;
    await recordForRecipients(recipients, {
      podId, kind: 'approval' as Kind, sourceType: 'approval' as SourceType, sourceId: sourceKey('approval', id),
      title: agentName ? `${agentName} requests approval` : 'Approval requested', actorName: agentName || undefined, detail: compact(approval?.content, 180), podName: pod?.name || 'Pod',
    });
  } catch (error) {
    console.warn('[attention] approval materialization failed:', (error as Error).message);
  }
};

export const recordDecision = async (decision: any): Promise<void> => {
  try {
    const podId = decision?.podId;
    const id = decision?._id || decision?.id;
    if (!podId || !id) return;
    const recipients = await currentHumanMembers(podId);
    const pod = await Pod.findById(podId).select('name').lean();
    const options = (decision.options || []).filter((option: any) => option?.label).map((option: any) => ({
      label: String(option.label), ...(option.description ? { description: String(option.description) } : {}),
      ...(option.recommended ? { recommended: true } : {}),
    }));
    await recordForRecipients(recipients, {
      podId, kind: 'decision' as Kind, sourceType: 'decision_request' as SourceType, sourceId: sourceKey('decision_request', id),
      title: String(decision.title || 'Decision requested'), detail: compact(decision.question || decision.context, 1000),
      podName: pod?.name || 'Pod', messageId: decision.messageId ? String(decision.messageId) : undefined,
      threadRootId: String(decision.threadRootId || decision.messageId || ''), options,
    });
  } catch (error) {
    console.warn('[attention] decision materialization failed:', (error as Error).message);
  }
};

// A task may be ordinary board history, or it may state a concrete blocked /
// handoff fact. Capture only the latter at the write boundary; no reader
// should parse arbitrary historic task prose into a queue card.
export const TASK_HANDOFF_RE = /human\s+(merge\s+)?press|ready for (the\s+)?(human|sam)|sam'?s?\s+(ruling|call|decision)|awaiting\s+(sam|human)/i;

export const recordTaskAttention = async (task: any, options: TaskAttentionOptions = {}): Promise<void> => {
  try {
    const last = Array.isArray(task?.updates) ? task.updates[task.updates.length - 1] : null;
    const blocked = task?.status === 'blocked';
    const handoff = Boolean(last && TASK_HANDOFF_RE.test(String(last.text || '')));
    if (!task?.podId || (!handoff && !(options.includeBlocked && blocked))) return;
    const recipients = await currentHumanMembers(task.podId);
    const pod = await Pod.findById(task.podId).select('name').lean();
    const taskKey = String(task._id || task.taskId);
    const sequence = String(last?._id || last?.createdAt?.getTime?.() || task.updatedAt?.getTime?.() || taskKey);
    await recordForRecipients(recipients, {
      podId: task.podId, kind: 'handoff' as Kind, sourceType: 'task' as SourceType,
      sourceId: `${taskKey}:${sequence}`,
      title: String(task.title || 'Task needs attention'), detail: compact(last?.text || task.notes, 220),
      podName: pod?.name || 'Pod',
    });
  } catch (error) {
    console.warn('[attention] task materialization failed:', (error as Error).message);
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

interface OpenQueueOptions {
  podId?: unknown;
  limit?: number;
  offset?: number;
}

export const getOpenQueue = async (recipientUserId: unknown, options: OpenQueueOptions = {}): Promise<{
  items: any[];
  count: number;
  countsByPod: Record<string, number>;
  countsByKind: Record<string, number>;
  composePodId: string | null;
  offset: number;
  limit: number;
  remaining: number;
  hasMore: boolean;
}> => {
  const requestedPodId = typeof options.podId === 'string' ? options.podId.trim() : '';
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit as number, 1), 50) : 50;
  const offset = Number.isInteger(options.offset) ? Math.max(options.offset as number, 0) : 0;
  // Route callers carry a real Mongo id. Returning an empty queue for a bad
  // value keeps malformed/read-only callers from turning a cast error into a
  // 500 and makes the authorization boundary explicit.
  if (!/^[a-f\d]{24}$/i.test(String(recipientUserId))) {
    return { items: [], count: 0, countsByPod: {}, countsByKind: {}, composePodId: null, offset, limit, remaining: 0, hasMore: false };
  }
  // Counts include every accessible open item. The selected pod scope is
  // applied before pagination so a scoped list cannot show a positive count
  // with zero rows merely because its rows fell beyond the global page.
  const rows = await AttentionItem.find({ recipientUserId, status: 'open' }).sort({ createdAt: -1 }).lean();
  const podIds = [...new Set(rows.map((row: any) => String(row.podId)))];
  const pods = await Pod.find({ _id: { $in: podIds } }).select('_id name createdBy members').lean();
  const allowed = new Map(pods.filter((pod: any) => isCurrentMember(pod, recipientUserId)).map((pod: any) => [String(pod._id), pod]));
  const priority: Record<string, number> = { approval: 0, decision: 1, handoff: 1, mention: 2 };
  const renderKind = (row: any): Kind => (
    row.kind === 'decision' && row.source?.type === 'task' ? 'handoff' : row.kind
  );
  const valid = rows.filter((row: any) => allowed.has(String(row.podId))).sort((a: any, b: any) => (
    (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9)
    || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ));
  const countsByPod = valid.reduce((counts: Record<string, number>, row: any) => {
    const podId = String(row.podId);
    counts[podId] = (counts[podId] || 0) + 1;
    return counts;
  }, {});
  const countsByKind = valid.reduce((counts: Record<string, number>, row: any) => {
    const kind = renderKind(row);
    counts[kind] = (counts[kind] || 0) + 1;
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
  const page = scoped.slice(offset, offset + limit);
  const picked: any[] = [];
  for (const row of page) {
    picked.push({
      id: String(row.source.id), attentionItemId: String(row._id), kind: renderKind(row), title: row.title, actorName: row.actorName || undefined, detail: row.detail || '',
      podId: String(row.podId), podName: (allowed.get(String(row.podId)) as any)?.name || row.podName || 'Pod',
      messageId: row.messageId, threadRootId: row.threadRootId, options: row.options || [], createdAt: row.createdAt,
    });
  }
  const remaining = Math.max(scoped.length - offset - picked.length, 0);
  return {
    items: picked,
    count: scoped.length,
    countsByPod,
    countsByKind,
    composePodId,
    offset,
    limit,
    remaining,
    hasMore: remaining > 0,
  };
};

export const acknowledgeAttention = async (recipientUserId: unknown, attentionItemId: string): Promise<{ success: boolean; error?: string }> => {
  if (!/^[a-f\d]{24}$/i.test(String(attentionItemId))) return { success: false, error: 'Invalid attention item' };
  const result = await AttentionItem.updateOne(
    {
      _id: attentionItemId,
      recipientUserId,
      status: 'open',
      $or: [
        { kind: 'mention' },
        { kind: 'handoff' },
        { kind: 'decision', 'source.type': 'task' },
      ],
    },
    { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'acknowledged' } },
  );
  return result.modifiedCount === 1 ? { success: true } : { success: false, error: 'Attention item not found' };
};

// Kept as the public name for the existing Activity route. The selector is
// now deliberately recipient-owned and covers mentions plus handoffs while
// excluding true decisions and approvals.
export const acknowledgeMention = acknowledgeAttention;

export default { recordMentionedUsers, resolveMentionAttentionForReply, sweepResolvedMentionAttention, recordApproval, recordDecision, recordTaskAttention, resolveTaskAttention, resolve, resolveMany, getOpenQueue, acknowledgeAttention, acknowledgeMention };
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { recordMentionedUsers, resolveMentionAttentionForReply, sweepResolvedMentionAttention, recordApproval, recordDecision, recordTaskAttention, resolveTaskAttention, resolve, resolveMany, getOpenQueue, acknowledgeAttention, acknowledgeMention, TASK_HANDOFF_RE };
