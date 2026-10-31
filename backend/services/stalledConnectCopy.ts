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

export type StalledConnectCopyEvidence = {
  /** First setup-command copy for this signup. */
  commandCopiedAt?: Date | string | null;
  /** Fixed enum only; command contents and tokens never enter copy. */
  commandType?: 'mcp' | 'cli' | null;
  /**
   * First copy of each command kind (TASK-721). When either is present they
   * win over the first-copy pair above: only they can say a person copied the
   * MCP snippet and never the Terminal command.
   */
  mcpCopiedAt?: Date | string | null;
  cliCopiedAt?: Date | string | null;
  /** Token issue time for the current stalled episode. */
  tokenIssuedAt?: Date | string | null;
  /** OS the Bring your own page detected on the first open (byoOpenedOs). */
  openedOs?: 'mac' | 'linux' | 'windows' | 'other' | null;
};

/**
 * The listener answers @mentions only on a Mac for now (V2AgentBYO's
 * listenerRunsOn), for a different reason per adapter: Commonly's sandbox
 * cannot run Claude Code on Linux or Windows, and Codex there is not yet
 * tested (agentByo.listen.unavailableClaude / unavailableCodex). The server
 * never learns which adapter the copied command named, so the copy names the
 * listener, not the CLI, and states only what is true for both: Mac only.
 *
 * It hedges, unlike the rest of this file. The page shows the listener command
 * only on its Mac tab, so a copy from a Linux or Windows browser means the
 * person picked Mac there: they may have run it on a Mac, or on the machine
 * they were browsing from. byoOpenedOs is the browser's OS, not where the
 * command ran, so the sentence is conditional on it.
 */
const LISTENER_UNAVAILABLE_OS: Record<string, string> = { linux: 'Linux', windows: 'Windows' };

const copiedAtOffsetSeconds = (evidence: StalledConnectCopyEvidence): number | null => {
  if (!evidence.commandCopiedAt || !evidence.tokenIssuedAt) return null;
  const copiedAt = evidence.commandCopiedAt instanceof Date
    ? evidence.commandCopiedAt
    : new Date(evidence.commandCopiedAt);
  const issuedAt = evidence.tokenIssuedAt instanceof Date
    ? evidence.tokenIssuedAt
    : new Date(evidence.tokenIssuedAt);
  if (Number.isNaN(copiedAt.getTime()) || Number.isNaN(issuedAt.getTime())) return null;
  const seconds = Math.round((copiedAt.getTime() - issuedAt.getTime()) / 1000);
  return seconds >= 0 ? seconds : null;
};

const copiedAtDescription = (offsetSeconds: number): string => {
  if (offsetSeconds < 30) return 'right after you created the seat';
  if (offsetSeconds < 90) return 'about a minute after you created the seat';
  if (offsetSeconds < 10 * 60) return 'a few minutes after you created the seat';
  if (offsetSeconds < 60 * 60) return 'several minutes after you created the seat';
  return 'more than an hour after you created the seat';
};

