import AgentEvent from '../models/AgentEvent';
import AgentDigestState from '../models/AgentDigestState';

const FOLD_BATCH_SIZE = 100;
const LAST_IDS_LIMIT = 8;

type FoldCandidate = {
  _id: unknown;
  agentName: string;
  instanceId?: string;
  podId: unknown;
  status: string;
};

/**
 * Compact expired ambient events without losing unread state. Marking an
 * event `folding` first excludes a concurrent poll claim. The monotonic
 * per-seat cursor makes a crash after the state update, but before deletion,
 * idempotent on the next GC pass. Each pass processes IDs in ascending order.
 */
export async function foldExpiredDigests(threshold: Date): Promise<number> {
  const candidates = await AgentEvent.find({
    deliveryMode: 'digest', status: { $in: ['pending', 'folding', 'delivered', 'failed'] },
    createdAt: { $lt: threshold },
  }).sort({ _id: 1 }).limit(FOLD_BATCH_SIZE).lean() as FoldCandidate[];
  let folded = 0;
  const blockedScopes = new Set<string>();
  for (const candidate of candidates) {
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
      blockedScopes.add(scopeKey);
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
        blockedScopes.add(scopeKey);
        continue;
      }
    }
    const idString = String(id);
    let recorded = false;
    for (let attempt = 0; attempt < 5 && !recorded; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const state = await AgentDigestState.findOne(scope).select('foldedThroughId').lean();
      const cursor = state?.foldedThroughId;
      if (cursor && String(cursor) >= idString) {
        recorded = true;
        break;
      }
      if (!state) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await AgentDigestState.create({
            ...scope, unreadCount: 1, revision: 1, lastEventIds: [idString], foldedThroughId: id,
          });
          recorded = true;
        } catch (err) {
          if ((err as { code?: number }).code !== 11000) throw err;
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        const result = await AgentDigestState.updateOne(
          { ...scope, foldedThroughId: cursor ?? null },
          {
            $inc: { unreadCount: 1, revision: 1 },
            $set: { foldedThroughId: id },
            $push: { lastEventIds: { $each: [idString], $slice: -LAST_IDS_LIMIT } },
          },
        );
        recorded = result.modifiedCount === 1;
      }
    }
    if (!recorded) throw new Error(`Digest fold state contention for ${idString}`);
    // If this delete fails, the next pass sees `folding` and the cursor avoids
    // incrementing a second time. A delivered/acked event never enters here.
    // eslint-disable-next-line no-await-in-loop
    const result = await AgentEvent.deleteOne({ _id: id, status: 'folding', deliveryMode: 'digest' });
    folded += result.deletedCount || 0;
  }
  return folded;
}

export async function readFoldedDigest(scope: {
  agentName: string; instanceId: string; podId: unknown;
}): Promise<{ unreadCount: number; lastEventIds: string[]; revision: number } | null> {
  const state = await AgentDigestState.findOne({ ...scope, unreadCount: { $gt: 0 } })
    .select('unreadCount lastEventIds revision').lean();
  if (!state) return null;
  return {
    unreadCount: state.unreadCount,
    lastEventIds: state.lastEventIds,
    revision: state.revision,
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
    { $set: { unreadCount: 0, lastEventIds: [] }, $inc: { revision: 1 } },
  );
}

export default { foldExpiredDigests, readFoldedDigest, settleFoldedDigest };
