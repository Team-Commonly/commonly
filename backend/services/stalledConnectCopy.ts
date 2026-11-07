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
 * Where the listener is walked answering @mentions differs by OS and adapter
 * (the BYO support matrix, #3399). On Linux, Claude Code answered an @mention
 * on prod on an API key (byo-linux.yml run 41945040493) but its own-login path
 * is CI-only, and Codex is unverified, so the copy says only what holds for
 * all of them: it may not answer there yet. On Windows,
 * Claude Code answered an @mention on prod from the page's PowerShell lines
 * (D164, byo-windows.yml run 41926949969, CLI 0.1.245; 0.1.243 is the first
 * release with the Windows npm fix), and Codex isn't walked there. The server
 * never learns which adapter the copied command named, so the Windows copy
 * says both, and points at the page's lines rather than at --unsandboxed,
 * which Codex doesn't take.
 *
 * It hedges, unlike the rest of this file. Since #3388 the page also shows the
 * listener command for Windows (opt-in) and for Claude Code in a private
 * Linux pod, so a copy from a Linux or Windows browser may have run there or
 * on a Mac. byoOpenedOs is the browser's OS, not where the
 * command ran, so the sentence is conditional on it.
 */
const LISTENER_UNAVAILABLE_OS: Record<string, string> = { linux: 'Linux', windows: 'Windows' };
const LISTENER_PLATFORM_NOTE = "is tested on a Mac. On Linux it may not answer @mentions yet, and we're working on that.";
const WINDOWS_LISTENER_FACTS = 'Claude Code answers @mentions with CLI 0.1.243 or newer, from the PowerShell lines on the Bring your own page. '
  + 'Codex hasn’t been tested on Windows yet.';
const WINDOWS_LISTENER_NOTE = `On Windows, ${WINDOWS_LISTENER_FACTS}`;
const HOSTED_FALLBACK = 'choose “Run it here” on the Bring your own page for a hosted agent.';

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
  installerName, displayName, handle, fixCommand, connectable = false, evidence = {},
}: {
  installerName: string;
  displayName: string;
  handle: string;
  fixCommand: string;
  /** Made on the page: its key is on no computer, so the bare command can't run. */
  connectable?: boolean;
  locale?: NudgeLocale;
  evidence?: StalledConnectCopyEvidence;
}): string => {
  const start = connectable ? 'the command from Connect in my Settings' : `\`${fixCommand}\``;
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
    if (evidence.openedOs === 'windows') {
      return `@${installerName} — you copied the MCP command ${when}. `
        + `MCP-only clients can call Commonly, but they do not answer @mentions; the listener does. `
        + `You first opened this page on Windows. ${WINDOWS_LISTENER_NOTE} `
        + `Or ${HOSTED_FALLBACK} `
        + `I'll post here the moment I connect.`;
    }
    if (unavailableOs) {
      // Their browser may not have shown the listener command, so do not
      // tell this person they missed it.
      return `@${installerName} — you copied the MCP command ${when}. `
        + `MCP-only clients can call Commonly, but they do not answer @mentions. `
        + `The listener that does ${LISTENER_PLATFORM_NOTE} You first opened this page on ${unavailableOs}. `
        + `Run ${start} in a Terminal on a Mac, or choose “Run it here” on the Bring your own page for a hosted agent. `
        + `I'll post here the moment I connect.`;
    }
    return `@${installerName} — you copied the MCP command ${when}, but not the listener command that starts me. `
      + `MCP-only clients can call Commonly, but they do not answer @mentions, `
      + `so nothing is listening for @${handle} yet. `
      + `Run ${start} in a Terminal on the machine where I should live. `
      + `I'll post here the moment I connect.`;
  }
  if (offsetSeconds !== null) {
    const copiedThing = effective.commandType === 'mcp'
      ? 'MCP command'
      : effective.commandType === 'cli' ? 'listener command' : 'command';
    const unavailableOs = effective.commandType === 'cli' && effective.openedOs
      ? LISTENER_UNAVAILABLE_OS[effective.openedOs]
      : undefined;
    if (effective.commandType === 'cli' && effective.openedOs === 'windows') {
      return `@${installerName} — you copied the listener command `
        + `${copiedAtDescription(offsetSeconds)}; no connection arrived. `
        + `If you ran it on Windows: ${WINDOWS_LISTENER_FACTS.replace('answers @mentions with', 'answers @mentions there with')} `
        + 'Check yours with `commonly --version`, and run all of the page’s lines again in one PowerShell window. '
        + `Or ${HOSTED_FALLBACK} `
        + `I'll post here the moment I connect.`;
    }
    if (unavailableOs) {
      return `@${installerName} — you copied the listener command `
        + `${copiedAtDescription(offsetSeconds)}; no connection arrived. `
        + `If you ran it on ${unavailableOs}, that may be why: the listener ${LISTENER_PLATFORM_NOTE} `
        + `Run ${start} on a Mac, or choose “Run it here” on the Bring your own page for a hosted agent. `
        + `I'll post here the moment I connect.`;
    }
    return `@${installerName} — you copied the ${copiedThing} `
      + `${copiedAtDescription(offsetSeconds)}; `
      + `no connection arrived — here is the one thing to check: `
      + `run ${start} on the machine where I should live.`
      + (effective.commandType === 'mcp'
        ? ' MCP-only clients can call Commonly, but they do not answer @mentions.'
        : '')
      + ` I'll post here the moment I connect.`;
  }
  return `@${installerName} — I'm installed here, but nothing has ever started me, `
    + `so mentioning @${handle} won't reach anyone yet. `
    + `Run ${start} on the machine where I should live and I'll come online. `
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
 * arbitrary age: **flat for the past** (the latest check-in timestamp is a
 * fact, dated because the post can land days late) and **derived for the present** (per the same certainty rule that
 * governs the install intro). That compound is also what dissolves the
 * connect-then-disconnect-within-one-pass case I thought was invisible:
 * `lastUsedAt` leaving null is a PERMANENT transition, so the next pass still
 * sees it and simply reports a different present — "connected (last checked
 * in 2026-11-05 00:58 UTC), not running now" — instead of missing the event.
 */
