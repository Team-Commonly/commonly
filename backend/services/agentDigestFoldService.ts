import AgentEvent from '../models/AgentEvent';
import AgentDigestState from '../models/AgentDigestState';

const FOLD_BATCH_SIZE = 100;
export const FOLD_TIME_BUDGET_MS = 10_000;
const LAST_IDS_LIMIT = 8;
const CONVERSATION_LIMIT = 8;

const conversationLabel = (payload?: Record<string, unknown>): string => {
  const thread = Number(payload?.threadRootId);
  if (Number.isInteger(thread) && thread > 0) return `thread ${thread}`;
  const task = payload?.taskId;
  return typeof task === 'string' && /^TASK-\d+$/.test(task) ? task : 'pod conversation';
};

type FoldCandidate = {
  _id: unknown;
  agentName: string;
  instanceId?: string;
  podId: unknown;
  status: string;
  createdAt?: Date;
  payload?: Record<string, unknown>;
};

/**
 * Compact expired ambient events without losing unread state. Marking an
 * event `folding` first excludes a concurrent poll claim. The monotonic
 * per-seat cursor makes a crash after the state update, but before deletion,
 * idempotent on the next GC pass. Each pass processes IDs in ascending order.
 */
export async function foldExpiredDigests(threshold: Date, now: () => number = Date.now): Promise<number> {
  const deadline = now() + FOLD_TIME_BUDGET_MS;
  let folded = 0;
  let afterId: unknown;
  const blockedScopes = new Map<string, { agentName: string; instanceId: string; podId: unknown }>();
  while (now() < deadline) {
    // Page past already inspected IDs, including scopes deferred by another
    // worker. Exclude blocked scopes so a large busy scope cannot fill every
    // subsequent page and starve healthy scopes within this run's budget.
    // eslint-disable-next-line no-await-in-loop
    const candidates = await AgentEvent.find({
      deliveryMode: 'digest', status: { $in: ['pending', 'folding', 'delivered', 'failed'] },
      createdAt: { $lt: threshold },
      ...(afterId ? { _id: { $gt: afterId } } : {}),
      ...(blockedScopes.size ? { $nor: [...blockedScopes.values()] } : {}),
    }).sort({ _id: 1 }).limit(FOLD_BATCH_SIZE).lean() as FoldCandidate[];
    if (!candidates.length) break;
    for (const candidate of candidates) {
      if (now() >= deadline) return folded;
      afterId = candidate._id;
      const id = candidate._id;
      const scope = {
        agentName: candidate.agentName,
        instanceId: candidate.instanceId || 'default',
        podId: candidate.podId,
      };
      const scopeKey = `${scope.agentName}:${scope.instanceId}:${scope.podId}`;
      if (blockedScopes.has(scopeKey)) continue;
      // createdAt and ObjectId order can diverge for an imported row. Never
      // advance this scope's cursor beyond an earlier unread ID, even if that
      // earlier row has not reached the retention horizon yet.
      // eslint-disable-next-line no-await-in-loop
      const olderUnread = await AgentEvent.exists({
        ...scope, deliveryMode: 'digest', status: { $in: ['pending', 'folding', 'delivered', 'failed'] },
        _id: { $lt: id },
      });
      if (olderUnread) {
        blockedScopes.set(scopeKey, scope);
        continue;
      }
      if (candidate.status !== 'folding') {
        // eslint-disable-next-line no-await-in-loop
        const claimed = await AgentEvent.findOneAndUpdate(
          { _id: id, status: candidate.status, deliveryMode: 'digest' },
          { $set: { status: 'folding' } },
          { new: true },
        );
        if (!claimed) {
          // Another GC worker may be folding this oldest row. If we advanced to
          // a later ID first, its cursor would make that older row disappear
          // without ever increasing unreadCount.
          blockedScopes.set(scopeKey, scope);
          continue;
        }
      }
      const idString = String(id);
      const label = conversationLabel(candidate.payload);
      let recorded = false;
      for (let attempt = 0; attempt < 5 && !recorded; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const state = await AgentDigestState.findOne(scope)
          .select('foldedThroughId unreadCount conversations otherCount').lean();
        const cursor = state?.foldedThroughId;
        if (cursor && String(cursor) >= idString) {
          recorded = true;
          break;
        }
        if (!state) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await AgentDigestState.create({
              ...scope, unreadCount: 1, revision: 1, lastEventIds: [idString],
              conversations: [{ label, count: 1 }], otherCount: 0,
              unreadSince: candidate.createdAt || new Date(), foldedThroughId: id,
            });
            recorded = true;
          } catch (err) {
            if ((err as { code?: number }).code !== 11000) throw err;
          }
        } else {
          const conversations = [...(state.conversations || [])].map((item) => ({
            label: item.label, count: item.count,
          }));
          let otherCount = Math.max(state.otherCount || 0,
            state.unreadCount - conversations.reduce((sum, item) => sum + item.count, 0));
          const existing = conversations.find((item) => item.label === label);
          if (existing) existing.count += 1;
          else if (conversations.length < CONVERSATION_LIMIT) conversations.push({ label, count: 1 });
          else otherCount += 1;
          // eslint-disable-next-line no-await-in-loop
          const result = await AgentDigestState.updateOne(
            { ...scope, foldedThroughId: cursor ?? null, unreadCount: state.unreadCount },
            {
              $inc: { unreadCount: 1, revision: 1 },
              $set: {
                foldedThroughId: id,
                conversations,
                otherCount,
                ...(state.unreadCount === 0 ? { unreadSince: candidate.createdAt || new Date() } : {}),
              },
              $push: { lastEventIds: { $each: [idString], $slice: -LAST_IDS_LIMIT } },
            },
          );
          recorded = result.modifiedCount === 1;
        }
      }
      if (!recorded) {
        // Keep this scope's unread order and retry it next pass. A busy seat
        // must not prevent unrelated seats from compacting their old events.
        blockedScopes.set(scopeKey, scope);
        console.warn(`[agent-digest] fold state contention for ${idString}; deferring scope`);
        continue;
      }
      // If this delete fails, the next pass sees `folding` and the cursor avoids
      // incrementing a second time. A delivered/acked event never enters here.
      // eslint-disable-next-line no-await-in-loop
      const result = await AgentEvent.deleteOne({ _id: id, status: 'folding', deliveryMode: 'digest' });
      folded += result.deletedCount || 0;
    }
    if (candidates.length < FOLD_BATCH_SIZE) break;
  }
  return folded;
}

