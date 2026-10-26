/**
 * Who counts as a human, and why it takes TWO signals.
 *
 * Not every bot User row carries botMetadata.agentName. Rows created by the
 * gateway bridge, the summarizer, and several openclaw install paths set
 * botMetadata WITHOUT an agentName key. A filter keyed only on agentName
 * therefore passes them as humans — on the dev instance that was 8 rows
 * (clawdbot-bridge, commonly-summarizer, openclaw-inst-*, socialpulse-*),
 * inflating totalUsers/DAU/WAU/signups ~10% and deflating every funnel rate,
 * because a bot in the denominator can never convert.
 *
 * These two are exact logical complements (De Morgan) — keep them that way.
 * Anything counted as a human here must NOT be counted as a bot there, or the
 * "distinct human posters" metric double-subtracts.
 *
 * This module exists so there is ONE definition. The pair previously lived
 * inline in routes/admin/analytics.ts; the onboarding-silence alert needs the
 * identical split, and a second copy of a rule this subtle drifts from the
 * first — a filter keyed on naming convention rather than on these two fields
 * is what produced the `scott@agents.commonly.local` false alarm on
 * 2026-08-14. Import it; do not restate it.
 */
import { escapeRegExp } from '../utils/escapeRegExp';

export const HUMAN_FILTER = {
  isBot: { $ne: true },
  'botMetadata.agentName': { $exists: false },
} as const;

export const BOT_FILTER = {
  $or: [
    { isBot: true },
    { 'botMetadata.agentName': { $exists: true } },
  ],
} as const;

/**
 * Accounts that are ours, not an outside person's: the team's operator and QA
 * accounts. A filter for "real people" (the onboarding-silence alert pages a
 * human about them) excludes these; HUMAN_FILTER alone does not, because these
 * are human accounts.
 *
 * Built in, for every instance:
 * - admins;
 * - email addresses on a domain RFC 2606/6761 reserves (`.invalid`, `.test`,
 *   `.example`, `.localhost`, `example.com/.net/.org`). No real person has an
 *   address there, and that is where test and operator accounts live: on the
 *   commonly.me instance all four ops accounts and most QA accounts use
 *   `ops.commonly.invalid`, the rest `example.com` (measured 2026-10-21).
 *
 * Per instance, `INTERNAL_ACCOUNTS` (comma separated, case-insensitive):
 * `name` is a username, `prefix*` a username prefix, `@domain` an email domain
 * (subdomains included). It names people, so it comes from the deployment's
 * secret store, never from a committed file.
 */
const RESERVED_EMAIL_DOMAIN_RE = /@(?:[^@\s]+\.)?(?:invalid|test|example|localhost|example\.(?:com|net|org))$/i;


export const parseInternalAccounts = (raw: string | undefined) => {
  const usernames: string[] = [];
  const prefixes: string[] = [];
  const domains: string[] = [];
  String(raw || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean).forEach((entry) => {
    if (entry.startsWith('@')) {
      if (entry.length > 1) domains.push(entry.slice(1));
    } else if (entry.endsWith('*')) {
      if (entry.length > 1) prefixes.push(entry.slice(0, -1));
    } else {
      usernames.push(entry);
    }
  });
  return { usernames, prefixes, domains };
};

/** A Mongo filter fragment that leaves out internal accounts; spread it beside HUMAN_FILTER. */
export const internalAccountExclusion = (env: NodeJS.ProcessEnv = process.env) => {
  const { usernames, prefixes, domains } = parseInternalAccounts(env.INTERNAL_ACCOUNTS);
  const internal: Record<string, unknown>[] = [
    { role: 'admin' },
    { email: { $regex: RESERVED_EMAIL_DOMAIN_RE } },
  ];
  if (usernames.length) {
    internal.push({ username: { $regex: new RegExp(`^(?:${usernames.map(escapeRegExp).join('|')})$`, 'i') } });
  }
  if (prefixes.length) {
    internal.push({ username: { $regex: new RegExp(`^(?:${prefixes.map(escapeRegExp).join('|')})`, 'i') } });
  }
  if (domains.length) {
    internal.push({ email: { $regex: new RegExp(`@(?:[^@\\s]+\\.)?(?:${domains.map(escapeRegExp).join('|')})$`, 'i') } });
  }
  return { $nor: internal };
};

// CJS compat: these are consumed from both `import` and `require()` call sites.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports; Object.assign(module.exports, exports);
