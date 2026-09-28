/**
 * Operator inbox — ONE account's attention queue, chosen explicitly.
 *
 * Why this exists: an operator account (connector-ops, lily-shen, gtm-ops) is a
 * human-class recipient, so the kernel already materializes AttentionItems for
 * it — mentions via `recordMentionedUsers`, decisions and handoffs via the
 * `currentHumanMembers` fan-out. What was missing was a consumer. The queue is
 * real: 576 open items for connector-ops on 2026-09-28, none of them ever read.
 *
 * THE IDENTITY RULE IS THE POINT OF THIS MODULE, not a detail in it. Every host
 * helper built on the CLI's saved login read SAM's queue, because the saved
 * login on a shared operator host is Sam's. So this command refuses to run
 * without an explicit token file (`--token-file`, or `COMMONLY_TOKEN_FILE`) and
 * never consults the saved login or `COMMONLY_TOKEN`. A reader can therefore
 * trust the first line of every run: it names whose queue was read, resolved
 * from `GET /api/auth/user` with that token.
 *
 * Two ids exist on a queue item and different commands consume them:
 *   `attentionItemId` — what `POST /api/activity/:id/acknowledge` wants
 *                       (`attentionItemService.acknowledgeAttention` matches
 *                       `_id` and refuses a non-24-hex value)
 *   `id`              — the SOURCE row: for a decision that is the decision id
 *                       that `POST /api/activity/decisions/:id/choose` wants
 * `list` prints both, labelled, so neither command has to be discovered by
 * failing first.
 *
 * The cursor is an ISO-8601 timestamp compared against `createdAt` — the only
 * field on an item that never moves. The queue's ORDER moves as items are
 * acknowledged (priority, then newest first), so an offset cursor would skip
 * rows; `createdAt` cannot.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export const INBOX_KINDS = ['mention', 'decision', 'handoff', 'approval'];
export const TOKEN_FILE_ENV = 'COMMONLY_TOKEN_FILE';
export const API_PAGE_LIMIT = 50;

const TOKEN_FIELDS = ['token', 'runtimeToken', 'accessToken', 'access_token'];
const DETAIL_CHARS = 160;

/** A refusal the operator can fix by re-reading the message. Never a server fault. */
export class InboxRefusal extends Error {}

/** A server-side failure. `status` is the HTTP status. */
export class InboxRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'InboxRequestError';
    this.status = status;
  }
}

export const resolveTokenFilePath = (opts = {}, env = process.env) => {
  const flag = typeof opts.tokenFile === 'string' ? opts.tokenFile.trim() : '';
  if (flag) return flag;
  const fromEnv = typeof env?.[TOKEN_FILE_ENV] === 'string' ? env[TOKEN_FILE_ENV].trim() : '';
  return fromEnv || null;
};

/**
 * Pull a token out of a file body. A raw token is the documented shape (that is
 * what `~/.commonly/bin/<account>-token` holds today); JSON is tolerated because
 * the CLI's own token files are JSON, and a caller that reaches for one should
 * get a named answer rather than a confusing 401.
 */
export const extractToken = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    for (const field of TOKEN_FIELDS) {
      const value = parsed?.[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }
  return text.replace(/^Bearer\s+/i, '').trim() || null;
};

/**
 * Read the operator's token. Every failure here is a refusal with the PATH in
 * it — never the token, and never a hint to run `commonly login`, which would
 * point the account back at the saved login this command exists to avoid.
 */
export const readInboxToken = (filePath) => {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new InboxRefusal(
      `Cannot read the token file ${filePath} (${err?.code || err?.message}).`,
    );
  }
  const token = extractToken(raw);
  if (!token) {
    throw new InboxRefusal(
      `No token in ${filePath}. Expected a raw token, or JSON carrying one of: ${TOKEN_FIELDS.join(', ')}.`,
    );
  }
  if (token.startsWith('cm_agent_')) {
    throw new InboxRefusal(
      `${filePath} holds an AGENT runtime token (cm_agent_…). This command reads a HUMAN account's own queue; `
      + 'agent attention arrives as runtime events, not here. Pass that account\'s own token file.',
    );
  }
  return token;
};

/** `--since` / a cursor file holds an ISO-8601 timestamp; null means "everything". */
export const parseCursor = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) {
    throw new InboxRefusal(`Not an ISO-8601 timestamp: ${value}`);
  }
  return ms;
};

/** A missing cursor file is "nothing seen yet", not an error. */
export const readCursorFile = (filePath) => {
  if (!filePath) return null;
  try {
    return readFileSync(filePath, 'utf8').trim() || null;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new InboxRefusal(`Cannot read the cursor file ${filePath} (${err?.code || err?.message}).`);
  }
};

/**
 * Written temp-then-rename so a watcher reading this file mid-write sees either
 * the previous cursor or the new one, never a half line. A failed write must not
 * fail the run whose items were already printed, so the caller decides.
 */
