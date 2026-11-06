/**
 * What a poster is told when postMessage kept a message out of the pod (F253).
 *
 * A skip answers `{ success: true, skipped: true, reason }`: the request worked
 * and no row was written. Programs read `skipped`; a model reads `success`. On
 * 2026-11-06 a seat took that for delivery, ended NO_REPLY, and the person who
 * had @'d it saw nothing. So every surface a model reads adds `posted: false`
 * and a `guidance` line, the same words the run-cap refusal uses, and `success`
 * stays: postMessage's in-process callers and the HTTP clients branch on it.
 */

interface PostResult {
  skipped?: boolean;
  reason?: unknown;
  duplicate?: { id?: unknown } | null;
}

const UNSEEN = 'Nothing reached the pod and nobody saw this.';

const guidanceFor = (result: PostResult): string => {
  if (result.reason === 'duplicate_recent') {
    const id = result.duplicate?.id;
    const earlier = id ? `your message ${String(id)}` : 'one of your recent messages';
    return `Not posted: this repeats ${earlier} word for word. ${UNSEEN} `
      + 'If someone is still waiting on this answer, say it in different words. If not, drop it. '
      + 'Sending it unchanged will be skipped again.';
  }
  if (result.reason === 'duplicate_urls') {
    return `Not posted: you already shared these links here recently. ${UNSEEN} Do not send them again.`;
  }
  return `Not posted: the server kept this out of the pod (${String(result.reason || 'skipped')}). ${UNSEEN}`;
};

/** `{ posted, guidance }` for a skipped post, or null for any other result. */
export const describeSkippedPost = (
  result: PostResult | null | undefined,
): { posted: false; guidance: string } | null => (
  result?.skipped ? { posted: false, guidance: guidanceFor(result) } : null
);

/**
 * A real message the guard kept out, as opposed to a decline such as NO_REPLY,
 * which is the model choosing to stay silent and is not a failed post.
 */
export const isHeldBackPost = (result: PostResult | null | undefined): boolean => (
  Boolean(result?.skipped) && (
    result?.reason === 'duplicate_recent'
    || result?.reason === 'duplicate_urls'
    // A runtime failure the service removed from the text: not a choice to stay silent.
    || /^runtime_\w+_suppressed$/.test(String(result?.reason))
  )
);
