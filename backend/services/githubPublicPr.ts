/**
 * Read a public GitHub pull request for an agent whose own sandbox has no
 * network (F646). Two people's sandboxed seats were asked to review a public
 * PR and neither could reach GitHub; both reach Commonly through the MCP tools.
 *
 * Rules this module keeps:
 * - It never fetches a URL a caller supplied. The caller names an owner, a repo
 *   and a number, each checked against GitHub's own name rules, and the
 *   api.github.com URLs are built here. The fetch goes through the outbound
 *   guard, which rebuilds every hop on the one allowed origin, refuses a
 *   redirect to any other host, and holds one deadline.
 * - It sends no credential of anyone's: no user's GitHub connection and no
 *   server token. Only the headers named in GITHUB_HEADERS leave, so a private
 *   repo answers 404 exactly as it would to a stranger, and Commonly never acts
 *   as anyone's GitHub account.
 * - Everything returned is trimmed to a hard cap and says when it was cut.
 *
 * Unauthenticated GitHub allows 60 requests an hour per client address, and
 * every agent on this server shares that address. So a read costs two requests
 * (the PR, then its diff, from which the file list is parsed), a repeat read
 * of the same head is served from memory, and once GitHub says the budget is
 * spent no request is sent until its reset. A read GitHub will not render a
 * diff for costs at most six (REQUESTS_PER_READ).
 *
 * The diff of an open PR is read by revision (`compare/<base>...<head>` at the
 * SHAs the PR answer named), so a push between the two requests cannot pair
 * one revision's diff with another's head. A closed or merged PR's head no
 * longer moves, so its own diff endpoint is read.
 */
import { isOutboundUrlRefused, readTextFromAllowedHost } from './outboundUrlGuard';
import { logOutboundFailure } from '../utils/safeErrorLog';

export const PUBLIC_PR_LIMITS = Object.freeze({
  maxDiffBytes: 200 * 1024,
  maxFiles: 300,
  maxBodyChars: 20_000,
  // The diff is read further than it is returned, so the file list covers
  // more of a large PR than the returned diff does.
  maxDiffParseBytes: 4 * 1024 * 1024,
  maxJsonBytes: 1024 * 1024,
  maxFilesPageBytes: 4 * 1024 * 1024,
  maxFilesPages: 3,
});

const GITHUB_API_ORIGINS: ReadonlyMap<string, string> = new Map([['api.github.com', 'https://api.github.com/']]);
const GITHUB_HEADERS = Object.freeze({
  'User-Agent': 'commonly-public-pr-reader',
  'X-GitHub-Api-Version': '2022-11-28',
});
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.diff';

// GitHub's account rule: 1-39 letters, digits or hyphens, not starting or
// ending with a hyphen. Repo names: 1-100 of letters, digits, '.', '_', '-',
// and never '.' or '..'.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9]\d{0,9}$/;
const MAX_PR_NUMBER = 2 ** 31 - 1;
const REF_KEYS = new Set(['owner', 'repo', 'number']);

export class PublicPrError extends Error {
  readonly status: number;

  readonly code: string;

  readonly retryAfterSeconds?: number;

  /** True when the refusal came before any request to GitHub (the read was held). */
  sentGithubNothing = false;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'PublicPrError';
    this.status = status;
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface PublicPrRef { owner: string; repo: string; number: number }

const invalidRef = (message: string) => new PublicPrError(400, 'invalid_pr_ref', message);

/** Validate a request's owner/repo/number. Anything else in the query is refused. */
export const parsePublicPrRef = (query: Record<string, unknown> | null | undefined): PublicPrRef => {
  const input = query || {};
  if (Object.keys(input).some((key) => !REF_KEYS.has(key))) {
    throw invalidRef('Only owner, repo and number are accepted');
  }
  const { owner, repo, number } = input;
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) {
    throw invalidRef('owner must be a GitHub account name');
  }
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    throw invalidRef('repo must be a GitHub repository name');
  }
  if (typeof number !== 'string' && typeof number !== 'number') {
    throw invalidRef('number must be a positive integer');
  }
  const numberText = String(number);
  if (!NUMBER_PATTERN.test(numberText) || Number(numberText) > MAX_PR_NUMBER) {
    throw invalidRef('number must be a positive integer');
  }
  return { owner, repo, number: Number(numberText) };
};