export const composeStalledConnectNudge = ({
  installerName, displayName, handle, fixCommand, evidence = {},
}: {
  installerName: string;
  displayName: string;
  handle: string;
  fixCommand: string;
  locale?: NudgeLocale;
  evidence?: StalledConnectCopyEvidence;
}): string => {
  // Per-kind copies say which command is missing (TASK-721). A per-kind mark
  // is the FIRST copy of that kind ever, per USER, so it can prove a copy
  // happened but never that none did. Two readings follow:
  //  - `rawTime`: any copy of the kind, on any date. A kind with no raw time at
  //    all was never copied, the only case where "you missed it" is true.
  //  - `inEpisode`: the copy falls at or after this token was issued. Only
  //    that one can be described as part of this setup.
  // A missing or unparseable per-kind time is filled from the older first-copy
  // pair when the pair names the same kind: a copy made before the per-kind
  // marks shipped, or one whose per-kind write failed, must not read as "never".
  const hasKindEvidence = Boolean(evidence.mcpCopiedAt || evidence.cliCopiedAt);
  const issuedMs = evidence.tokenIssuedAt ? new Date(evidence.tokenIssuedAt).getTime() : NaN;
  const parse = (value: Date | string | null | undefined): Date | null => {
    if (!value) return null;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  };
  const kindTimes = (kind: 'mcp' | 'cli'): { rawTime: Date | null; inEpisode: Date | null } => {
    const own = parse(kind === 'mcp' ? evidence.mcpCopiedAt : evidence.cliCopiedAt);
    const fromPair = evidence.commandType === kind ? parse(evidence.commandCopiedAt) : null;
    const rawTime = own || fromPair;
    const inEpisode = rawTime && (Number.isNaN(issuedMs) || rawTime.getTime() >= issuedMs) ? rawTime : null;
    return { rawTime, inEpisode };
  };
  const mcp = hasKindEvidence ? kindTimes('mcp') : { rawTime: null, inEpisode: null };
  const cli = hasKindEvidence ? kindTimes('cli') : { rawTime: null, inEpisode: null };
  const mcpAt = mcp.inEpisode;
  const cliAt = cli.inEpisode;
  // True only when a listener command was never copied at all.
  const mcpOnly = hasKindEvidence && mcpAt !== null && cli.rawTime === null;
  const effective: StalledConnectCopyEvidence = hasKindEvidence
    ? {
      ...evidence,
      commandType: cliAt ? 'cli' : mcpAt ? 'mcp' : null,
      commandCopiedAt: cliAt || mcpAt,
    }
    : evidence;
  const offsetSeconds = copiedAtOffsetSeconds(effective);
  if (mcpOnly && offsetSeconds !== null) {
    const unavailableOs = evidence.openedOs ? LISTENER_UNAVAILABLE_OS[evidence.openedOs] : undefined;
    const when = copiedAtDescription(offsetSeconds);
    if (unavailableOs) {
      // The page offers the listener command on its Mac tab only, so do not
      // tell this person they missed a command their browser never showed.
      return `@${installerName} — you copied the MCP command ${when}. `
        + `MCP-only clients can call Commonly, but they do not answer @mentions. `
        + `The listener that does runs only from a Mac for now, and you first opened this page on ${unavailableOs}. `
        + `Run \`${fixCommand}\` in a Terminal on a Mac, or choose “Run it here” on the Bring your own page for a hosted agent. `
        + `I'll post here the moment I connect.`;
    }
    return `@${installerName} — you copied the MCP command ${when}, but not the listener command that starts me. `
      + `MCP-only clients can call Commonly, but they do not answer @mentions, `
      + `so nothing is listening for @${handle} yet. `
      + `Run \`${fixCommand}\` in a Terminal on the machine where I should live. `
      + `I'll post here the moment I connect.`;
  }
  if (offsetSeconds !== null) {
    const copiedThing = effective.commandType === 'mcp'
      ? 'MCP command'
      : effective.commandType === 'cli' ? 'listener command' : 'command';
    const unavailableOs = effective.commandType === 'cli' && effective.openedOs
      ? LISTENER_UNAVAILABLE_OS[effective.openedOs]
      : undefined;
    if (unavailableOs) {
      return `@${installerName} — you copied the listener command `
        + `${copiedAtDescription(offsetSeconds)}; no connection arrived. `
        + `If you ran it on ${unavailableOs}, that's likely why: the listener answers @mentions `
        + `only from a Mac for now. `
        + `Run \`${fixCommand}\` on a Mac, or choose “Run it here” on the Bring your own page for a hosted agent. `
        + `I'll post here the moment I connect.`;
    }
    return `@${installerName} — you copied the ${copiedThing} `
      + `${copiedAtDescription(offsetSeconds)}; `
      + `no connection arrived — here is the one thing to check: `
      + `run \`${fixCommand}\` on the machine where I should live.`
      + (effective.commandType === 'mcp'
        ? ' MCP-only clients can call Commonly, but they do not answer @mentions.'
        : '')
      + ` I'll post here the moment I connect.`;
  }
  return `@${installerName} — I'm installed here, but nothing has ever started me, `
    + `so mentioning @${handle} won't reach anyone yet. `
    + `Run \`${fixCommand}\` on the machine where I should live and I'll come online. `
    + `I'll post here the moment I connect.`;
};

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
