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

// CJS compat: these are consumed from both `import` and `require()` call sites.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports; Object.assign(module.exports, exports);
