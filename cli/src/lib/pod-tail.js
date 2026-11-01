/**
 * Live pod tail for `commonly pod tail`.
 *
 * GET /api/messages/:podId takes `before` and `limit` only; it ignores `after`
 * and returns the newest `limit` rows. Polling it with a cursor therefore
 * re-serves the same window every tick. The poller keeps the ids it has
 * already printed and prints only the rest, in the order the page returns
 * them (oldest first).
 */

// Ids kept for de-duplication. Old entries fall out first, so a long tail
// stays bounded in memory.
export const TAIL_SEEN_MAX = 1000;
export const TAIL_PAGE_LIMIT = 100;

// Same bot field the v2 chat reads (frontend/src/v2/utils/threadView.ts
// participantOf): `user.isBot`, falling back to the mapped `userId.isBot`.
export const isAgentMessage = (m) => {
  if (typeof m?.user?.isBot === 'boolean') return m.user.isBot;
  return m?.userId?.isBot === true;
};

const authorName = (m) => m?.user?.username || m?.userId?.username || m?.username || '?';

const clock = (m) => {
  const raw = m?.createdAt || m?.timestamp;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toTimeString().slice(0, 8) : '--:--:--';
};

export const formatTailLine = (m) => {
  const marker = isAgentMessage(m) ? '🤖' : '👤';
  return `[${clock(m)}] ${marker} ${authorName(m)}: ${m?.content ?? ''}`;
};

/**
 * @param {object} opts
 * @param {(limit: number) => Promise<object[] | {messages: object[]}>} opts.fetchPage
 * @param {'all'|'agents'|'humans'} [opts.filter='all']
 * @param {(line: string) => void} opts.print
 */
export const createTailPoller = ({ fetchPage, filter = 'all', print }) => {
  const seen = new Set();
  const remember = (id) => {
    seen.add(id);
    if (seen.size > TAIL_SEEN_MAX) seen.delete(seen.values().next().value);
  };

  return async () => {
    const data = await fetchPage(TAIL_PAGE_LIMIT);
    const messages = Array.isArray(data) ? data : data?.messages || [];
    let printed = 0;

    messages.forEach((m) => {
      const id = String(m?._id || m?.id || '');
      if (id) {
        if (seen.has(id)) return;
        remember(id);
      }
      if (filter === 'agents' && !isAgentMessage(m)) return;
      if (filter === 'humans' && isAgentMessage(m)) return;
      print(formatTailLine(m));
      printed += 1;
    });

    return printed;
  };
};
