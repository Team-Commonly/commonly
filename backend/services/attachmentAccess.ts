/**
 * Attachment access — signed short-TTL tokens + ACL check (ADR-002 Phase 1b).
 *
 * The GET `/api/uploads/:fileName` route has historically been public-read: any
 * process holding (or guessing) a fileName can fetch the bytes. Phase 1b closes
 * that gap without breaking every `<img src>` in the app, because browsers
 * cannot attach `Authorization` headers to plain image requests. The shape:
 *
 * 1. Frontend calls `GET /api/uploads/:fileName/url` (bearer-auth'd) to mint a
 *    short-TTL token scoped to `(fileName, viewerUserId)`.
 * 2. The route does a per-request ACL check — the viewer must own the file,
 *    have it as a profile picture, or be able to read a referencing post or
 *    message — before signing. Failures return 403; no token is minted.
 * 3. Frontend renders `<img src="/api/uploads/:fileName?t=<token>">`. The GET
 *    route accepts `?t=` alongside the existing header-auth path.
 *
 * Phase 1 references are URL substrings in free-text fields (`Post.content`,
 * `Post.image`, PG `messages.content`, `User.profilePicture`). ADR-002 flags
 * this as a deliberate slow scan; Phase 2's structured `attachments` model
 * replaces the scans with indexed lookups.
 */

import jwt, { type JwtPayload } from 'jsonwebtoken';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const File = require('../models/File');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Post = require('../models/Post');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');

const TOKEN_PURPOSE = 'upload';
export const DEFAULT_TOKEN_TTL_SECONDS = 300; // 5 min per ADR-002 Phase 1b.

interface AttachmentTokenPayload extends JwtPayload {
  pur: typeof TOKEN_PURPOSE;
  fn: string; // fileName
  uid: string; // viewer userId
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

/** Mint a short-TTL token scoped to this `(fileName, userId)` pair. */
export function signAttachmentToken(
  fileName: string,
  userId: string,
  ttlSeconds: number = DEFAULT_TOKEN_TTL_SECONDS,
): string {
  const payload: AttachmentTokenPayload = { pur: TOKEN_PURPOSE, fn: fileName, uid: userId };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: ttlSeconds });
}

/**
 * Verify a token and confirm it was minted for this `fileName`. Returns the
 * viewer's `userId` on success, or `null` if the token is invalid, expired, or
 * bound to a different fileName. Callers treat null as "fall through to other
 * auth paths," not "hard reject" — header-auth may still succeed.
 */
export function verifyAttachmentToken(
  token: string,
  fileName: string,
): { userId: string } | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as AttachmentTokenPayload;
    if (decoded.pur !== TOKEN_PURPOSE) return null;
    if (decoded.fn !== fileName) return null;
    if (!decoded.uid) return null;
    return { userId: decoded.uid };
  } catch {
    return null;
  }
}

/**
 * Does `userId` have read access to `fileName`?
 *
 * Phase 1b is intentionally permissive across four surfaces, matching where
 * upload URLs land today:
 *  - owner: the uploader can always read their own file;
 *  - profile pictures: any authenticated user can view any user's avatar
 *    (same as current behavior — avatars are rendered in public post feeds);
 *  - posts: if `Post.image` or `Post.content` references the fileName, the
 *    viewer must be able to read that post (pod member for pod-scoped posts;
 *    any authenticated user for public/global posts);
 *  - messages: if a PG `messages.content` references the fileName, the viewer
 *    must be a member of the pod that message belongs to.
 *
 * Returns true on first match. Returns false only if no surface grants access.
 */
