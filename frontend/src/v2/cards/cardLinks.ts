export const UI_LINK_HOSTS = new Set([
  'commonly.me', 'docs.commonly.me', 'github.com', 'linear.app', 'sentry.io',
]);
// One suffix rule: a single-label Atlassian Cloud site, e.g. acme.atlassian.net.
const ATLASSIAN_SITE = /^[a-z0-9-]+\.atlassian\.net$/;
export function isCardHost(hostname: string): boolean {
  return UI_LINK_HOSTS.has(hostname) || ATLASSIAN_SITE.test(hostname);
}
export function cardHref(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && isCardHost(url.hostname) ? url : null;
  } catch { return null; }
}
