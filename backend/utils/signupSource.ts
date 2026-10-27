const { cleanSignupRef } = require('./signupRef');

export interface SignupTouch {
  ref?: string;
  referrer?: string;
  landingPath?: string;
  firstSeenAt?: Date;
}

// Keep this rule aligned with frontend/public/signup-source.js. The backend is
// the trust boundary, including for a browser with an older stored touch.
function hasCapabilityPath(pathname: string): boolean {
  let decoded = pathname;
  for (let i = 0; i < 3 && decoded.includes('%'); i += 1) decoded = decodeURIComponent(decoded);
  // Fail closed on malformed or deeper escaping; decodeURIComponent throws on
  // malformed escapes and the caller drops the optional path.
  if (decoded.includes('%')) return true;
  const segments = decoded.split('/');
  return segments.some((segment, i) => (
    (segment.toLowerCase() === 'invite' && i < segments.length - 1)
    || /^[a-f0-9]{24,}$/i.test(segment)
    || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(segment)
    || (segment.length >= 32 && /^[a-z0-9_.~+=-]+$/i.test(segment) && /[A-Z0-9_.~+=]/.test(segment))
  ));
}

// Attribution is browser-reported, not authorization. Drop unknown fields and
// URL queries/fragments before either the temporary OAuth state or User sees it.
export function cleanSignupTouch(raw: unknown, legacyRef?: unknown): SignupTouch {
  let input: Record<string, unknown> = {};
  try {
    const value = typeof raw === 'string' && raw.length <= 4096 ? JSON.parse(raw) : raw;
    if (value && typeof value === 'object' && !Array.isArray(value)) input = value;
  } catch { /* malformed optional attribution does not prevent signup */ }
  const result: SignupTouch = {};
  const ref = cleanSignupRef(input.ref) || (!input.landingPath ? cleanSignupRef(legacyRef) : undefined);
  if (ref) result.ref = ref;
  if (typeof input.referrer === 'string' && input.referrer.length <= 2048) {
    try {
      const url = new URL(input.referrer);
      if (['https:', 'http:'].includes(url.protocol) && url.origin.length <= 256) result.referrer = url.origin;
    } catch { /* no valid referrer */ }
  }
  if (typeof input.landingPath === 'string' && input.landingPath.length <= 2048) {
    try {
      const url = new URL(input.landingPath, 'https://landing.invalid');
      if (input.landingPath.startsWith('/') && url.origin === 'https://landing.invalid'
        && !url.pathname.startsWith('//') && !hasCapabilityPath(url.pathname)) result.landingPath = url.pathname;
    } catch { /* no valid path */ }
  }
  const seen = input.firstSeenAt instanceof Date ? input.firstSeenAt
    : typeof input.firstSeenAt === 'string' && input.firstSeenAt.length <= 32
      ? new Date(input.firstSeenAt) : undefined;
  if (seen && Number.isFinite(seen.getTime()) && seen.getTime() <= Date.now()) {
    result.firstSeenAt = seen;
  }
  return result;
}

/** Called only in new-account constructors, never in login/link/update paths. */
export function signupSourceFields(raw: unknown, authMethod: 'password' | 'google' | 'github', legacyRef?: unknown) {
  const touch = cleanSignupTouch(raw, legacyRef);
  return {
    signupSource: { ...touch, authMethod, recordedAt: new Date() },
    ...(touch.ref ? { onboarding: { signupRef: touch.ref } } : {}),
  };
}