export async function canReadAttachment(
  fileName: string,
  userId: string,
): Promise<boolean> {
  if (!fileName || !userId) return false;
  // fileName comes from a URL param, so it's user-controlled. The POST route
  // generates these as `<timestamp>-<random><ext>`; anything outside that
  // shape isn't one of our files and can't be authorized. This also guards
  // the regex/LIKE substring searches below against ReDoS and wildcard abuse.
  if (!isPlausibleFileName(fileName)) return false;

  const fileDoc = await File.findByFileName(fileName);
  if (fileDoc?.uploadedBy && String(fileDoc.uploadedBy) === String(userId)) return true;

  // Pod-scoped read grant: a file uploaded into a pod (File.podId set) is
  // visible to that pod's members. This is the cheap path for chat / inspector
  // file artifacts — `canReadAttachment` doesn't have to grep the v2 upload
  // directive `[[upload:<fileName>|…]]` out of message bodies because the
  // pod scope is already declared at upload time.
  if (fileDoc?.podId) {
    const member = await Pod.findOne({ _id: fileDoc.podId, members: userId })
      .select('_id')
      .lean();
    if (member) return true;
  }

  const urlFragment = `/api/uploads/${fileName}`;
  const urlRegex = escapeRegex(urlFragment);

  // Profile pictures are stored with varying shapes: relative `/api/uploads/<f>`,
  // absolute `https://api-dev.commonly.me/api/uploads/<f>`, or older
  // `http://...` forms. A substring match on the URL fragment catches all of
  // them without needing a write-time normalization migration.
  const profileUser = await User.findOne({
    profilePicture: { $regex: urlRegex },
  })
    .select('_id')
    .lean();
  if (profileUser) return true;

  // Fan-out over referencing posts. `findOne` would arbitrarily pick one — if
  // it picked a pod-scoped post the viewer can't see, a separate public post
  // granting access would be missed. Fetching a bounded batch and checking
  // membership against every scoped podId is both correct and O(2 queries).
  const posts = await Post.find({
    $or: [
      { image: urlFragment },
      { image: fileName },
      { content: { $regex: urlRegex } },
    ],
  })
    .select('_id podId')
    .limit(POST_SCAN_LIMIT)
    .lean();
  if (posts.length > 0) {
    if (posts.some((p: { podId?: unknown }) => !p.podId)) return true;
    const scopedPodIds = posts
      .map((p: { podId?: unknown }) => p.podId)
      .filter(Boolean);
    if (scopedPodIds.length > 0) {
      const member = await Pod.findOne({ _id: { $in: scopedPodIds }, members: userId })
        .select('_id')
        .lean();
      if (member) return true;
    }
  }

  const messagePodIds = await findMessagePodsReferencingFile(urlFragment);
  if (messagePodIds.length > 0) {
    const member = await Pod.findOne({ _id: { $in: messagePodIds }, members: userId })
      .select('_id')
      .lean();
    if (member) return true;
  }

  return false;
}

const POST_SCAN_LIMIT = 20;
const MESSAGE_SCAN_LIMIT = 20;

// POST route generates `<digits>-<digits><ext>`. A permissive-but-bounded
// pattern is enough to reject obvious abuse (regex metachars, path traversal,
// excess length) without tightly coupling to the generator.
const PLAUSIBLE_FILENAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
function isPlausibleFileName(fileName: string): boolean {
  return PLAUSIBLE_FILENAME_RE.test(fileName);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PG scan for messages whose `content` references `urlFragment` (the full
 * `/api/uploads/<fileName>` path — narrower and ReDoS-free vs. scanning on
 * the bare fileName). Returns all distinct `pod_id`s (up to a bound) that
 * reference the file, so the caller can check pod membership against the
 * whole set in one query — picking a single pod with `LIMIT 1` could return
 * a pod the viewer isn't in, even when a different referencing pod would
 * grant access. Returns `[]` when no match exists or the PG pool is
 * unavailable.
 */
async function findMessagePodsReferencingFile(urlFragment: string): Promise<string[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg') as {
      pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ pod_id: string }> }> };
    };
    if (!pool?.query) return [];
    const needle = `%${urlFragment}%`;
    const { rows } = await pool.query(
      'SELECT DISTINCT pod_id FROM messages WHERE content ILIKE $1 LIMIT $2',
      [needle, MESSAGE_SCAN_LIMIT],
    );
    return rows.map((r) => r.pod_id).filter(Boolean);
  } catch {
    return [];
  }
}
