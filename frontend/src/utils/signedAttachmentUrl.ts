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

interface CacheEntry {
  url: string;
  expiresAtMs: number;
}

const cache: Map<string, CacheEntry> = new Map();
const inflight: Map<string, Promise<string | null>> = new Map();

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
  if (!data.url) return null;

  const expiresInSec = typeof data.expiresIn === 'number' ? data.expiresIn : TOKEN_TTL_SECONDS;
  const fullUrl = data.url.startsWith('http') ? data.url : `${apiBase}${data.url}`;
  cache.set(fileName, { url: fullUrl, expiresAtMs: Date.now() + expiresInSec * 1000 });
  return fullUrl;
}

/**
 * Returns a signed, absolute URL for the given upload path. Returns `null`
 * if the caller is unauthenticated or the mint request fails. Callers should
 * fall back to the raw normalized URL in that case (Phase 1b still allows
 * public reads; the fallback path gracefully degrades during rollout).
 *
 * Accepts either a relative `/api/uploads/<name>` path or an absolute URL
 * that contains `/api/uploads/<name>`. Values without that segment are
 * returned unchanged.
 */
export async function getSignedAttachmentUrl(uploadPath: string | null | undefined): Promise<string | null> {
  if (!uploadPath || typeof uploadPath !== 'string') return null;
  const fileName = extractFileName(uploadPath);
  if (!fileName) return uploadPath;

  const cached = cache.get(fileName);
  if (cacheIsFresh(cached, Date.now())) return cached!.url;

  const existing = inflight.get(fileName);
  if (existing) return existing;

  const p = mintSignedUrl(fileName).finally(() => {
    inflight.delete(fileName);
  });
  inflight.set(fileName, p);
  return p;
}

/** Test-only: clear the in-memory cache between cases. */
export function __resetSignedAttachmentUrlCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