export interface PublicPrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  previousPath?: string;
}

export interface PublicPr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: string | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; repo: string | null };
  body: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  files: PublicPrFile[];
  diff: string;
  truncated: boolean;
  truncatedParts: Array<'body' | 'files' | 'diff'>;
}

// ── GitHub's answers ────────────────────────────────────────────────────────

// Until this time no new uncached read is sent. Set by GitHub's rate limit,
// and earlier by the headroom floor: other server calls reach api.github.com
// with no credential from the same address (skillsCatalogService's skill
// import, newPodFirstTaskService's starter issue, and skillsRefreshService when
// no App or PAT is configured), so this feature stops while 10 remain.
let holdUntil = 0;
// A floor hold ends when GitHub's window rolls over; a rate-limit hold (a
// primary limit, or a secondary limit's retry-after) runs out its time.
let holdKind: 'floor' | 'limit' = 'floor';
export const GITHUB_HEADROOM_FLOOR = 10;
// The most requests one read can send: the PR, its diff, three /files pages
// when GitHub will not render the diff, and one re-read of the PR's head after
// those pages (they are not pinned to a revision).
const REQUESTS_PER_READ = 6;
// What GitHub last said was left, and when that window resets. Reads in flight
// each reserve REQUESTS_PER_READ against it, so parallel reads cannot all start
// on one count and overrun the floor together.
let lastRemaining: number | null = null;
let lastResetAt = 0;
let readsInFlight = 0;
// While the budget is unknown (never seen, or its window has rolled over) one
// read goes alone to learn it; others wait for its first answer's headers.
let probe: Promise<void> | null = null;
let endProbe: (() => void) | null = null;

const MAX_RETRY_AFTER_SECONDS = 3600;
const clampRetry = (seconds: number) => Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
// GitHub: on a secondary limit with no retry-after and primary budget left,
// wait at least a minute.
const MIN_SECONDARY_HOLD_SECONDS = 60;
// Only this much of an error body is read, to classify it.
const ERROR_BODY_SCAN_BYTES = 4096;
const SECONDARY_LIMIT_PATTERN = /secondary rate limit|abuse detection/i;

const rateLimitedError = (seconds: number) => new PublicPrError(
  503,
  'github_rate_limited',
  'GitHub is rate-limiting unauthenticated reads from Commonly. Try again later.',
  seconds,
);

/** Retry-After in seconds (delta-seconds or an HTTP date), or null when absent or unusable. */
const retryAfterSeconds = (value: string | null): number | null => {
  if (value === null || value.trim() === '') return null;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, (at - Date.now()) / 1000);
};

/**
 * Seconds until GitHub accepts another request, when this answer is a rate
 * limit; else null. A primary limit (403 with none remaining) waits for its
 * reset. A secondary limit (a 429, or a 403 whose body says so) honours
 * Retry-After, else waits for the reset when none remain, else a minute.
 */
const rateLimitSeconds = (status: number, headers: Headers, bodyHead: string): number | null => {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = retryAfterSeconds(headers.get('retry-after'));
  const noneRemaining = headers.get('x-ratelimit-remaining') === '0';
  const secondary = status === 429 || SECONDARY_LIMIT_PATTERN.test(bodyHead);
  if (!secondary && !noneRemaining && retryAfter === null) return null;
  if (retryAfter !== null) return clampRetry(retryAfter);
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (noneRemaining && Number.isFinite(reset) && reset > 0) return clampRetry(reset - Date.now() / 1000);
  return MIN_SECONDARY_HOLD_SECONDS;
};

const holding = () => holdUntil > Date.now();

// A limit hold is never downgraded to a floor hold, so budget above the floor
// can't lift it early.
const holdFor = (kind: 'floor' | 'limit', until: number) => {
  const active = holding();
  holdUntil = active ? Math.max(holdUntil, until) : until;
  if (!active || kind === 'limit') holdKind = kind;
};

/** End the unknown-budget probe (only `owned`, when given), releasing the reads waiting on it. */
const finishProbe = (owned?: Promise<void>) => {
  if (!probe || (owned && probe !== owned)) return;
  const end = endProbe;
  probe = null;
  endProbe = null;
  if (end) end();
};

/**
 * Record the budget GitHub reports. At or under the floor, hold new reads until
 * its reset. Budget above the floor lifts only a floor hold, and only from a
 * later window than the one that set it: a secondary limit's retry-after stands.
 */
