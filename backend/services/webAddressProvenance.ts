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
 * The model's argument only SELECTS. What is requested is the given address,
 * rebuilt from the given text (GivenAddresses.resolve), never the argument: a
 * comparison that ignores a trailing run, a fragment or host case must not
 * then send them, or the ignored bytes are a channel of their own
 * (Cofounder's security read on #2249: `<given link>!!!…` matched, and the
 * appended run went out in the request path).
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

/**
 * One written address: `key`, the form two writings are compared in, and
 * `url`, the address as written, opened over https: host lowercased, fragment
 * dropped (it is never sent), sentence punctuation after it trimmed, and its
 * own path, query and trailing slashes kept. Null when it is not an address.
 */
const parseAddress = (raw: string): { key: string; url: string } | null => {
  let text = trimEnd(String(raw || '').trim(), (char) => TRAILING_PUNCTUATION.has(char));
  text = text.replace(/^https?:\/\//i, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !isHost(text.split('/')[0])) return null;
  const hash = text.indexOf('#');
  if (hash !== -1) text = text.slice(0, hash);
  const slash = text.indexOf('/');
  const host = slash === -1 ? text : text.slice(0, slash);
  if (!isHost(host)) return null;
  const path = slash === -1 ? '' : text.slice(slash);
  const lowerHost = host.toLowerCase();
  return { key: `${lowerHost}${trimEnd(path, (char) => char === '/')}`, url: `https://${lowerHost}${path}` };
};

/** The comparable form of one written address, or null when it is not one. */
export const addressKey = (raw: string): string | null => parseAddress(raw)?.key ?? null;

/**
 * How many texts have been scanned for addresses, ever, in this process.
 *
 * Instrumentation, not behaviour: the no-rescan guarantee below ("each given
 * text is scanned once, and a refused attempt costs no rescan") used to be
 * asserted with a wall clock, which measures the shared CI runner as much as
 * the code and flaked at 62 ms against a 50 ms budget (TASK-347). A rescan is
 * a count, so count it: one rescan fails the test, and a slow machine does
 * not. Monotonic and never read by anything here.
 */
let textScans = 0;
export const textScanCount = (): number => textScans;

/** Every address written in `text`, keyed by its comparable form, first writing kept. */
const writtenAddresses = (text: string): Map<string, string> => {
  textScans += 1;
  const found = new Map<string, string>();
  for (const token of String(text || '').split(TOKEN_SEPARATORS)) {
    if (!token.includes('.')) continue;
    const parsed = parseAddress(token);
    if (parsed && !found.has(parsed.key)) found.set(parsed.key, parsed.url);
  }
  return found;
};

/** Every address written in `text`, in comparable form. */
export const addressesIn = (text: string): Set<string> => new Set(writtenAddresses(text).keys());

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
  // Comparable form → the address as it was given, the first writing kept.
  private readonly given = new Map<string, string>();

  add(text: string): void {
    for (const [key, url] of writtenAddresses(text)) {
      if (!this.given.has(key)) this.given.set(key, url);
    }
  }

  has(url: string): boolean {
    return this.resolve(url) !== null;
  }

  /**
   * The given address `url` selects, rebuilt from the given text, or null.
   * This, never `url`, is what may be requested.
   */
  resolve(url: string): string | null {
    const wanted = addressKey(url);
    return wanted === null ? null : this.given.get(wanted) ?? null;
  }
}
