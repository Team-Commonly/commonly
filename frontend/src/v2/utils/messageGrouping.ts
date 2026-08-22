// Consecutive-author grouping (craft audit finding 7 / baseline rule 3).
// A message joins the previous one's group — header suppressed, row
// tightened — when it's the same author within the window and neither side
// breaks the run: replies keep their header (the quote needs an owner),
// payload cards render their own chrome, and a missing or unparsable
// timestamp never groups.
export const GROUPING_WINDOW_MS = 3 * 60 * 1000;

// Structural subset of V2Message — only the fields the predicate reads.
// Kept loose so both the live V2Message and test literals satisfy it.
export interface GroupableMessage {
  user_id?: string | null;
  user?: { username?: string | null } | null;
  created_at?: string;
  replyTo?: unknown;
  reply_content?: unknown;
  payload?: { kind?: string } | null;
}

export const isGroupedWithPrevious = (
  m: GroupableMessage,
  prev?: GroupableMessage,
): boolean => {
  if (!prev) return false;
  if (!m.user_id || m.user_id !== prev.user_id) return false;
  if ((m.user?.username || '') !== (prev.user?.username || '')) return false;
  if (m.replyTo || m.reply_content) return false;
  if (m.payload?.kind || prev.payload?.kind) return false;
  const a = new Date(m.created_at ?? NaN).getTime();
  const b = new Date(prev.created_at ?? NaN).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a - b >= 0 && a - b <= GROUPING_WINDOW_MS;
};