export const writeCursorFile = (filePath, cursor) => {
  if (!filePath || !cursor) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${cursor}\n`, 'utf8');
  renameSync(tmp, filePath);
};

export const itemCreatedAtMs = (item) => {
  const ms = Date.parse(String(item?.createdAt ?? ''));
  return Number.isFinite(ms) ? ms : null;
};

/**
 * An item with an unparseable `createdAt` is KEPT under a cursor: dropping it
 * would lose the row silently, and re-printing is the recoverable error.
 */
export const filterItems = (items, { kind = null, sinceMs = null } = {}) => (items || [])
  .filter((item) => {
    if (kind && item?.kind !== kind) return false;
    if (sinceMs === null) return true;
    const ms = itemCreatedAtMs(item);
    return ms === null ? true : ms > sinceMs;
  });

/** Newest timestamp delivered, so the next call resumes exactly where this one ended. */
export const nextCursorFrom = (items, fallback = null) => {
  let max = null;
  for (const item of items || []) {
    const ms = itemCreatedAtMs(item);
    if (ms === null) continue;
    if (max === null || ms > max) max = ms;
  }
  return max === null ? fallback : new Date(max).toISOString();
};

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export const formatItemLine = (item) => {
  const id = String(item?.attentionItemId || item?.id || '?');
  const source = String(item?.id || '');
  const sourceLabel = source && source !== id ? ` source=${source}` : '';
  const detail = oneLine(item?.title || item?.detail || '').slice(0, DETAIL_CHARS);
  const pod = oneLine(item?.podName || item?.podId || '');
  const actor = item?.actorName ? ` — ${oneLine(item.actorName)}` : '';
  return `${String(item?.kind || '?').padEnd(8)} item=${id}${sourceLabel} [${pod}] ${detail}${actor}`;
};

export const countsLine = (countsByKind = {}) => {
  const parts = Object.entries(countsByKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind} ${count}`);
  return parts.join(', ');
};

/**
 * Never echo the token back, whatever the server decides to say — but only when
 * there is something distinctive to remove. A needle that short shreds the
 * message it is meant to clean: with a one-character token, "Attention item not
 * found" loses every `t` and reads as a different error. Real tokens are JWTs or
 * `cm_*` strings, so the floor is far below anything real and still above any
 * string that could appear inside an ordinary sentence.
 */
export const MIN_SCRUB_CHARS = 16;

export const createScrubber = (token) => {
  const needle = typeof token === 'string' && token.length >= MIN_SCRUB_CHARS ? token : '';
  return (value) => {
    const text = String(value ?? '');
    return needle ? text.split(needle).join('[redacted]') : text;
  };
};

/**
 * The `/api/activity` limiter answers 429 with `{code:'rate_limited'}` and
 * `Retry-After` (it sets `standardHeaders`). A read that pages a 550-item queue
 * is 11 requests against a limit of **60 a minute keyed on the caller's IP**
 * (`backend/routes/activity.ts:43-53`) — shared by every session on one host,
 * including the operator's browser — so a 429 is an ordinary busy signal here,
 * not a fault. Back off and continue; fail only when the budget is still gone
 * after the retries.
 */
export const MAX_RATE_LIMIT_RETRIES = 2;
export const DEFAULT_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 60_000;

export const retryDelayMs = (response, fallback = DEFAULT_BACKOFF_MS) => {
  const header = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1_000, MAX_BACKOFF_MS);
  return fallback;
};

/**
 * Minimal request layer, deliberately NOT `lib/api.js`'s `createClient`.
 * That client answers a 401 with "run `commonly login`", which is the one
 * instruction this command must never give: the token here comes from a file
 * that `login` does not write. `fetchImpl` is injectable so the identity rule
 * is testable without a server.
 */
export const createInboxRequest = ({
  baseUrl, token, tokenFile, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) => {
  const scrub = createScrubber(token);
  return async (path, { method = 'GET', params = {}, body } = {}) => {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; ; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'commonly-cli/0.1',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text };
      }
      if (res.ok) return parsed;
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelayMs(res));
        continue;
      }
      const detail = parsed?.error || parsed?.message || parsed?.msg || parsed?.code || `HTTP ${res.status}`;
      const hint = res.status === 401
        ? ` — the token in ${tokenFile} was rejected. This command never uses the saved login.`
        : res.status === 429
          ? ' — the /api/activity rate limit (60 a minute, keyed on the caller IP, so every session on this host shares it). Wait and retry; one page per 50 items is already the minimum this read can make.'
          : '';
      throw new InboxRequestError(scrub(`${detail}${hint}`), res.status);
    }
  };
};

/**
 * Page the queue through `hasMore`. Two independent stops, because a server
 * that reports `hasMore: true` beside an empty page would otherwise spin
 * forever, and one that lies about `count` would page past the end.
 */
export const fetchQueue = async (request, { podId } = {}) => {
  const items = [];
  let meta = {};
  let offset = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await request('/api/activity/decision-queue', {
      params: { limit: API_PAGE_LIMIT, offset, ...(podId ? { podId } : {}) },
    });
    const batch = Array.isArray(page?.items) ? page.items : [];
    items.push(...batch);
    meta = page || {};
    if (!meta.hasMore) break;
    if (batch.length === 0) break;
    if (Number.isInteger(meta.count) && items.length >= meta.count) break;
    offset += batch.length;
  }
  return { items, meta };
};

export const resolveAccountLabel = (user) => String(
  user?.username || user?.email || user?._id || 'unknown',
);

export const formatAccountLine = ({ account, baseUrl }) => `account: ${account} @ ${baseUrl}`;
