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
 *
 * What remains is a selection channel: a page can pre-write many addresses
 * and a steered model leaks a little by WHICH one it opens, about log2(N) bits
 * a fetch. MAX_WEB_FETCHES_PER_TURN (nativeRuntimeService) is what bounds it,
 * so that cap is load-bearing; provenance does not make fetches free.
 *
 * Everything here runs on third-party text (search results, pages), so every
 * step is linear in it: trims scan by index, never with an anchored `+$`,
 * which backtracks quadratically on a long run that is not at the end
 * (sprint-review on #2249: 728 ms on one 40k token).
 */

// Where a written address ends in running text, markdown and HTML-reduced text.
const TOKEN_SEPARATORS = /[\s<>"'`()[\]{}|\\^]+/;
// Sentence punctuation that may follow an address without being part of it.
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', '?', '*', '_', '~']);
// A DNS name is at most 253 characters, which also bounds HOST_PATTERN's work.
const MAX_HOST_LENGTH = 253;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/i;

/** `text` without the run of trailing characters `drop` accepts; one pass from the end. */
const trimEnd = (text: string, drop: (char: string) => boolean): string => {
  let end = text.length;
  while (end > 0 && drop(text[end - 1])) end -= 1;
  return text.slice(0, end);
};
const isHost = (host: string): boolean => host.length <= MAX_HOST_LENGTH && HOST_PATTERN.test(host);

/** The comparable form of one written address, or null when it is not one. */
export const addressKey = (raw: string): string | null => {
  let text = trimEnd(String(raw || '').trim(), (char) => TRAILING_PUNCTUATION.has(char));
  text = text.replace(/^https?:\/\//i, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !isHost(text.split('/')[0])) return null;
  const hash = text.indexOf('#');
  if (hash !== -1) text = text.slice(0, hash);
  const slash = text.indexOf('/');
  const host = slash === -1 ? text : text.slice(0, slash);
  if (!isHost(host)) return null;
  const rest = slash === -1 ? '' : trimEnd(text.slice(slash), (char) => char === '/');
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

/**
 * The addresses a turn may open, kept as a set so each given text is scanned
 * once, when it arrives, and an attempt is one lookup. A refused attempt
 * spends no page (nothing was sent), so it must also cost no rescan.
 */
export class GivenAddresses {
  private readonly keys = new Set<string>();

  add(text: string): void {
    for (const key of addressesIn(text)) this.keys.add(key);
  }

  has(url: string): boolean {
    const wanted = addressKey(url);
    return wanted !== null && this.keys.has(wanted);
  }
}
