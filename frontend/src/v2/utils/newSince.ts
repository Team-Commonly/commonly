import type { ThreadViewItem } from './threadView';

const timeOf = (iso: string | undefined | null): number => {
  const ms = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(ms) ? ms : NaN;
};

/**
 * First minute back: the message the "New since your last visit" divider sits
 * above. That's the first main-channel message someone else wrote after the
 * viewer's read point. Their own words and system lines don't count. No read
 * point (no visit recorded yet) means no divider. Thread replies keep their
 * own unread marks on the thread card.
 *
 * With older history not loaded yet (`historyAbove`), a first new message at
 * the very top of the page doesn't mark where the reader left off: more new
 * messages may sit above it. A divider there would say they didn't, so there
 * is none, and the pod opens at its end as before.
 */
export const firstNewSinceId = (
  view: ThreadViewItem[],
  viewerId: string | null | undefined,
  lastReadAt: string | null | undefined,
  { historyAbove = false }: { historyAbove?: boolean } = {},
): string | null => {
  const since = timeOf(lastReadAt);
  if (!viewerId || !Number.isFinite(since)) return null;
  const firstLoaded = view.find((item) => item.kind === 'message');
  if (historyAbove && firstLoaded?.kind === 'message') {
    const at = timeOf(firstLoaded.message.created_at || firstLoaded.message.createdAt);
    if (!Number.isFinite(at) || at > since) return null;
  }
  for (const item of view) {
    if (item.kind !== 'message') continue;
    const { message } = item;
    if (String(message.user_id) === String(viewerId)) continue;
    if ((message.message_type || message.messageType) === 'system') continue;
    const at = timeOf(message.created_at || message.createdAt);
    if (Number.isFinite(at) && at > since) return String(message.id);
  }
  return null;
};