const noteBudget = (headers: Headers) => {
  const remainingHeader = headers.get('x-ratelimit-remaining');
  if (remainingHeader === null || !/^\d{1,9}$/.test(remainingHeader)) return;
  const remaining = Number(remainingHeader);
  const reset = Number(headers.get('x-ratelimit-reset'));
  const resetAt = Number.isFinite(reset) && reset * 1000 > Date.now() ? reset * 1000 : Date.now() + 60 * 1000;
  lastRemaining = remaining;
  lastResetAt = resetAt;
  if (remaining <= GITHUB_HEADROOM_FLOOR) {
    holdFor('floor', resetAt);
  } else if (holding() && holdKind === 'floor' && resetAt > holdUntil) {
    holdUntil = 0;
  }
  // The budget is known again: reads waiting on the probe are admitted normally.
  finishProbe();
};

const heldError = (seconds: number) => {
  const error = rateLimitedError(clampRetry(seconds));
  error.sentGithubNothing = true;
  return error;
};

const startProbe = (): Promise<void> => {
  probe = new Promise<void>((resolve) => { endProbe = resolve; });
  return probe;
};

const budgetKnown = (now: number) => lastRemaining !== null && lastResetAt > now;

/**
 * Admit a new uncached read, or refuse it while GitHub's budget is spent, down
 * to the floor, or reserved by reads already in flight. While the budget is
 * unknown, the first read is admitted alone as a probe and the rest wait for
 * it to record GitHub's headers (or to end), then are admitted or refused on
 * what it learned. Returns the probe this read owns, if any, boxed: an async
 * function returning the promise itself would make the caller's `await` wait
 * for the probe to end. The caller ends it and releases the reservation when
 * the read ends.
 */
const reserveRead = async (): Promise<{ ownProbe: Promise<void> | null }> => {
  for (;;) {
    const now = Date.now();
    if (holding()) throw heldError((holdUntil - now) / 1000);
    if (budgetKnown(now)) {
      if (lastRemaining! - (readsInFlight + 1) * REQUESTS_PER_READ < GITHUB_HEADROOM_FLOOR) {
        throw heldError((lastResetAt - now) / 1000);
      }
      readsInFlight += 1;
      return { ownProbe: null };
    }
    if (!probe) {
      readsInFlight += 1;
      return { ownProbe: startProbe() };
    }
    await probe;
  }
};

const upstreamError = () => new PublicPrError(502, 'github_unavailable', 'GitHub could not be read just now.');

/**
 * One GET to api.github.com. Non-2xx answers become PublicPrErrors, except
 * those `passStatuses` names. The hold is checked once per read, before its
 * first request, so a read that started is not cut off halfway.
 */
const getFromGithub = async (
  path: string,
  accept: string,
  maxBytes: number,
  passStatuses: readonly number[] = [],
) => {
  let response;
  try {
    response = await readTextFromAllowedHost(`https://api.github.com/${path}`, {
      allowedOrigins: GITHUB_API_ORIGINS,
      maxBytes,
      headers: { ...GITHUB_HEADERS, Accept: accept },
      // Enough of an error body to tell a secondary limit's 403 from another.
      maxErrorBytes: ERROR_BODY_SCAN_BYTES,
    });
  } catch (error) {
    if (isOutboundUrlRefused(error)) {
      logOutboundFailure('[public-pr] GitHub redirected off api.github.com:', error);
      throw upstreamError();
    }
    const name = (error as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new PublicPrError(504, 'github_timeout', 'GitHub did not answer in time.');
    }
    logOutboundFailure('[public-pr] GitHub request failed:', error);
    throw upstreamError();
  }
  noteBudget(response.headers);
  if (response.ok || passStatuses.includes(response.status)) return response;
  // The error body is read only to its first ERROR_BODY_SCAN_BYTES.
  const wait = rateLimitSeconds(response.status, response.headers, response.ok ? '' : response.text);
  if (wait !== null) {
    holdFor('limit', Date.now() + wait * 1000);
    throw rateLimitedError(wait);
  }
  if (response.status === 404 || response.status === 410 || response.status === 451) {
    throw new PublicPrError(
      404,
      'pr_not_found_or_private',
      'No public pull request at that address. It may not exist, or the repository may be private.',
    );
  }
  throw upstreamError();
};

