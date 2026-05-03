export type PodGroup = 'Pinned' | 'Today' | 'Yesterday' | 'This week' | 'Earlier';

export interface GroupableItem {
  _id: string;
  updatedAt?: string | Date;
  createdAt?: string | Date;
  // Optional. When present, beats updatedAt/createdAt for both bucketing and
  // intra-bucket sort — pods must reorder when a chat message arrives even if
  // the backend hasn't touched updatedAt for that write.
  lastMessage?: { createdAt?: string | Date | null } | null;
}

const effectiveTs = (item: GroupableItem): number => {
  const raw = item.lastMessage?.createdAt || item.updatedAt || item.createdAt;
  if (!raw) return 0;
  const ts = new Date(raw).getTime();
  return Number.isNaN(ts) ? 0 : ts;
};

const GROUP_ORDER: PodGroup[] = ['Pinned', 'Today', 'Yesterday', 'This week', 'Earlier'];

const startOfDay = (d: Date): number => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
};

export const groupForTimestamp = (raw: string | Date | undefined): PodGroup => {
  if (!raw) return 'Earlier';
  const ts = new Date(raw).getTime();
  if (Number.isNaN(ts)) return 'Earlier';
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = today - 24 * 60 * 60 * 1000;
  const weekAgo = today - 7 * 24 * 60 * 60 * 1000;

  if (ts >= today) return 'Today';
  if (ts >= yesterday) return 'Yesterday';
  if (ts >= weekAgo) return 'This week';
  return 'Earlier';
};

export const groupPods = <T extends GroupableItem>(
  items: T[],
  pinnedIds: Set<string>,
): Array<{ label: PodGroup; items: T[] }> => {
  const buckets: Record<PodGroup, T[]> = {
    Pinned: [],
    Today: [],
    Yesterday: [],
    'This week': [],
    Earlier: [],
  };

  items.forEach((item) => {
    if (pinnedIds.has(item._id)) {
      buckets.Pinned.push(item);
      return;
    }
    const ts = item.lastMessage?.createdAt || item.updatedAt || item.createdAt;
    buckets[groupForTimestamp(ts)].push(item);
  });

  GROUP_ORDER.forEach((label) => {
    buckets[label].sort((a, b) => effectiveTs(b) - effectiveTs(a));
  });

  return GROUP_ORDER
    .map((label) => ({ label, items: buckets[label] }))
    .filter((bucket) => bucket.items.length > 0);
};

export const formatRelativeTime = (raw: string | Date | undefined): string => {
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const today = startOfDay(now);
  const ts = date.getTime();
  if (ts >= today) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (ts >= today - 24 * 60 * 60 * 1000) {
    return 'Yesterday';
  }
  if (ts >= today - 6 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString([], { weekday: 'short' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
