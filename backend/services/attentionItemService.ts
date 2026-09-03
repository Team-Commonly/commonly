// Recipient-owned attention is written beside its authoritative source. It is
// intentionally not rebuilt from message history or task prose at read time.
// There is no historical backfill: facts start materializing when this ships.
// eslint-disable-next-line global-require
const AttentionItem = require('../models/AttentionItem');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');

type SourceType = 'message' | 'approval' | 'decision_request';
type Kind = 'mention' | 'approval' | 'decision';

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
        messageId: payload.messageId,
        threadRootId: payload.threadRootId,
        options: payload.options,
        status: 'open',
      },
    },
    { upsert: true },
  )));
};

export const recordMentionedUsers = async (message: any): Promise<void> => {
  try {
    const podId = message?.podId || message?.pod_id;
    const messageId = message?._id || message?.id;
    if (!podId || messageId === undefined || messageId === null) return;
    const authorId = message?.userId?._id || message?.userId || message?.user_id;
    const content = String(message?.content || message?.text || '');
    const members = await currentHumanMembers(podId);
    const recipients = members.filter((member) => {
      const handle = String(member.username || '').trim();
      if (!handle || String(member._id) === String(authorId)) return false;
      return new RegExp(`(^|[^A-Za-z0-9_-])@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i').test(content);
    });
    if (!recipients.length) return;
    const pod = await Pod.findById(podId).select('name').lean();
    const authorName = message?.username || message?.userId?.username || 'Someone';
    await recordForRecipients(recipients, {
      podId, kind: 'mention' as Kind, sourceType: 'message' as SourceType, sourceId: sourceKey('message', messageId),
      title: `${authorName} mentioned you`, detail: compact(content), podName: pod?.name || 'Pod',
      messageId: String(messageId), threadRootId: String(message?.threadRootId || message?.thread_root_id || messageId),
    });
  } catch (error) {
    console.warn('[attention] mention materialization failed:', (error as Error).message);
  }
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
      title: agentName ? `${agentName} requests approval` : 'Approval requested', detail: compact(approval?.content, 180), podName: pod?.name || 'Pod',
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

export const getOpenQueue = async (recipientUserId: unknown): Promise<{ items: any[]; count: number; composePodId: string | null }> => {
  // Route callers carry a real Mongo id. Returning an empty queue for a bad
  // value keeps malformed/read-only callers from turning a cast error into a
  // 500 and makes the authorization boundary explicit.
  if (!/^[a-f\d]{24}$/i.test(String(recipientUserId))) return { items: [], count: 0, composePodId: null };
  const rows = await AttentionItem.find({ recipientUserId, status: 'open' }).sort({ createdAt: -1 }).limit(80).lean();
  const podIds = [...new Set(rows.map((row: any) => String(row.podId)))];
  const pods = await Pod.find({ _id: { $in: podIds } }).select('_id name createdBy members').lean();
  const allowed = new Map(pods.filter((pod: any) => isCurrentMember(pod, recipientUserId)).map((pod: any) => [String(pod._id), pod]));
  const priority: Record<string, number> = { approval: 0, decision: 1, mention: 2 };
  const valid = rows.filter((row: any) => allowed.has(String(row.podId))).sort((a: any, b: any) => (
    (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9)
    || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ));
  const picked: any[] = [];
  let mentionCount = 0;
  for (const row of valid) {
    if (picked.length >= 12) break;
    if (row.kind === 'mention' && mentionCount >= 8) continue;
    if (row.kind === 'mention') mentionCount += 1;
    picked.push({
      id: String(row.source.id), attentionItemId: String(row._id), kind: row.kind, title: row.title, detail: row.detail || '',
      podId: String(row.podId), podName: (allowed.get(String(row.podId)) as any)?.name || row.podName || 'Pod',
      messageId: row.messageId, threadRootId: row.threadRootId, options: row.options || [], createdAt: row.createdAt,
    });
  }
  return { items: picked, count: valid.length, composePodId: picked.find((row) => row.kind === 'mention')?.podId || null };
};

export const acknowledgeMention = async (recipientUserId: unknown, attentionItemId: string): Promise<{ success: boolean; error?: string }> => {
  if (!/^[a-f\d]{24}$/i.test(String(attentionItemId))) return { success: false, error: 'Invalid attention item' };
  const result = await AttentionItem.updateOne({ _id: attentionItemId, recipientUserId, kind: 'mention', status: 'open' }, { $set: { status: 'resolved', resolvedAt: new Date() } });
  return result.modifiedCount === 1 ? { success: true } : { success: false, error: 'Attention item not found' };
};

export default { recordMentionedUsers, recordApproval, recordDecision, resolve, resolveMany, getOpenQueue, acknowledgeMention };
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { recordMentionedUsers, recordApproval, recordDecision, resolve, resolveMany, getOpenQueue, acknowledgeMention };
