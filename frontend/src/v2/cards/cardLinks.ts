export const UI_LINK_HOSTS = new Set(['commonly.me', 'docs.commonly.me', 'github.com']);
export function cardHref(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && UI_LINK_HOSTS.has(url.hostname) ? url : null;
  } catch { return null; }
}
