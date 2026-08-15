/**
 * Copy for the stalled-connect nudge and its resolution (W4 item 3).
 *
 * Pure, for the same reason `composeInstallIntro` is pure: the caller derives
 * liveness through `deriveAgentState` — the single derivation the roster, the
 * #943 install intro and the #891 honesty surface all use — and passes the
 * verdict in. Copy rules stay testable without a database, and there is no
 * second guess about whether an agent is connected.
 *
 * TONE. Flat declarative, no hedge. `never-connected` is structurally certain:
 * no token has ever been used, so "nothing has started me" is a fact, not an
 * inference. That is exactly the distinction #943 had to learn the hard way —
 * a `gone-dark` agent told "nothing is running me yet" was flat-certain AND
 * wrong. This nudge only ever fires on the certain case, which is why it can
 * afford the flat voice. If it is ever extended to gone-dark (deliberately out
 * of v1 scope), the copy must hedge and this comment is the reason.
 *
 * THE FORWARD COMMITMENT IS LOAD-BEARING. "I'll post here the moment it
 * connects" is a promise, and `postResolution` below is how it is kept. Ship
 * one without the other and the nudge becomes the second false promise we made
 * to the same person — the first being the "mention me anytime" intro that
 * #943 removed.
 */

/**
 * Locale is accepted and currently ignored, deliberately and visibly.
 *
 * ux-lead's spec asks for en + zh-CN from day one. There is no mechanism: the
 * language lives in frontend localStorage, never reaches the backend, there is
 * no `User.language` and no server-side i18n layer at all (#715–720 was
 * frontend-only). #943's install intro shipped English-only for the same
 * audience with the same argument available.
 *
 * So the parameter marks the seam rather than pretending it is solved. When a
 * locale signal and a server-side catalogue exist, this is where they attach,
 * and the call sites already thread it through.
 */
export type NudgeLocale = 'en' | 'zh-CN';

export const composeStalledConnectNudge = ({
  installerName, displayName, handle, fixCommand,
}: {
  installerName: string;
  displayName: string;
  handle: string;
  fixCommand: string;
  locale?: NudgeLocale;
}): string =>
  `@${installerName} — I'm installed here, but nothing has ever started me, `
  + `so mentioning @${handle} won't reach anyone yet. `
  + `Run \`${fixCommand}\` on the machine where I should live and I'll come online. `
  + `I'll post here the moment I connect.`;

/**
 * The resolution post, and it is deliberately NOT time-bounded (ux-lead).
 *
 * An unclosed promise is a false promise, so the loop closes whenever it can —
 * six days late is ambient closure, not an interrupt, and landing late is
 * exactly what it should do.
 *
 * The template is compound because a single tense cannot stay honest at
 * arbitrary age: **flat for the past** (a first-connection timestamp is a
 * fact) and **derived for the present** (per the same certainty rule that
 * governs the install intro). That compound is also what dissolves the
 * connect-then-disconnect-within-one-pass case I thought was invisible:
 * `lastUsedAt` leaving null is a PERMANENT transition, so the next pass still
 * sees it and simply reports a different present — "connected at 04:12, not
 * running now" — instead of missing the event.
 */
export const composeStalledConnectResolution = ({
  displayName, handle, firstSeenAt, presentState, fixCommand,
}: {
  displayName: string;
  handle: string;
  /** When the token was first used. A fact — stated flat. */
  firstSeenAt: Date;
  /** `deriveAgentState` verdict at POST time, not at connect time. */
  presentState: string;
  fixCommand: string;
  locale?: NudgeLocale;
}): string => {
  const hhmm = firstSeenAt.toISOString().slice(11, 16);
  const past = `${displayName} connected (first seen ${hhmm} UTC).`;

  // Inferred and currently down: hedge nothing about the past, keep the
  // instruction for the present.
  if (presentState === 'gone-dark') {
    return `${past} It isn't running right now — restart it with \`${fixCommand}\` `
      + `and @${handle} will get through again.`;
  }
  // Certain and down again with no use at all is impossible here (this only
  // fires once the token HAS been used), so anything else is live enough to
  // invite.
  return `${past} Listening now — mention @${handle} and I'll answer.`;
};

export default { composeStalledConnectNudge, composeStalledConnectResolution };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
