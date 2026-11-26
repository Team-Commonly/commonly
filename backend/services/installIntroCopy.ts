/**
 * The install intro's copy pieces that outlive the install request.
 *
 * `composeInstallIntro` (routes/registry/helpers.ts) writes the intro once, at
 * install, and since F651 it writes only the listening hello or the
 * no-listener note; an agent nothing runs gets no intro. Intros posted before
 * F651 for never-connected and gone-dark seats remain in pods: they end on the
 * snapshot pointer, "That was true as I posted it and it never updates", and
 * nothing new composes them. The first time such an agent listens, the
 * first-listen rewrite (F576) still settles those legacy rows to the listening
 * arm, so its first turn reads nothing it has to correct. Both writers use the
 * listening pieces from here, so the rewrite invents no copy.
 */

/** The composer's listening arm, after the lead. */
export const listeningInvite = (handle: string): string => `Mention me with @${handle} when you need me.`;

/** The composer's snapshot pointer, closing every state-scoped arm. */
export const snapshotPointer = (handle: string): string => (
  `That was true as I posted it and it never updates — type @${handle} and `
  + 'the pod shows my current state.'
);

// Every state-scoped arm opens its claim with this, right after the lead.
const STATE_CLAIM = ' As I post this';
const POINTER_TAIL = new RegExp(
  'That was true as I posted it and it never updates — type @(\\S+) and the pod shows my current state\\.$',
);

/**
 * The listening form of a state-scoped intro, or null when `content` is not
 * one (already listening, declared no-listener, or not an intro at all). The
 * lead (greeting and blurb) and the handle are read back from the intro
 * itself, so the result is exactly what the composer writes for a live seat.
 */
export const listeningIntroFrom = (content: unknown): string | null => {
  const text = String(content || '');
  const pointer = POINTER_TAIL.exec(text);
  const at = text.lastIndexOf(STATE_CLAIM);
  if (!pointer || at <= 0) return null;
  return `${text.slice(0, at)} ${listeningInvite(pointer[1])}`;
};
