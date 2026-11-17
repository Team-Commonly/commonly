/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * A first pod read point for a member who has none (first minute back, #4150).
 * Read points start empty, so without this nobody's first return after #4150
 * shipped shows "New since your last visit". The seed is the best signal we
 * already hold:
 *
 * 1. the later of their thread read point in this pod and their last message
 *    in this pod, since both show they were here;
 * 2. else their account's last-active time;
 * 3. else nothing, and the pod opens at its end as before.
 *
 * Never later than now. It only fills an empty slot: a real read point, earlier
 * or later, is never moved, so running it twice changes nothing.
 *
 * Last-active is only a signal from the one-off script. `touchLastActive` moves
 * it on the request that opens the pod, so read on that GET it says "now".
 */
const PodReadPoint = require('../models/pg/PodReadPoint');

interface SeedSignals {
  threadReadAt?: unknown;
  lastMessageAt?: unknown;
  lastActive?: unknown;
}

const asDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

export function chooseSeed(signals: SeedSignals, now: Date): Date | null {
  const inPod = [asDate(signals.threadReadAt), asDate(signals.lastMessageAt)]
    .filter((d): d is Date => d !== null);
  const seed = inPod.length
    ? new Date(Math.max(...inPod.map((d) => d.getTime())))
    : asDate(signals.lastActive);
  if (!seed) return null;
  return seed.getTime() > now.getTime() ? new Date(now.getTime()) : seed;
}

/**
 * Seed one member's read point in one pod if it has none. Returns the stored
 * read point afterwards (the real one, if there was one), or null.
 */
export async function seedPodReadPoint({
  podId, userId, lastActive = null, now = new Date(),
}: { podId: string; userId: string; lastActive?: unknown; now?: Date }): Promise<string | null> {
  const existing = await PodReadPoint.get(podId, userId);
  if (existing) return existing;
  const activity = await PodReadPoint.activityIn(podId, userId);
  const seed = chooseSeed({ ...activity, lastActive }, now);
  if (!seed) return null;
  return PodReadPoint.seedIfAbsent(podId, userId, seed);
}

interface SeedRunCounts {
  members: number;
  existing: number;
  fromPod: number;
  fromLastActive: number;
  none: number;
}

/**
 * The one-off fill (scripts/seed-pod-read-points.ts): every human member of
 * every pod, with last-active as the fallback the GET path can't use. Dry
 * unless `apply`. Counts only; it never prints who.
 */
export async function seedAllPodReadPoints({
  pods, lastActiveByUser, apply, now = new Date(),
}: {
  pods: Array<{ podId: string; memberIds: string[] }>;
  lastActiveByUser: Map<string, unknown>;
  apply: boolean;
  now?: Date;
}): Promise<SeedRunCounts> {
  const counts: SeedRunCounts = {
    members: 0, existing: 0, fromPod: 0, fromLastActive: 0, none: 0,
  };
  for (const { podId, memberIds } of pods) {
    for (const userId of memberIds) {
      // Agents read pods through the runtime, not the divider.
      if (!lastActiveByUser.has(userId)) continue;
      counts.members += 1;
      // eslint-disable-next-line no-await-in-loop
      if (await PodReadPoint.get(podId, userId)) {
        counts.existing += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const activity = await PodReadPoint.activityIn(podId, userId);
      const fromPod = chooseSeed(activity, now);
      const seed = fromPod || chooseSeed({ lastActive: lastActiveByUser.get(userId) }, now);
      if (!seed) {
        counts.none += 1;
        continue;
      }
      if (fromPod) counts.fromPod += 1; else counts.fromLastActive += 1;
      // eslint-disable-next-line no-await-in-loop
      if (apply) await PodReadPoint.seedIfAbsent(podId, userId, seed);
    }
  }
  return counts;
}