export async function readFoldedDigest(scope: {
  agentName: string; instanceId: string; podId: unknown;
}): Promise<{ unreadCount: number; lastEventIds: string[]; revision: number;
  conversations: Array<{ label: string; count: number }>; otherCount: number } | null> {
  const state = await AgentDigestState.findOne({ ...scope, unreadCount: { $gt: 0 } })
    .select('unreadCount lastEventIds revision conversations otherCount').lean();
  if (!state) return null;
  return {
    unreadCount: state.unreadCount,
    lastEventIds: state.lastEventIds,
    revision: state.revision,
    conversations: state.conversations || [],
    otherCount: Math.max(state.otherCount || 0,
      state.unreadCount - (state.conversations || []).reduce((sum, item) => sum + item.count, 0)),
  };
}

export async function settleFoldedDigest(
  scope: { agentName: string; instanceId: string; podId: unknown },
  revision: number,
): Promise<void> {
  // A newer fold increments revision. In that race leave the old count in place:
  // the next turn may see some IDs twice, but never loses an unseen event.
  await AgentDigestState.updateOne(
    { ...scope, revision },
    { $set: { unreadCount: 0, lastEventIds: [], conversations: [], otherCount: 0, unreadSince: null },
      $inc: { revision: 1 } },
  );
}

export default { foldExpiredDigests, readFoldedDigest, settleFoldedDigest };
