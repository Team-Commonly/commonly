// Outbound base URLs come from a list the operator configured. A value that
// arrives in a write (a request body, a stored setting) only SELECTS an entry
// from that list: `selectAllowedBaseUrl` compares the normalized value with
// each normalized entry and returns the ENTRY, never the input, so the URL a
// request is built on is the operator's, byte for byte (review-checklist rule
// 54, "validate the value you use").

// Scheme, host (lower-cased by URL, port included) and path without trailing
// slashes. A URL carrying userinfo never matches: it is not the URL the
// operator wrote.
const normalize = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
};

// A comma-separated env list, blanks dropped. An unset variable is an empty
// list, so an allowlist widens only when an operator writes it down.
export const allowedFromEnv = (name: string): string[] => String(process.env[name] || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

// The allowlist entry the request names, without trailing slashes (callers
// append `/path`), or null when it names none. A blank request is null too,
// so each caller decides its own default rather than this module guessing.
export const selectAllowedBaseUrl = (
  requested: unknown,
  allowed: ReadonlyArray<string | null | undefined>,
): string | null => {
  const want = normalize(requested);
  if (!want) return null;
  const entry = allowed.find((candidate) => normalize(candidate) === want);
  return entry ? entry.trim().replace(/\/+$/, '') : null;
};

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { allowedFromEnv, selectAllowedBaseUrl };
