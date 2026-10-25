/**
 * First-touch attribution: the ref code of the link that first brought this
 * browser to Commonly (?ref=x on any page). It is kept once, and signup sends it
 * so the new account records where it came from (onboarding.signupRef); the
 * first arrival also counts one visit for that ref (POST /api/attribution/visit).
 *
 * Codes are short and plain: letters, digits, '-' and '_', at most 32, the same
 * rule as backend/utils/signupRef.ts. Storage can be missing (a private window,
 * blocked site data), so every read and write is guarded, and a missing value
 * just means "no ref".
 */
const KEY = 'commonly.firstTouchRef';

/** Captured by /signup-source.js on the first public page, including static guides. */
export const readFirstTouchSource = (): Record<string, unknown> | undefined => {
  try {
    const raw = window.localStorage.getItem('commonly.signupSource.v1');
    if (!raw || raw.length > 4096) return undefined;
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    // The server sanitizes these untrusted values. Never forward arbitrary keys.
    return { ref: value.ref, referrer: value.referrer, landingPath: value.landingPath, firstSeenAt: value.firstSeenAt };
  } catch { return undefined; }
};
// The same rule as backend/utils/signupRef.ts (SIGNUP_REF_PATTERN,
// RESERVED_REFS); change both together. The backend is the gate.
const REF_PATTERN = /^[a-z0-9_-]{1,32}$/;
const RESERVED_REFS = new Set(['__proto__', 'constructor', 'prototype']);

export const cleanRef = (raw: unknown): string | null => {
  const ref = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return REF_PATTERN.test(ref) && !RESERVED_REFS.has(ref) ? ref : null;
};

/** Keeps the first valid ?ref= this browser arrives with. Returns it only when this call kept it. */
export const captureFirstTouchRef = (search: string): string | null => {
  const ref = cleanRef(new URLSearchParams(search).get('ref'));
  if (!ref) return null;
  try {
    if (window.localStorage.getItem(KEY)) return null;
    window.localStorage.setItem(KEY, JSON.stringify({ ref, at: new Date().toISOString() }));
    return ref;
  } catch {
    return null;
  }
};

/** The kept first-touch ref, or undefined. */
export const readFirstTouchRef = (): string | undefined => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) || 'null') as { ref?: unknown } | null;
    return cleanRef(stored?.ref) || undefined;
  } catch {
    return undefined;
  }
};
