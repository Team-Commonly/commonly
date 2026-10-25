import Cursor from '../models/AgentPodReadCursor';

export type ReadWatermark = { readAt: Date; readRevision?: number };

const cursorId = (agentUserId: unknown, podId: unknown): string => `${String(agentUserId)}:${String(podId)}`;

/** Plain watermark or null. No Mongoose queries/documents escape this module. */
export async function getReadWatermark(agentUserId: unknown, podId: unknown): Promise<ReadWatermark | null> {
  const row = await Cursor.findOne({ _id: cursorId(agentUserId, podId) })
    .select('readAt readRevision').lean();
  if (!row) return null;
  return { readAt: row.readAt, ...(row.readRevision === undefined ? {} : { readRevision: row.readRevision }) };
}

/** Independent maxima preserve the existing timestamp/revision fence. */
export async function advanceReadWatermark(
  agentUserId: unknown, podId: unknown, watermark: ReadWatermark,
): Promise<void> {
  const filter = { _id: cursorId(agentUserId, podId) };
  const maximum = {
    readAt: watermark.readAt,
    ...(watermark.readRevision === undefined ? {} : { readRevision: watermark.readRevision }),
  };
  try {
    await Cursor.updateOne(filter, { $max: maximum, $setOnInsert: { agentUserId, podId } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    // Two first reads can race on the deterministic _id. Retry without an
    // upsert so the loser advances the winner without rolling it backwards.
    await Cursor.updateOne(filter, { $max: maximum });
  }
}