const parseJson = (text: string, truncated: boolean): any => {
  if (truncated) throw upstreamError();
  try {
    return JSON.parse(text);
  } catch {
    throw upstreamError();
  }
};

// ── Shaping ─────────────────────────────────────────────────────────────────

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const count = (value: unknown): number => (Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0);

/**
 * The first `maxBytes` of `text`, cut at the last line end inside the cap, or
 * with no line end there, on a UTF-8 character boundary: the cut steps back
 * over continuation bytes (0b10xxxxxx), so no character is split. Linear, and
 * no regex runs over the diff.
 */
const cutDiff = (text: string, maxBytes: number): { diff: string; cut: boolean } => {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { diff: text, cut: false };
  const lineEnd = bytes.subarray(0, maxBytes).lastIndexOf(10);
  let end = lineEnd + 1;
  if (lineEnd < 0) {
    end = maxBytes;
    // bytes[end] is the first byte left out; while it continues a character,
    // that character started inside the cut, so leave it out whole.
    // 0x80-0xBF is exactly the 0b10xxxxxx range.
    while (end > 0 && bytes[end] >= 0x80 && bytes[end] <= 0xbf) end -= 1;
  }
  return { diff: bytes.toString('utf8', 0, end), cut: true };
};

const MAX_PATH = 1024;

/** The new-side path of a `diff --git a/<old> b/<new>` header: after its last " b/". */
const headerPath = (line: string): string => {
  const at = line.lastIndexOf(' b/');
  return at < 0 ? '' : line.slice(at + 3);
};

/** The changed-file list of a unified git diff: path, status, and line counts. */
export const filesFromDiff = (diff: string): PublicPrFile[] => {
  const files: PublicPrFile[] = [];
  let file: PublicPrFile | null = null;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = {
        path: headerPath(line).slice(0, MAX_PATH), status: 'modified', additions: 0, deletions: 0,
      };
      files.push(file);
      inHunk = false;
    } else if (file && !inHunk) {
      if (line.startsWith('@@')) inHunk = true;
      else if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'removed';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.previousPath = line.slice('rename from '.length).slice(0, MAX_PATH);
      } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length).slice(0, MAX_PATH);
      else if (line.startsWith('copy from ')) {
        file.status = 'copied';
        file.previousPath = line.slice('copy from '.length).slice(0, MAX_PATH);
      } else if (line.startsWith('copy to ')) file.path = line.slice('copy to '.length).slice(0, MAX_PATH);
      else if (line.startsWith('+++ b/')) file.path = line.slice(6).slice(0, MAX_PATH);
    } else if (file && inHunk) {
      if (line.startsWith('+')) file.additions += 1;
      else if (line.startsWith('-')) file.deletions += 1;
    }
  }
  return files;
};

const FILE_STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);

/** GitHub's /files rows, without their patches. */
const filesFromApi = (rows: unknown): PublicPrFile[] => (Array.isArray(rows) ? rows : []).map((row: any) => {
  const file: PublicPrFile = {
    path: str(row?.filename, MAX_PATH),
    status: FILE_STATUSES.has(row?.status) ? row.status : 'modified',
    additions: count(row?.additions),
    deletions: count(row?.deletions),
  };
  if (typeof row?.previous_filename === 'string') file.previousPath = str(row.previous_filename, MAX_PATH);
  return file;
});

/** GitHub will not render a diff past its own size limit; the /files list still answers. */
const readFilesFallback = async (prPath: string, changedFiles: number) => {
  const files: PublicPrFile[] = [];
  let cut = false;
  for (let page = 1; page <= PUBLIC_PR_LIMITS.maxFilesPages; page += 1) {
    const response = await getFromGithub(
      `${prPath}/files?per_page=100&page=${page}`,
      JSON_ACCEPT,
      PUBLIC_PR_LIMITS.maxFilesPageBytes,
    );
    if (response.truncated) { cut = true; break; }
    const rows = parseJson(response.text, false);
    files.push(...filesFromApi(rows));
    if (!Array.isArray(rows) || rows.length < 100) break;
  }
  return { files, cut: cut || changedFiles > files.length };
};

// ── Cache ───────────────────────────────────────────────────────────────────

