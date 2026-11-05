// F183: best-effort PG mirror writes for Mongo-first paths.
//
// Mongo is the source of truth for pods, membership and users; PG `pods`,
// `pod_members` and `users` are mirrors the PG chat listings read. Several
// Mongo writes (pod rename, join, leave) never reached the mirror, and the
// drift they left (860 rows on 2026-11-05) is what the nightly
// pgMirrorRepairService now repairs. These helpers close the known bypasses at
// the source.
//
// Contract: call AFTER the Mongo write has succeeded. Never throws — a PG
// failure is logged and returned as `false`, and the request answers from
// Mongo as before. Nothing reads these rows for a permission decision (see
// pgMessageController.deleteMessage and podWriteAccessService), so a missed
// mirror write costs freshness until the nightly repair, never access.

const pgConfigured = (): boolean => Boolean(process.env.PG_HOST);

// Lazy: callers load this module whether or not PG is configured, and the PG
// model pulls in the pool at require time.
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const pgPod = () => require('../models/pg/Pod');

const attempt = async (label: string, write: () => Promise<unknown>): Promise<boolean> => {
  if (!pgConfigured()) return true;
  try {
    await write();
    return true;
  } catch (error) {
    console.warn(`[pg-mirror] ${label} failed:`, (error as Error)?.message || String(error));
    return false;
  }
};

/** A user joined a pod in Mongo. Backfills the whole pod when PG has no row for it. */
export const mirrorMemberAdded = (podId: string, userId: string): Promise<boolean> => attempt(
  `member add pod=${podId} user=${userId}`,
  async () => {
    const PGPod = pgPod();
    if (await PGPod.findById(podId)) {
      await PGPod.addMember(podId, userId);
      return;
    }
    // No PG pod yet: a bare pod_members insert would fail its FK. The sync
    // copies the pod and every Mongo member, the joiner included.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { syncPodFromMongo } = require('./pgPodSyncService');
    await syncPodFromMongo(podId, userId);
  },
);

/**
 * A pod was created in Mongo by a path that does not write PG itself. Copies
 * the pod (owner from Mongo `createdBy`) and its members; a no-op when the PG
 * row already exists. Without this the pod stayed out of PG until its first
 * PG message, and every nightly diff counted it as missing.
 */
export const mirrorPodCreated = (podId: string): Promise<boolean> => attempt(
  `pod create pod=${podId}`,
  async () => {
    if (await pgPod().findById(podId)) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { syncPodFromMongo } = require('./pgPodSyncService');
    // The second argument is only a fallback owner for a Mongo row with no
    // createdBy; syncPodFromMongo always prefers Mongo's owner.
    await syncPodFromMongo(podId, '');
  },
);

/**
 * A User was created (or relabelled) in Mongo. Writes PG `users` through
 * AgentIdentityService.syncUserToPostgreSQL, the one sync every user path
 * shares, so the row carries the chat label (`chatUsernameFor`), picture and
 * is_bot exactly as the rest of the mirror does. Without this a new account
 * or agent reached PG only on its first post or page load.
 */
export const mirrorUser = (user: { _id: { toString(): string } }): Promise<boolean> => attempt(
  `user sync user=${String(user?._id)}`,
  async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const AgentIdentityService = require('./agentIdentityService');
    if (!(await AgentIdentityService.syncUserToPostgreSQL(user))) {
      throw new Error('syncUserToPostgreSQL returned false');
    }
  },
);

/** A user left (or was removed from) a pod in Mongo. */
export const mirrorMemberRemoved = (podId: string, userId: string): Promise<boolean> => attempt(
  `member remove pod=${podId} user=${userId}`,
  () => pgPod().removeMember(podId, userId),
);

/** A pod was renamed in Mongo. `PGPod.update` writes name and description together. */
export const mirrorPodRenamed = (
  podId: string,
  name: string,
  description: string,
): Promise<boolean> => attempt(
  `rename pod=${podId}`,
  () => pgPod().update(podId, name, description || ''),
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  mirrorMemberAdded, mirrorMemberRemoved, mirrorPodRenamed, mirrorPodCreated, mirrorUser,
};
