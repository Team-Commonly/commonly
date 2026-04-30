// Lazy backfill helper that syncs a Mongo pod row into PG on first
// PG-touching operation. Mirrors what pgMessageController has been doing
// inline since the dual-DB split — extracted here so messageController
// can use the same path. Without this, a pod created via the Mongo-only
// path (POST /api/pods → podController) is missing from PG, and any
// PGMessage.create against it fails the messages.pod_id FK, dropping
// the message into the Mongo fallback path indefinitely.
//
// Why a service instead of a util: the function reaches into both PG
// (PGPod.create + addMember) and Mongo (Pod.findById), so it lives at
// the service tier rather than as a pure helper.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PGPod = require('../models/pg/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MongoPod = require('../models/Pod');

interface MongoPodLean {
  name?: string;
  description?: string;
  type?: string;
  members?: Array<{ toString(): string }>;
}

/**
 * Backfill a single Mongo pod into PG. Idempotent in spirit (caller should
 * have already checked PGPod.findById and missed); if PGPod.create races
 * with another caller it surfaces as a unique-key error and the caller
 * gets to handle it.
 *
 * Returns the PG row on success, null when the Mongo pod itself is
 * missing (caller should treat this like 404).
 */
export async function syncPodFromMongo(
  podId: string,
  requestingUserId: string,
): Promise<unknown> {
  const mongoPod = await MongoPod.findById(podId).lean() as MongoPodLean | null;
  if (!mongoPod) return null;
  const pod = await PGPod.create(
    mongoPod.name,
    mongoPod.description || '',
    mongoPod.type || 'chat',
    requestingUserId,
    podId,
  );
  if (Array.isArray(mongoPod.members)) {
    await Promise.allSettled(
      mongoPod.members.map((m) => PGPod.addMember(podId, m.toString())),
    );
  }
  return pod;
}

// CJS compat: let `const { syncPodFromMongo } = require('...')` work
// alongside the named ESM export above. Without this dual export the
// dual-DB messageController (which uses CJS require()) can't pick up
// the named export from the compiled .js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { syncPodFromMongo };
module.exports.syncPodFromMongo = syncPodFromMongo;
