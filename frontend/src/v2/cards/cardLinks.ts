export const UI_LINK_HOSTS = new Set([
  'commonly.me', 'staging.commonly.me', 'docs.commonly.me', 'github.com', 'linear.app', 'sentry.io',
]);
// Suffix rules: a single-label Atlassian Cloud site (acme.atlassian.net) and a single-label
// Sentry org (my-organization.sentry.io). Nothing deeper.
const SITE_SUFFIX = /^[a-z0-9-]+\.(atlassian\.net|sentry\.io)$/;
export function isCardHost(hostname: string): boolean {
  return UI_LINK_HOSTS.has(hostname) || SITE_SUFFIX.test(hostname);
}
export function cardHref(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && isCardHost(url.hostname) ? url : null;
  } catch { return null; }
}
