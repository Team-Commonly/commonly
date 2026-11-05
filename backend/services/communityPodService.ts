import Pod from '../models/Pod';

let missingConfigLogged = false;

export const getCommunityPodId = (): string | null => {
  const podId = String(process.env.COMMUNITY_POD_ID || '').trim();
  return podId || null;
};

/**
 * Best-effort membership projection for the instance community Pod.
 *
 * This is intentionally only a Mongo Pod.members write: it does not install
 * agents, emit notifications, or enter the first-contact path. `$addToSet`
 * makes repeated verification/OAuth callbacks idempotent.
 */
export const ensureUserInCommunityPod = async (userId: unknown): Promise<void> => {
  const podId = getCommunityPodId();
  if (!podId) {
    if (!missingConfigLogged) {
      missingConfigLogged = true;
      console.warn('[community-pod] COMMUNITY_POD_ID is unset; automatic membership is disabled.');
    }
    return;
  }

  try {
    const result = await Pod.updateOne(
      { _id: podId },
      { $addToSet: { members: userId } },
    );
    if (result.matchedCount === 0) {
      console.warn('[community-pod] configured Pod was not found; automatic membership skipped.');
    } else if (result.modifiedCount > 0) {
      // F183: best-effort PG mirror write; never fails the signup.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      await require('./pgMirrorWrite').mirrorMemberAdded(String(podId), String(userId));
    }
  } catch (err) {
    console.warn('[community-pod] membership update failed:', (err as Error).message);
  }
};
