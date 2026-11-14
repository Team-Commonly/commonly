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
 */
export const firstNewSinceId = (
  view: ThreadViewItem[],
  viewerId: string | null | undefined,
  lastReadAt: string | null | undefined,
): string | null => {
  const since = timeOf(lastReadAt);
  if (!viewerId || !Number.isFinite(since)) return null;
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
