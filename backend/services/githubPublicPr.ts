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
 * spent no request is sent until its reset.
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
// The most requests one read can send: the PR, its diff, and three /files pages.
const REQUESTS_PER_READ = 5;
// What GitHub last said was left, and when that window resets. Reads in flight
// each reserve REQUESTS_PER_READ against it, so parallel reads cannot all start
// on one count and overrun the floor together.
let lastRemaining: number | null = null;
let lastResetAt = 0;
let readsInFlight = 0;

const MAX_RETRY_AFTER_SECONDS = 3600;
const clampRetry = (seconds: number) => Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));

const rateLimitedError = (seconds: number) => new PublicPrError(
  503,
  'github_rate_limited',
  'GitHub is rate-limiting unauthenticated reads from Commonly. Try again later.',
  seconds,
);

/** Seconds until GitHub accepts another request, when this answer is a rate limit; else null. */
const rateLimitSeconds = (status: number, headers: Headers): number | null => {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = headers.get('retry-after');
  const remaining = headers.get('x-ratelimit-remaining');
  if (status === 403 && remaining !== '0' && retryAfter === null) return null;
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) return clampRetry(Number(retryAfter));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return clampRetry(reset - Date.now() / 1000);
  return 60;
};

const holding = () => holdUntil > Date.now();

// A limit hold is never downgraded to a floor hold, so budget above the floor
// can't lift it early.
const holdFor = (kind: 'floor' | 'limit', until: number) => {
  const active = holding();
  holdUntil = active ? Math.max(holdUntil, until) : until;
  if (!active || kind === 'limit') holdKind = kind;
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
};

const heldError = (seconds: number) => {
  const error = rateLimitedError(clampRetry(seconds));
  error.sentGithubNothing = true;
  return error;
};

/**
 * Admit a new uncached read, or refuse it while GitHub's budget is spent, down
 * to the floor, or reserved by reads already in flight. The caller releases
 * the reservation when the read ends.
 */
const reserveRead = () => {
  const now = Date.now();
  if (holding()) throw heldError((holdUntil - now) / 1000);
  if (lastRemaining !== null && lastResetAt > now
      && lastRemaining - (readsInFlight + 1) * REQUESTS_PER_READ < GITHUB_HEADROOM_FLOOR) {
    throw heldError((lastResetAt - now) / 1000);
  }
  readsInFlight += 1;
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
  const wait = rateLimitSeconds(response.status, response.headers);
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
  reserveRead();
  try {
    return await readFromGithub({ owner, repo, number }, key);
  } finally {
    readsInFlight -= 1;
  }
};

/** The uncached read: the PR, then its diff (or its /files pages). */
const readFromGithub = async (
  { owner, repo, number }: PublicPrRef,
  key: string,
): Promise<{ pr: PublicPr; fromCache: boolean }> => {
  const prPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const prResponse = await getFromGithub(prPath, JSON_ACCEPT, PUBLIC_PR_LIMITS.maxJsonBytes);
  const raw = parseJson(prResponse.text, prResponse.truncated);
  const headSha = detach(str(raw?.head?.sha, 64));
  remember(heads, key, { sha: headSha, at: Date.now() });
  const hit = cachedResult(key, headSha);
  if (hit) return { pr: hit, fromCache: false };

  const truncatedParts = new Set<'body' | 'files' | 'diff'>();
  const changedFiles = count(raw?.changed_files);

  const diffResponse = await getFromGithub(prPath, DIFF_ACCEPT, PUBLIC_PR_LIMITS.maxDiffParseBytes, [406]);
  let files: PublicPrFile[];
  let diff = '';
  if (diffResponse.status === 406) {
    truncatedParts.add('diff');
    const fallback = await readFilesFallback(prPath, changedFiles);
    ({ files } = fallback);
    if (fallback.cut) truncatedParts.add('files');
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

  const fullBody = typeof raw?.body === 'string' ? raw.body : '';
  if (fullBody.length > PUBLIC_PR_LIMITS.maxBodyChars) truncatedParts.add('body');

  let state: PublicPr['state'] = raw?.state === 'closed' ? 'closed' : 'open';
  if (raw?.merged === true || typeof raw?.merged_at === 'string') state = 'merged';

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
    changedFiles,
    additions: count(raw?.additions),
    deletions: count(raw?.deletions),
    files,
    diff,
    truncated: truncatedParts.size > 0,
    truncatedParts: [...truncatedParts],
  });
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
