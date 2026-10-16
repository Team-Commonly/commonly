/**
 * Which web addresses a turn may open with commonly_fetch_url (TASK-267b).
 *
 * The address of a GET is itself a way out: whatever the model puts in a URL
 * reaches that URL's host. A model steered by outsider text (a page, a search
 * result, a connector record) could compose `https://their.host/?d=<what this
 * turn holds>`, and the egress guard would rightly let it through, because
 * the host is public. So the model never composes an address. It may open one
 * only when that address appears, as written, in text the turn was GIVEN: the
 * prompt, the message it is answering, pod messages by other authors, search
 * results, or a page it already read. Its own words (its replies, its tool
 * arguments, its own posts) never count, so it cannot write an address and
 * then open it.
 *
 * A match is exact apart from what cannot carry data the model chose: the
 * scheme (an http link is opened as https, never the reverse), a fragment
 * (never sent), the case of the host, trailing slashes, and punctuation that
 * ends a sentence. The path and query must match character for character; a
 * prefix of a given address does not count.
 */

// Where a written address ends in running text, markdown and HTML-reduced text.
const TOKEN_SEPARATORS = /[\s<>"'`()[\]{}|\\^]+/;
const TRAILING_PUNCTUATION = /[.,;:!?*_~]+$/;
// Checked against one token, anchored, so its cost is bounded by the token.
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/i;

/** The comparable form of one written address, or null when it is not one. */
export const addressKey = (raw: string): string | null => {
  let text = String(raw || '').trim().replace(TRAILING_PUNCTUATION, '');
  text = text.replace(/^https?:\/\//i, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !HOST_PATTERN.test(text.split('/')[0])) return null;
  const hash = text.indexOf('#');
  if (hash !== -1) text = text.slice(0, hash);
  const slash = text.indexOf('/');
  const host = slash === -1 ? text : text.slice(0, slash);
  if (!HOST_PATTERN.test(host)) return null;
  const rest = slash === -1 ? '' : text.slice(slash).replace(/\/+$/, '');
  return `${host.toLowerCase()}${rest}`;
};

/** Every address written in `text`, in comparable form. */
export const addressesIn = (text: string): Set<string> => {
  const found = new Set<string>();
  for (const token of String(text || '').split(TOKEN_SEPARATORS)) {
    if (!token.includes('.')) continue;
    const key = addressKey(token);
    if (key) found.add(key);
  }
  return found;
};

/** True when `url` appears, as written, in one of the texts the turn was given. */
export const addressWasGiven = (url: string, given: readonly string[]): boolean => {
  const wanted = addressKey(url);
  if (!wanted) return false;
  return given.some((text) => addressesIn(text).has(wanted));
};
