// A first-touch ref code: the ?ref= on the link that first brought someone to
// Commonly (frontend/src/v2/utils/firstTouch.ts), kept so a signup can say
// where it came from (onboarding.signupRef). Only a short plain code is kept,
// so nothing typed into a URL reaches the database as anything else.
const SIGNUP_REF_PATTERN = /^[a-z0-9_-]{1,32}$/;

const cleanSignupRef = (raw: unknown): string | undefined => {
  const ref = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return SIGNUP_REF_PATTERN.test(ref) ? ref : undefined;
};

module.exports = { SIGNUP_REF_PATTERN, cleanSignupRef };

export {};
