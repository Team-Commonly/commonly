import getApiBaseUrl, { getApiAliasUrl, normalizeUploadUrl } from './apiBaseUrl';

// Message prose is untrusted. Only an upload served by this instance may become
// an image request; external image URLs remain links in the transcript.
//
// The instance serves uploads from two origins in a same-origin build: the
// shell's API base and the API's own host (getApiAliasUrl). Agents write the
// API's own host (their COMMONLY_API_URL), and so do older messages, so an
// absolute upload URL on it must still render as an image. Without an alias the
// two are the same origin.
const instanceOrigins = (): string[] => Array.from(new Set(
  [getApiBaseUrl(), getApiAliasUrl()].map((url) => new URL(url).origin),
));

export const messageImageUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const api = new URL(getApiBaseUrl());
    const normalized = value.startsWith('/api/uploads/') || value.startsWith('/uploads/')
      ? new URL(value, api).toString()
      : normalizeUploadUrl(value);
    if (!normalized) return null;
    const image = new URL(normalized);
    if (!instanceOrigins().includes(image.origin) || !['http:', 'https:'].includes(image.protocol)) return null;
    if (image.username || image.password) return null;
    if (!/^\/(?:api\/)?uploads\/[^/]/.test(image.pathname)) return null;
    return image.toString();
  } catch (_error) {
    return null;
  }
};