// A PR's head is remembered for a minute, so two agents reading the same PR in
// the same exchange cost GitHub one read. A built result is kept by head SHA
// for ten minutes: a new push is a new head, so it is never served stale.
const HEAD_TTL_MS = 60 * 1000;
const RESULT_TTL_MS = 10 * 60 * 1000;
// Every stored string is flattened first (`detach`), because a slice or a
// decoded substring can keep its whole parent alive: before that, one entry
// held ~5 MB (the 4 MB diff read and the 1 MB PR JSON): 253 MB measured for 50
// entries. Measured after flattening, same input (50 PRs, each a 1 MB body and
// a ~4 MB diff of 320 files, kept at the 200 KB diff and 300-file caps): 13.5 MB
// retained in all, about 270 KB an entry.
const MAX_CACHE_ENTRIES = 50;
const heads = new Map<string, { sha: string; at: number }>();
const results = new Map<string, { pr: PublicPr; at: number }>();

const detach = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const sweep = <V extends { at: number }>(map: Map<string, V>) => {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now - entry.at >= RESULT_TTL_MS) map.delete(key);
  }
};

const remember = <V extends { at: number }>(map: Map<string, V>, key: string, value: V) => {
  sweep(map);
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value as string);
};

const cachedResult = (key: string, sha: string): PublicPr | null => {
  const resultKey = `${key}@${sha}`;
  const hit = results.get(resultKey);
  if (!hit) return null;
  if (Date.now() - hit.at < RESULT_TTL_MS) return hit.pr;
  results.delete(resultKey);
  return null;
};

/** Test hook: forget cached PRs, any rate-limit wait and the known budget. */
export const resetPublicPrStateForTests = (): void => {
  heads.clear();
  results.clear();
  holdUntil = 0;
  holdKind = 'floor';
  lastRemaining = null;
  lastResetAt = 0;
  readsInFlight = 0;
  finishProbe();
};

/** Test hook: how many heads and results the cache holds. */
export const publicPrCacheSizeForTests = (): { heads: number; results: number } => (
  { heads: heads.size, results: results.size }
);

// ── The read ────────────────────────────────────────────────────────────────

/**
 * `fromCache` is true when the read sent GitHub nothing; the route's hourly
 * limiter gives such a read back. While new reads are held, a remembered head
 * stays good for the result's own ten minutes, so a PR read recently is still
 * served (at worst ten minutes behind its newest push).
 */
export const readPublicPullRequest = async (
  { owner, repo, number }: PublicPrRef,
): Promise<{ pr: PublicPr; fromCache: boolean }> => {
  // GitHub names are case-insensitive.
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  const head = heads.get(key);
  if (head && Date.now() - head.at < (holding() ? RESULT_TTL_MS : HEAD_TTL_MS)) {
    const hit = cachedResult(key, head.sha);
    if (hit) return { pr: hit, fromCache: true };
  }
  const { ownProbe } = await reserveRead();
  try {
    return await readFromGithub({ owner, repo, number }, key);
  } finally {
    readsInFlight -= 1;
    // A probe whose answers carried no budget headers still lets the next read go.
    if (ownProbe) finishProbe(ownProbe);
  }
};

type ContentPart = 'files' | 'diff';
interface PrContent { files: PublicPrFile[]; diff: string; truncatedParts: ContentPart[] }

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const changedDuringRead = () => new PublicPrError(
  503,
  'pr_changed_during_read',
  'The pull request was pushed to while it was being read. Try again.',
  5,
);

/**
 * The files and diff at `headSha`. An open PR's diff is read by revision, from
 * the SHAs the PR answer named, so it cannot belong to a later push. When
 * GitHub will not render the diff, the /files pages are read instead; those
 * are not pinned, so an open PR's head is read once more after them, and a
 * head that moved refuses the read rather than return (or cache) files from
 * another revision. At most REQUESTS_PER_READ - 1 requests.
 */
