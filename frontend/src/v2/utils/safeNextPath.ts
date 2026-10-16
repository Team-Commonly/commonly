/**
 * Where to send someone after they sign in, accepted only as a path on this
 * site. Login carries it from the page that sent them there (ProtectedRoute's
 * location.state.from) or from ?next=, and hands it through OAuth as next, so a
 * deep link such as /v2/agents/byo?mode=hosted survives every sign-in path.
 *
 * A raw "starts with /" check is an open redirect: browsers read //host and
 * /\host as another site. This resolves the value against the current origin
 * and keeps it only if it stays here AND its normalised path is not
 * protocol-relative, returning path + search + hash, or null.
 */
export const safeNextPath = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  // A second slash or a backslash after the first makes it protocol-relative,
  // and control characters can be stripped by the URL parser into one.
  // eslint-disable-next-line no-control-regex
  if (/^\/[/\\]/.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    // Dot segments normalise into a protocol-relative path: /.//host,
    // /x/..//host and /%2e//host all come out as //host. Returned as a string,
    // that would leave the site, so the normalised path is checked as well.
    if (/^\/[/\\]/.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
};

/** The full path (with its query and hash) of a router location, or null. */
export const pathOfLocation = (
  location: { pathname?: string; search?: string; hash?: string } | null | undefined,
): string | null => (location?.pathname
  ? safeNextPath(`${location.pathname}${location.search || ''}${location.hash || ''}`)
  : null);
