/**
 * Signed-URL helper for attachment images (ADR-002 Phase 1b).
 *
 * Browsers cannot attach `Authorization` headers to `<img src>`, so we can't
 * auth image requests with the normal bearer flow. Instead the frontend asks
 * the backend for a short-TTL signed URL that includes a `?t=<token>` query
 * param; the backend ACL-checks once at mint time and trusts the token for
 * subsequent GETs within its 5-minute TTL.
 *
 * This module is the render-time bridge. Callers pass an upload URL (either a
 * relative `/api/uploads/...` path or an absolute API URL) and get back an
 * absolute URL with the signed token appended. Results are cached per file
 * name until shortly before the token expires so a page with dozens of images
 * only mints a small number of tokens.
 *
 * The helper is used opt-in today — the public-read fallback on `GET /api/
 * uploads/:fileName` still serves unauthed requests. When the follow-up PR
 * flips the switch to require auth on GET, any call site not using this
 * helper breaks. Call-site migration (avatars, post images, chat images,
 * etc.) happens in that PR alongside the flip.
 */

import getApiBaseUrl from './apiBaseUrl';

const TOKEN_TTL_SECONDS = 300; // Matches backend DEFAULT_TOKEN_TTL_SECONDS.
const CACHE_SKEW_SECONDS = 30; // Refresh ~30s before expiry to avoid races.
// Bound the cache so a long-lived SPA scrolling through many feeds doesn't
// grow memory unboundedly. JS `Map` preserves insertion order, so evicting
// `keys().next().value` gives FIFO eviction — good enough for a TTL-bounded
// cache where entries self-expire in 5 min anyway.
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  url: string;
  expiresAtMs: number;
}

const cache: Map<string, CacheEntry> = new Map();
const inflight: Map<string, Promise<string | null>> = new Map();

function setCache(fileName: string, entry: CacheEntry): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(fileName)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(fileName, entry);
}

function extractFileName(uploadPath: string): string | null {
  const match = uploadPath.match(/\/api\/uploads\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function cacheIsFresh(entry: CacheEntry | undefined, nowMs: number): boolean {
  if (!entry) return false;
  return entry.expiresAtMs - CACHE_SKEW_SECONDS * 1000 > nowMs;
}

async function mintSignedUrl(fileName: string): Promise<string | null> {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
  if (!token) return null;

  const apiBase = getApiBaseUrl();
  const res = await fetch(`${apiBase}/api/uploads/${encodeURIComponent(fileName)}/url`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { url?: string; expiresIn?: number };
  return storeMinted(fileName, data.url, data.expiresIn, apiBase);
}

// ---- Batching ----
// A pod chat draws one thumbnail per image message, and each asks for its URL in
// the same render. One mint per thumbnail 429'd a viewer with more than 30 images
// on screen (the mint limiter allows 30 a minute per token). So every mint asked
// for in one tick is collected and sent as ONE `POST /api/uploads/urls` (at most
// BATCH_MAX names, which the server counts once against the same budget). A tick
// with a single name keeps the single route. A server without the batch route
// (404/405, an older backend during a rollout) gets one request per name.
const BATCH_MAX = 50; // Matches backend BATCH_MINT_MAX.

interface Waiter {
  resolve: (url: string | null) => void;
  reject: (err: unknown) => void;
}

const queued: Map<string, Waiter> = new Map();
let flushScheduled = false;

function storeMinted(fileName: string, url: string | undefined, expiresIn: number | undefined, apiBase: string): string | null {
  if (!url) return null;
  const expiresInSec = typeof expiresIn === 'number' ? expiresIn : TOKEN_TTL_SECONDS;
  const fullUrl = url.startsWith('http') ? url : `${apiBase}${url}`;
  setCache(fileName, { url: fullUrl, expiresAtMs: Date.now() + expiresInSec * 1000 });
  return fullUrl;
}

function decodeName(fileName: string): string {
  try { return decodeURIComponent(fileName); } catch { return fileName; }
}

async function mintBatchUnguarded(batch: Map<string, Waiter>): Promise<void> {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
  if (!token) {
    batch.forEach((w) => w.resolve(null));
    return;
  }
  const apiBase = getApiBaseUrl();
  const names = [...batch.keys()];
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/uploads/urls`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileNames: names.map(decodeName) }),
    });
  } catch (err) {
    batch.forEach((w) => w.reject(err));
    return;
  }
  if (res.status === 404 || res.status === 405) {
    batch.forEach((w, fileName) => { mintSignedUrl(fileName).then(w.resolve, w.reject); });
    return;
  }
  if (!res.ok) {
    batch.forEach((w) => w.resolve(null));
    return;
  }
  let data: { urls?: Record<string, { url?: string; expiresIn?: number }> } | null;
  try {
    data = await res.json();
  } catch (err) {
    batch.forEach((w) => w.reject(err));
    return;
  }
  batch.forEach((w, fileName) => {
    const minted = data?.urls?.[decodeName(fileName)];
    w.resolve(storeMinted(fileName, minted?.url, minted?.expiresIn, apiBase));
  });
}

// Every waiter settles, whatever the batch hits: a waiter left pending keeps its
// `inflight` entry, and that file would never mint again this session. A second
// settle on a promise is a no-op, so rejecting all after a partial pass is safe.
async function mintBatch(batch: Map<string, Waiter>): Promise<void> {
  try {
    await mintBatchUnguarded(batch);
  } catch (err) {
    batch.forEach((w) => w.reject(err));
  }
}

function flushQueued(): void {
  flushScheduled = false;
  const all = [...queued.entries()];
  queued.clear();
  if (all.length === 1) {
    const [[fileName, w]] = all;
    mintSignedUrl(fileName).then(w.resolve, w.reject);
    return;
  }
  for (let i = 0; i < all.length; i += BATCH_MAX) {
    void mintBatch(new Map(all.slice(i, i + BATCH_MAX)));
  }
}

function enqueueMint(fileName: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    queued.set(fileName, { resolve, reject });
    if (!flushScheduled) {
      flushScheduled = true;
      // A microtask, so every mint asked for in the same render goes together.
      Promise.resolve().then(flushQueued);
    }
  });
}

/**
 * Returns a signed, absolute URL for the given upload path. Returns `null`
 * if the caller is unauthenticated or the mint request fails. Callers should
 * fall back to the raw normalized URL in that case (Phase 1b still allows
 * public reads; the fallback path gracefully degrades during rollout).
 *
 * Accepts either a relative `/api/uploads/<name>` path or an absolute URL
 * that contains `/api/uploads/<name>`. Values without that segment are
 * returned unchanged. Concurrent calls are batched (see above).
 */
export async function getSignedAttachmentUrl(uploadPath: string | null | undefined): Promise<string | null> {
  if (!uploadPath || typeof uploadPath !== 'string') return null;
  const fileName = extractFileName(uploadPath);
  if (!fileName) return uploadPath;

  const cached = cache.get(fileName);
  if (cacheIsFresh(cached, Date.now())) return cached!.url;

  const existing = inflight.get(fileName);
  if (existing) return existing;

  const p = enqueueMint(fileName).finally(() => {
    inflight.delete(fileName);
  });
  inflight.set(fileName, p);
  return p;
}

/** Test-only: clear the in-memory cache between cases. */
export function __resetSignedAttachmentUrlCacheForTests(): void {
  cache.clear();
  inflight.clear();
  queued.clear();
  flushScheduled = false;
}