const readContent = async (
  { owner, repo, prPath }: { owner: string; repo: string; prPath: string },
  raw: any,
  headSha: string,
  open: boolean,
): Promise<PrContent> => {
  const truncatedParts = new Set<ContentPart>();
  const baseSha = str(raw?.base?.sha, 64);
  if (open && (!SHA_PATTERN.test(baseSha) || !SHA_PATTERN.test(headSha))) throw upstreamError();
  const diffPath = open
    ? `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${baseSha}...${headSha}`
    : prPath;
  const diffResponse = await getFromGithub(diffPath, DIFF_ACCEPT, PUBLIC_PR_LIMITS.maxDiffParseBytes, [406]);
  let files: PublicPrFile[];
  let diff = '';
  if (diffResponse.status === 406) {
    truncatedParts.add('diff');
    const fallback = await readFilesFallback(prPath, count(raw?.changed_files));
    ({ files } = fallback);
    if (fallback.cut) truncatedParts.add('files');
    if (open) {
      const again = await getFromGithub(prPath, JSON_ACCEPT, PUBLIC_PR_LIMITS.maxJsonBytes);
      const latest = parseJson(again.text, again.truncated);
      if (str(latest?.head?.sha, 64) !== headSha) throw changedDuringRead();
    }
  } else {
    files = filesFromDiff(diffResponse.text);
    if (diffResponse.truncated) truncatedParts.add('files');
    const cut = cutDiff(diffResponse.text, PUBLIC_PR_LIMITS.maxDiffBytes);
    ({ diff } = cut);
    if (cut.cut || diffResponse.truncated) truncatedParts.add('diff');
  }
  if (files.length > PUBLIC_PR_LIMITS.maxFiles) {
    files = files.slice(0, PUBLIC_PR_LIMITS.maxFiles);
    truncatedParts.add('files');
  }
  return { files, diff, truncatedParts: [...truncatedParts] };
};

/**
 * The uncached read: the PR, then its diff (or its /files pages). The PR's own
 * fields always come from this read's answer; only the files and diff are
 * reused from the cache, when the head is one already read.
 */
const readFromGithub = async (
  { owner, repo, number }: PublicPrRef,
  key: string,
): Promise<{ pr: PublicPr; fromCache: boolean }> => {
  const prPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const prResponse = await getFromGithub(prPath, JSON_ACCEPT, PUBLIC_PR_LIMITS.maxJsonBytes);
  const raw = parseJson(prResponse.text, prResponse.truncated);
  const headSha = detach(str(raw?.head?.sha, 64));

  let state: PublicPr['state'] = raw?.state === 'closed' ? 'closed' : 'open';
  if (raw?.merged === true || typeof raw?.merged_at === 'string') state = 'merged';

  const hit = cachedResult(key, headSha);
  const content: PrContent = hit
    ? {
      files: hit.files,
      diff: hit.diff,
      truncatedParts: hit.truncatedParts.filter((part): part is ContentPart => part !== 'body'),
    }
    : await readContent({ owner, repo, prPath }, raw, headSha, state === 'open');

  const truncatedParts = new Set<'body' | 'files' | 'diff'>(content.truncatedParts);
  const fullBody = typeof raw?.body === 'string' ? raw.body : '';
  if (fullBody.length > PUBLIC_PR_LIMITS.maxBodyChars) truncatedParts.add('body');

  // Flattened, so the cached copy keeps none of the response buffers alive.
  const pr: PublicPr = detach({
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title: str(raw?.title, 1024),
    state,
    draft: raw?.draft === true,
    author: str(raw?.user?.login, 64) || null,
    base: { ref: str(raw?.base?.ref, 255), sha: str(raw?.base?.sha, 64) },
    head: { ref: str(raw?.head?.ref, 255), sha: headSha, repo: str(raw?.head?.repo?.full_name, 255) || null },
    body: fullBody.slice(0, PUBLIC_PR_LIMITS.maxBodyChars),
    changedFiles: count(raw?.changed_files),
    additions: count(raw?.additions),
    deletions: count(raw?.deletions),
    files: content.files,
    diff: content.diff,
    truncated: truncatedParts.size > 0,
    truncatedParts: [...truncatedParts],
  });
  // The head is remembered only with a result for it, so a refused read
  // leaves no head pointing at nothing.
  remember(heads, key, { sha: headSha, at: Date.now() });
  remember(results, `${key}@${headSha}`, { pr, at: Date.now() });
  return { pr, fromCache: false };
};

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  GITHUB_HEADROOM_FLOOR,
  PUBLIC_PR_LIMITS,
  PublicPrError,
  parsePublicPrRef,
  filesFromDiff,
  readPublicPullRequest,
  resetPublicPrStateForTests,
  publicPrCacheSizeForTests,
};
