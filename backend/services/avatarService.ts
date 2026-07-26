import User from '../models/User';

type AvatarUser = {
  profilePicture?: string | null;
};

type AvatarUserRow = AvatarUser & {
  _id: unknown;
};

const UPLOAD_PATH = '/api/uploads/';
const LEGACY_COLOR_AVATARS = new Set([
  'red',
  'purple',
  'blue',
  'teal',
  'green',
  'orange',
  'brown',
  'gray',
]);
const UPLOAD_FILE_NAME = /^[^/?#]+\.[a-z0-9]{2,10}$/i;

/**
 * Canonicalize avatar references without coupling them to an instance origin.
 * External absolute URLs are preserved because Commonly cannot safely invent a
 * local object key for them; Commonly upload URLs are always made relative.
 */
export function normalizeAvatarUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;

  const value = String(raw).trim();
  if (!value || value === 'default') return null;
  // Legacy profiles store color choices in profilePicture. Preserve those
  // identifiers for the existing color-avatar renderer; they are not upload
  // object keys and must never become `/api/uploads/blue`.
  if (LEGACY_COLOR_AVATARS.has(value)) return value;
  if (/^data:/i.test(value) || value.startsWith('/')) return value;

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const uploadPathIndex = parsed.pathname.indexOf(UPLOAD_PATH);
      if (uploadPathIndex >= 0) {
        return parsed.pathname.slice(uploadPathIndex);
      }
    } catch {
      return value;
    }
    return value;
  }

  // Older upload responses stored only the object filename. Normalize those,
  // but preserve other opaque legacy identifiers rather than inventing a
  // broken local upload path for them.
  return UPLOAD_FILE_NAME.test(value) ? `${UPLOAD_PATH}${value}` : value;
}

export function resolveAvatarUrl(user: AvatarUser | null | undefined): string | null {
  const normalized = normalizeAvatarUrl(user?.profilePicture);
  if (!normalized || LEGACY_COLOR_AVATARS.has(normalized)) return null;
  return normalized;
}

// Keys that carry an avatar reference anywhere in a serialized payload. Both
// spellings exist because the PG row is snake_case and the Mongo/populated
// shape is camelCase, and several responses carry BOTH for the same user.
const AVATAR_KEYS = new Set(['profilePicture', 'profile_picture']);

/**
 * Remove inline base64 avatars from a payload bound for an agent.
 *
 * Avatars are stored as `data:` URIs on the user row, so every message carries
 * its author's full image bytes — and the same avatar repeats on every message
 * that author has sent. Measured on a real pod, `commonly_get_messages` at the
 * default limit returned 230,170 characters of which 71% was image data: an
 * agent asked to read a busy room exhausts its context on profile pictures
 * before it reaches the conversation (#758).
 *
 * Only `data:` values are dropped. A URL costs nothing and stays useful, so it
 * is preserved — the rule is "no base64 in an agent payload", not "no avatars".
 *
 * Returns a structurally-shared copy; the input is never mutated, because the
 * same message object is reused for the human-facing Socket.io broadcast where
 * the avatar IS rendered.
 */
export function stripInlineAvatars<T>(payload: T): T {
  const seen = new WeakMap<object, unknown>();

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    // Dates, ObjectIds and other non-plain objects must pass through intact.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const cached = seen.get(value as object);
    if (cached !== undefined) return cached;

    const out: Record<string, unknown> = {};
    seen.set(value as object, out);
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (AVATAR_KEYS.has(key) && typeof val === 'string' && /^data:/i.test(val)) continue;
      out[key] = walk(val);
    }
    return out;
  };

  return walk(payload) as T;
}

export async function resolveAvatarUrls(
  userIds: string[],
): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(userIds.map((id) => String(id))));
  const resolved = new Map<string, string | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return resolved;

  const users = await User.find({ _id: { $in: ids } })
    .select('_id profilePicture')
    .lean<AvatarUserRow[]>();

  for (const user of users) {
    resolved.set(String(user._id), resolveAvatarUrl(user));
  }

  return resolved;
}
