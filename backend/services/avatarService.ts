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