export const composeStalledConnectResolution = ({
  displayName, handle, lastCheckInAt, presentState, fixCommand,
}: {
  displayName: string;
  handle: string;
  /**
   * The latest listen on the token (`lastListenedAt`), as the pass read it. A
   * fact, stated flat; it is the latest check-in, not the first. Null when the
   * runtime keeps no listen time (a native or webhook seat), and then no time
   * is claimed.
   */
  lastCheckInAt: Date | null;
  /** `deriveAgentState` verdict at POST time, not at connect time. */
  presentState: string;
  fixCommand: string;
  locale?: NudgeLocale;
}): string => {
  // Dated, as the MCP resolution is: a bare time would read as today.
  const past = lastCheckInAt
    ? `${displayName} connected (last checked in ${lastCheckInAt.toISOString().slice(0, 16).replace('T', ' ')} UTC).`
    : `${displayName} connected.`;

  // Inferred and currently down: hedge nothing about the past, keep the
  // instruction for the present.
  if (presentState === 'gone-dark') {
    return `${past} It isn't running right now — restart it with \`${fixCommand}\` `
      + `and @${handle} will get through again.`;
  }
  // Anything else checked in within the listening window, but an agent that
  // stopped a minute ago is still inside it (byo-linux walk, 2026-11-05), so
  // the invitation is conditional, never "Listening now".
  return `${past} Mention @${handle} while the listener is running and I'll answer.`;
};

/**
 * The resolution for a token used but never listened on: an MCP client
 * (TASK-345). It did connect, so the nudge's promise is kept. "Listening now"
 * would be the false promise #943 removed, though: an MCP client reaches
 * Commonly only when its person asks it to, and never answers @mentions. So the
 * post says what it can do, with a first thing to ask, and what answering here
 * would take, by the same OS rule the nudge uses.
 */
export const composeStalledConnectMcpResolution = ({
  displayName, handle, seenAt, fixCommand, openedOs,
}: {
  displayName: string;
  handle: string;
  /** Latest token use. A fact, stated flat. */
  seenAt: Date;
  fixCommand: string;
  openedOs?: StalledConnectCopyEvidence['openedOs'];
  locale?: NudgeLocale;
}): string => {
  // Dated: this can close days late, and a bare time would read as today.
  const seen = `${seenAt.toISOString().slice(0, 10)} ${seenAt.toISOString().slice(11, 16)} UTC`;
  const head = `${displayName} connected from your MCP client (seen ${seen}). `
    + 'I can read and post here whenever you ask me from that client. '
    + 'Try: “read my Commonly pod and post a hello there”. ';
  if (openedOs === 'windows') {
    return `${head}I won't answer @${handle} on my own: that takes the listener. ${WINDOWS_LISTENER_NOTE} `
      + 'For an agent that answers here from any computer, choose “Run it here” on the Bring your own page.';
  }
  const unavailableOs = openedOs ? LISTENER_UNAVAILABLE_OS[openedOs] : undefined;
  if (unavailableOs) {
    return `${head}I won't answer @${handle} on my own: that takes the listener, `
      + `\`${fixCommand}\`, which ${LISTENER_PLATFORM_NOTE} `
      + 'For an agent that answers here from any computer, choose “Run it here” on the Bring your own page.';
  }
  return `${head}I won't answer @${handle} on my own: that takes the listener. `
    + `Run \`${fixCommand}\` in a Terminal on the machine where I should live.`;
};

export default {
  composeStalledConnectNudge, composeStalledConnectResolution, composeStalledConnectMcpResolution,
};
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
