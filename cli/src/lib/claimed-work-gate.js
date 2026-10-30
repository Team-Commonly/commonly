// Defer-while-claimed (TASK-640). While a seat holds a claimed board row in a
// pod, a broadcast wake there that no person sent and that does not concern
// its row is acked without a spawn. Measured on one seat, 2026-10-30: most of
// its hourly wake-mode turns were pod broadcasts while it held one row, and
// most of those ended in NO_REPLY.
//
// Mentions, DMs, human posts, heartbeats and digests are never deferred, and
// neither is a broadcast about a row the seat holds. Every failure fails OPEN:
// a kernel that does not mark `claimedByMe`, or a board read that errors,
// means nothing is deferred.

export const CLAIMED_WORK_TTL_MS = 60_000;

// Pure: may this waking event wait while the seat holds `claimedTaskIds`?
// `trigger` is classifyTrigger's verdict for the event.
export const isDeferrableWhileClaimed = (event, trigger, claimedTaskIds) => {
  if (!event || event.deliveryMode === 'digest') return false;
  if (event.type !== 'message.posted') return false;
  const payload = event.payload || {};
  if (payload.addressed === true || payload.repliesToYourMessage === true) return false;
  if (trigger !== 'agent' && trigger !== 'kernel') return false;
  if (payload.taskId && claimedTaskIds?.has(String(payload.taskId))) return false;
  return true;
};

export const createClaimedWorkGate = ({ client, ttlMs = CLAIMED_WORK_TTL_MS, now = () => Date.now() } = {}) => {
  const cache = new Map();

  // The ids of this seat's claimed rows in `podId`, or null when it holds none
  // or the board cannot say.
  const claimedTaskIds = async (podId) => {
    if (!client || !podId) return null;
    const cached = cache.get(podId);
    if (cached && now() - cached.at < ttlMs) return cached.ids;
    let ids = null;
    try {
      const { tasks = [] } = await client.get(`/api/v1/tasks/${podId}`, { status: 'claimed' });
      // A lapsed lease still carries claimedBy; only a live one holds the seat.
      const mine = tasks.filter((task) => task?.claimedByMe === true && task?.leaseState === 'held')
        .map((task) => String(task.taskId));
      ids = mine.length > 0 ? new Set(mine) : null;
    } catch {
      ids = null;
    }
    cache.set(podId, { at: now(), ids });
    return ids;
  };

  // True when every waking event in the group may wait. An empty group is
  // never deferred.
  const shouldDefer = async (podId, wakes) => {
    if (!Array.isArray(wakes) || wakes.length === 0) return false;
    // Only read the board when the group could be deferred at all.
    if (!wakes.every(({ event, trigger }) => isDeferrableWhileClaimed(event, trigger, null))) return false;
    const ids = await claimedTaskIds(podId);
    if (!ids) return false;
    return wakes.every(({ event, trigger }) => isDeferrableWhileClaimed(event, trigger, ids));
  };

  return { shouldDefer };
};
