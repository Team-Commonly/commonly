/**
 * In-flight guard for vector-index rebuilds (F616).
 *
 * A reset that lands in the middle of a running rebuild wipes half of it, and
 * every rebuild spends embedding calls.
 *
 * The lock is per process: it serializes rebuilds within one backend process,
 * which covers prod's default single-backend VM. With more than one API
 * process (dev's 2 replicas, the VM `two-workers` profile) a request landing
 * on another process is not blocked, and a shared lock (Mongo or Redis) is
 * needed then.
 */
const podsRebuilding = new Set<string>();
const usersRebuildingAll = new Set<string>();

const key = (id: unknown): string => String(id);

/** Take a pod's lock. Returns a release function, or null when it is held. */
export const acquirePod = (podId: unknown): (() => void) | null => {
  const k = key(podId);
  if (podsRebuilding.has(k)) return null;
  podsRebuilding.add(k);
  return () => { podsRebuilding.delete(k); };
};

/** Take a user's rebuild-all lock. Returns a release function, or null when held. */
export const acquireUserAll = (userId: unknown): (() => void) | null => {
  const k = key(userId);
  if (usersRebuildingAll.has(k)) return null;
  usersRebuildingAll.add(k);
  return () => { usersRebuildingAll.delete(k); };
};

export const IN_PROGRESS_CODE = 'index_rebuild_in_progress';
