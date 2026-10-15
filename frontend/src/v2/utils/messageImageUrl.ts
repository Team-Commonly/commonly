import getApiBaseUrl, { normalizeUploadUrl } from '../../utils/apiBaseUrl';

// Message prose is untrusted. Only an upload served by this instance may become
// an image request; external image URLs remain links in the transcript.
export const messageImageUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const api = new URL(getApiBaseUrl());
    const normalized = value.startsWith('/api/uploads/') || value.startsWith('/uploads/')
      ? new URL(value, api).toString()
      : normalizeUploadUrl(value);
    if (!normalized) return null;
    const image = new URL(normalized);
    if (image.origin !== api.origin || !['http:', 'https:'].includes(image.protocol)) return null;
    if (image.username || image.password) return null;
    if (!/^\/(?:api\/)?uploads\/[^/]/.test(image.pathname)) return null;
    return image.toString();
  } catch (_error) {
    return null;
  }
};
