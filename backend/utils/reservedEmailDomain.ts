/**
 * Top-level domains reserved by RFC 2606 (and RFC 6761 for .localhost): no
 * mail sent to them can ever be delivered. Our QA and operator accounts use
 * them on purpose (e.g. `@ops.commonly.invalid`), and some of those accounts
 * are verified, so a verified-address check alone lets a send through.
 *
 * Sending anyway buys nothing but a bounce against the sender's reputation,
 * which is shared with every real person's email. The first real digest run
 * (2026-10-17 06:01Z) sent one of its three emails to such an address.
 *
 * Matched on the last label only, so `invalid.com` or `user@test-co.io` is an
 * ordinary domain. The reserved second-level names (example.com/.net/.org) are
 * not listed here: they are a separate RFC 2606 rule, and widening to them is
 * a decision of its own.
 */
const RESERVED_TOP_LEVEL_DOMAINS = new Set(['invalid', 'test', 'example', 'localhost']);

export const isReservedEmailDomain = (email: unknown): boolean => {
  const address = String(email || '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  // Any run of trailing dots and any stray whitespace go first (sprint-review on
  // #2298): `a@invalid..` and `a@ invalid` must not fail open. Registration
  // does not validate the address's format, so such a row can be stored.
  const labels = address.slice(at + 1).replace(/\.+$/, '').split('.').map((label) => label.trim());
  return RESERVED_TOP_LEVEL_DOMAINS.has(labels[labels.length - 1]);
};

export default isReservedEmailDomain;
