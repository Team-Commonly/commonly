// A first-touch ref code: the ?ref= on the link that first brought someone to
// Commonly (frontend/src/v2/utils/firstTouch.ts), kept so a signup can say
// where it came from (onboarding.signupRef). Only a short plain code is kept,
// so nothing typed into a URL reaches the database as anything else.
// The frontend has its own copy of this rule (REF_PATTERN, RESERVED_REFS in
// firstTouch.ts); change both together. The backend is the gate.
const SIGNUP_REF_PATTERN = /^[a-z0-9_-]{1,32}$/;
// Plain codes that name object internals. A ref is only ever a value today, but
// a rollup that keys an object by ref would turn these into prototype writes.
const RESERVED_REFS = new Set(['__proto__', 'constructor', 'prototype']);

const cleanSignupRef = (raw: unknown): string | undefined => {
  const ref = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return SIGNUP_REF_PATTERN.test(ref) && !RESERVED_REFS.has(ref) ? ref : undefined;
};

module.exports = { SIGNUP_REF_PATTERN, cleanSignupRef };

export {};
