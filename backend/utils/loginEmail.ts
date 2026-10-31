/**
 * The address a sign-in is for, or '' when the body carries no string email.
 *
 * Login and its per-address limiter must agree on this. If one coerced a
 * non-string (an array, say) and the other skipped it, a request could sign in
 * as an address without counting against that address's budget.
 */
export const loginEmailOf = (body: { email?: unknown } | undefined): string => (
  typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
);

export default loginEmailOf;
