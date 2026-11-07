import StalledConnectEpisode from '../models/StalledConnectEpisode';
import { deriveAgentState } from './agentStateService';
import { isGuestOfIdentity } from './runtimeIdentityOwnership';
import {
  composeStalledConnectNudge,
  composeStalledConnectMcpResolution,
  composeStalledConnectResolution,
} from './stalledConnectCopy';
import type { StalledConnectCopyEvidence } from './stalledConnectCopy';

/**
 * The stalled-connect nudge (W4 item 3). Spec: ux-lead, 2026-08-14.
 *
 * A person installs a seat, never runs the wrapper, and nothing ever tells
 * them. `user-fbd3` did exactly this on 2026-08-15: signed up, installed a BYO
 * agent 77 seconds later, never ran it, never spoke, gone. The seat's own
 * install intro (#943) told the truth at install time — "nothing is running me
 * yet" — but that is a single line at minute zero, and nothing follows up.
 *
 * This is the follow-up. Fifteen minutes after a token is issued and still
 * unused, the seat says so in the room, addressed to the person who installed
 * it, and hands over the exact command.
 *
 * WHY IT IS NOT THE SILENCE ALERT. `onboardingSilenceService` fires on
 * conversational outcome — someone spoke and nothing answered — and reports to
 * US. This fires on install state and speaks to the USER. They are blind to
 * each other's population by construction: someone who never types is
 * invisible to that one and is the whole subject of this one.
 *
 * WHY A CRON AND NOT A DELAYED EVENT (ux-lead, explicitly): the original
 * reason was that a delayed AgentEvent inherited the 30-40 minute pending-GC
 * caveat and so needed a survivable timer. #993 removed that deletion, and the
 * conclusion is unchanged for the stronger half of the original argument: a
 * cron that re-derives from state each pass is drop-proof against ANY delivery
 * failure, not just against a sweep — a missed tick costs latency, not the
 * nudge. Do not re-open this on the grounds that events now survive 168h; that
 * was never the load-bearing half.
 *
 * ONE DERIVATION. State comes from `deriveAgentState`, the same function the
 * pod roster, the #943 intro and the #891 surfaces use. There is no parallel
 * "is it connected" rule here and there must never be one; the 15 minutes is a
 * patience window laid on top of that verdict, not a second inference.
 */

const MINUTE_MS = 60 * 1000;

/**
 * How long after a token is issued before silence counts as stalled.
 *
 * A patience window, NOT an inference threshold — never-used is structurally
 * certain the moment it is true, so there is no hysteresis here and none is
 * needed. The window exists so someone who installs and immediately runs the
 * command is never nudged mid-setup.
 */
export const CONNECT_PATIENCE_MINUTES = Number(
  process.env.STALLED_CONNECT_PATIENCE_MINUTES || 15,
);

/** Cap on installs examined per pass; the candidate set is normally ~45. */
const CANDIDATE_LIMIT = 500;

export interface StalledScanResult {
  candidates: number;
  nudged: Array<{ episodeId: string; agentName: string; podId: string; installer: string }>;
  resolved: Array<{ episodeId: string; agentName: string; podId: string }>;
  skippedTooRecent: number;
  skippedNotStalled: number;
  skippedGuest: number;
  skippedSameToken: number;
}

export interface TokenEpisodeKey {
  /** max(createdAt) across BOTH stores — the episode identity. */
  issuedAt: Date | null;
  /** Which store minted it. Matters; see the expiry asymmetry below. */
  source: 'installation' | 'user' | null;
}

/**
 * THE episode identity, exported as one helper on purpose.
 *
 * It must be the max `createdAt` across BOTH token arrays — the same union
 * `deriveAgentState` uses for liveness. Key off one store while triggering off
 * the union and a reissue on the other path never resets the episode, so the
 * spec's "a reissue earns one more nudge" silently stops firing (pod-architect,
 * 53308). The reactive responder imports this rather than recomputing it, so
 * both producers agree on what "the same episode" means (sprint-impl, 53310).
 *
 * ASYMMETRY, encoded rather than left to be discovered: `User.agentRuntimeTokens`
 * carries an `expiresAt`; `AgentInstallation.runtimeTokens` does not (verified
 * in both schemas). So "the life of the current newest token" genuinely ends
 * differently depending on which store minted it — a user-minted token can die
 * of expiry while an installation-minted one can only be superseded. `source`
 * is returned so a caller that cares can tell which regime it is in; today
 * nothing does, and that is fine, but nothing should have to guess.
 */
export const resolveTokenEpisode = (
  installationTokens?: Array<{ createdAt?: Date | string | null }>,
  userTokens?: Array<{ createdAt?: Date | string | null }>,
): TokenEpisodeKey => {
  let issuedAt: Date | null = null;
  let source: 'installation' | 'user' | null = null;
  const consider = (
    list: Array<{ createdAt?: Date | string | null }> | undefined,
    which: 'installation' | 'user',
  ) => {
    for (const row of list || []) {
      if (!row?.createdAt) continue;
      const at = new Date(row.createdAt as string);
      if (Number.isNaN(at.getTime())) continue;
      if (!issuedAt || at > issuedAt) {
        issuedAt = at;
        source = which;
      }
    }
  };
  consider(installationTokens, 'installation');
  consider(userTokens, 'user');
  return { issuedAt, source };
};

type BotTokens = Array<{ lastListenedAt?: Date; lastMcpSeenAt?: Date; createdAt?: Date }>;

/**
 * The latest MCP-client call, at or after `since`, on a token issued at or
 * after `since`, in either store. Only `lastMcpSeenAt` counts: the generic
 * `lastUsedAt` is also set by `agent attach` and by the BYO page's memory
 * import, neither of which is an MCP client. Only tokens of the current
 * episode count: a superseded token says nothing about this one.
 */
const latestMcpSeenSince = (tokenLists: BotTokens[], since: Date): Date | null => {
  let latest: Date | null = null;
  for (const list of tokenLists) {
    for (const row of list || []) {
      if (!row?.lastMcpSeenAt || !row.createdAt || new Date(row.createdAt) < since) continue;
      const used = new Date(row.lastMcpSeenAt);
      if (Number.isNaN(used.getTime()) || used < since) continue;
      if (!latest || used > latest) latest = used;
    }
  }
  return latest;
};


const botKey = (agentName: string, instanceId: string) => `${agentName}\u0000${instanceId}`;

/**
 * The bot User row holds the legacy half of the token store. Both halves feed
 * `deriveAgentState`, so both must feed the issue-time calculation too, or a
 * seat whose only token lives on the User row looks tokenless and is skipped.
 *
 * One query for the whole pass, never one per seat. `botMetadata.agentName` /
 * `instanceId` carry no index, so each per-seat read was a scan of the users
 * collection plus a round trip. Measured on production 2026-11-02: 169 seats
 * read one at a time took 7.0s, and the same rows in one `$or` took 104ms.
 * The match per pair is unchanged (exact name and instance, bots only), and a
 * pair with several bot rows keeps the first, as `findOne` did.
 */
const botTokensForMany = async (
  pairs: Array<{ agentName: string; instanceId: string }>,
): Promise<Map<string, BotTokens>> => {
  const byKey = new Map<string, BotTokens>();
  if (!pairs.length) return byKey;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');
  const unique = new Map(pairs.map((p) => [botKey(p.agentName, p.instanceId), p]));
  const rows = await User.find({
    isBot: true,
    $or: [...unique.values()].map((p) => ({
      'botMetadata.agentName': p.agentName,
      'botMetadata.instanceId': p.instanceId,
    })),
  }).select(
    'botMetadata.agentName botMetadata.instanceId agentRuntimeTokens.lastListenedAt '
      + 'agentRuntimeTokens.lastMcpSeenAt agentRuntimeTokens.createdAt',
  ).lean() as Array<{ botMetadata?: { agentName?: string; instanceId?: string }; agentRuntimeTokens?: BotTokens }>;
  for (const row of rows) {
    const key = botKey(String(row.botMetadata?.agentName), String(row.botMetadata?.instanceId));
    if (!byKey.has(key)) byKey.set(key, row.agentRuntimeTokens || []);
  }
  return byKey;
};

/**
 * Pull the message id out of an AgentMessageService.postMessage result.
 *
 * It is NOT at the top level. The success shape is
 * `{ success, message, summary }`, so the id lives at `message.id` (PG, the
 * primary store) or `message._id` (the Mongo fallback path). Reading
 * `posted.id` yields undefined, which is what the first live run did: ten
 * nudges landed correctly in ten pods and all ten recorded
 * `nudgeMessageId: ''`. The messages were fine; the audit trail was not — and
 * "why did this person never get nudged" is unanswerable without it.
 *
 * Returns null rather than '' for the skipped shapes (`{ success, skipped }`),
 * so a caller can tell "posted" from "declined to post".
 */
const extractMessageId = (posted: unknown): string | null => {
  const msg = (posted as { message?: { id?: unknown; _id?: unknown } })?.message;
  const raw = msg?.id ?? msg?._id;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
};

export const scan = async ({
  now = new Date(),
  patienceMinutes = CONNECT_PATIENCE_MINUTES,
}: { now?: Date; patienceMinutes?: number } = {}): Promise<StalledScanResult> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../models/AgentRegistry');

  const result: StalledScanResult = {
    candidates: 0, nudged: [], resolved: [], skippedTooRecent: 0, skippedNotStalled: 0, skippedGuest: 0, skippedSameToken: 0,
  };

  await resolveConnected({ now, result });

  // Pre-filter must be a SUPERSET of what the derivation will accept, never a
  // second opinion. `deriveAgentState` can only answer 'never-connected' when
  // the install is BYO (host 'byo' or runtimeType 'local-cli'), so gating on
  // that here narrows the scan without being able to change a verdict. Seats
  // with no token at all are excluded below, after both token stores have
  // been read. A token-episode is the unit of work: no token issued means
  // nothing was ever promised to connect.
  //
  // `.lean()` is not optional — `config` is `{ type: Map }`, so on a live
  // Mongoose document `config.runtime` is undefined and every install would
  // derive 'unknown'. This is the bug that defeated three separate readers on
  // 2026-08-14; lean converts Maps to plain objects, which is the shape
  // deriveAgentState reads.
  const candidates = await AgentInstallation.find({
    status: 'active',
    $or: [
      { 'config.runtime.host': 'byo' },
      { 'config.runtime.runtimeType': 'local-cli' },
      // Legacy polling seats: runtimeType 'webhook' with no host stamp and no
      // push URL. classifyRuntime calls these BYO, so the pre-filter must too,
      // or they never reach deriveAgentState (TASK-655, #1320).
      {
        'config.runtime.runtimeType': 'webhook',
        'config.runtime.host': { $in: [null, ''] },
        'config.runtime.webhookUrl': { $in: [null, ''] },
      },
    ],
  }).limit(CANDIDATE_LIMIT).lean();
  result.candidates = candidates.length;

  const seatOf = (install: Record<string, any>) => ({
    agentName: String(install.agentName || '').toLowerCase(),
    instanceId: String(install.instanceId || 'default'),
  });
  const tokensBySeat = await botTokensForMany((candidates as Array<Record<string, any>>).map(seatOf));
  const explained = await explainedTokens((candidates as Array<Record<string, any>>).map((row) => seatOf(row).agentName));
  const activeRows = new Set((candidates as Array<Record<string, any>>).map((row) => String(row._id)));

  for (const install of candidates as Array<Record<string, any>>) {
    const { agentName, instanceId } = seatOf(install);
    const userTokens = tokensBySeat.get(botKey(agentName, instanceId)) || [];

    const { issuedAt, source } = resolveTokenEpisode(install.runtimeTokens, userTokens);
    if (!issuedAt) continue;
    if (now.getTime() - issuedAt.getTime() < patienceMinutes * MINUTE_MS) {
      result.skippedTooRecent += 1;
      continue;
    }

    // Owner as caller, so `fixCommand` attaches — it is an instruction for the
    // person who installed it, and the derivation already scopes it that way.
    const derived = deriveAgentState(
      install as any, userTokens as any, String(install.installedBy || ''), now.getTime(),
    );
    if (derived.state !== 'never-connected') {
      result.skippedNotStalled += 1;
      continue;
    }
    // A room's row names whoever opened it, and the nudge is for whoever runs
    // the agent, who hears it on their own row.
    if (await isGuestOfIdentity(install.installedBy, agentName, instanceId)) {
      result.skippedGuest += 1;
      continue;
    }
    // An MCP client never listens, so it derives never-connected however often
    // it calls in. "Nothing is running" would be false for one that has called
    // on this token, and the next pass's MCP close says what's true: it can
    // post when asked, and answering @mentions takes the listener.
    const mcpConnected = Boolean(latestMcpSeenSince([install.runtimeTokens || [], userTokens], issuedAt));
    // One token can back the person's pod and their own room. The explanation
    // is for them, so a line they can still read on another row covers this
    // one. Anything less, and this row says it: silence is the failure here.
    const told = tokenKey(agentName, instanceId, install.installedBy, issuedAt);
    const line = explained.get(told);
    if (line && line.installationId !== String(install._id) && activeRows.has(line.installationId)
      && await readsPod(line.podId, install.installedBy)) {
      result.skippedSameToken += 1;
      continue;
    }
    const delivered = await nudgeOnce({
      install, derived, issuedAt, tokenSource: source, mcpConnected, now, result,
    });
    if (delivered) explained.set(told, { installationId: String(install._id), podId: String(install.podId) });
  }

  return result;
};

type ExplainedLine = { installationId: string; podId: string };

/** Leaving a pod keeps the row, so a line posted there may be out of their reach. */
const readsPod = async (podId: string, userId: unknown): Promise<boolean> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const Pod = require('../models/Pod');
  try {
    return Boolean(await Pod.exists({ _id: podId, members: userId }));
  } catch (error) {
    console.warn('[stalled-connect] could not read pod members:', (error as Error).message);
    return false;
  }
};

const tokenKey = (agentName: string, instanceId: string, installedBy: unknown, issuedAt: Date | string): string => (
  [agentName, instanceId, String(installedBy), new Date(issuedAt).getTime()].join('\n')
);

/** Where each person's token has a nudge that actually posted. An episode alone
 * proves nothing: it's claimed before the post, and an MCP seat's has no nudge.
 * A failed read returns none, and the cost is one line said twice (rule 19). */
const explainedTokens = async (agentNames: string[]): Promise<Map<string, ExplainedLine>> => {
  const explained = new Map<string, ExplainedLine>();
  try {
    const episodes = await StalledConnectEpisode.find({
      agentName: { $in: [...new Set(agentNames)] },
      nudgeMessageId: { $nin: [null, ''] },
    }).select('agentName instanceId installedBy tokenIssuedAt installationId podId').lean();
    (episodes as Array<Record<string, any>>).forEach((episode) => {
      explained.set(
        tokenKey(episode.agentName, episode.instanceId, episode.installedBy, episode.tokenIssuedAt),
        { installationId: String(episode.installationId), podId: String(episode.podId) },
      );
    });
  } catch (error) {
    console.warn('[stalled-connect] could not read past episodes:', (error as Error).message);
  }
  return explained;
};

const nudgeOnce = async ({
  install, derived, issuedAt, tokenSource, mcpConnected, now, result,
}: {
  install: Record<string, any>;
  derived: { agentName: string; instanceId: string; displayName: string; fixCommand?: string };
  issuedAt: Date;
  tokenSource: 'installation' | 'user' | null;
  mcpConnected: boolean;
  now: Date;
  result: StalledScanResult;
}): Promise<boolean> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { buildAgentUsername } = require('./agentIdentityService');

  const podId = String(install.podId);
  const installer = await User.findById(install.installedBy).select('username onboarding').lean() as
    {
      username?: string;
      onboarding?: {
        byoCommandCopiedAt?: Date;
        byoCommandType?: 'mcp' | 'cli';
        byoMcpCopiedAt?: Date;
        byoCliCopiedAt?: Date;
        byoOpenedOs?: 'mac' | 'linux' | 'windows' | 'other';
      };
    } | null;
  if (!installer?.username) return false; // Nobody to address; a nameless nudge is noise.

  const handle = buildAgentUsername
    ? buildAgentUsername(derived.agentName, derived.instanceId)
    : derived.agentName;

  // Claim the episode BEFORE posting. The unique index is the no-spam rule, and
  // claiming first means a duplicate pass loses here rather than after it has
  // already put a second message in the room — the failure that cannot be
  // undone. A post that then fails leaves a claimed episode and no message,
  // which is the safe direction: one missed nudge beats two delivered.
  let episode;
  try {
    episode = await StalledConnectEpisode.create({
      installationId: install._id,
      podId,
      installedBy: install.installedBy,
      installerUsername: installer.username,
      agentName: derived.agentName,
      instanceId: derived.instanceId,
      displayName: derived.displayName,
      tokenIssuedAt: issuedAt,
      tokenSource,
      producer: 'timer',
      nudgedAt: now,
      status: 'open',
    });
  } catch (error: any) {
    // 11000 means this token-episode was already explained — by an earlier
    // pass, or by the reactive responder that shares this record. Correct
    // outcome, not an error.
    if (error?.code === 11000) return false;
    throw error;
  }
  // The episode stays open with no nudge, so the same one-per-token record
  // carries the MCP close on the next pass.
  if (mcpConnected) return false;

  const content = composeStalledConnectNudge({
    installerName: installer.username,
    displayName: derived.displayName,
    handle,
    fixCommand: derived.fixCommand || `commonly agent run ${derived.agentName}`,
    evidence: {
      commandCopiedAt: installer.onboarding?.byoCommandCopiedAt,
      commandType: installer.onboarding?.byoCommandType,
      mcpCopiedAt: installer.onboarding?.byoMcpCopiedAt,
      cliCopiedAt: installer.onboarding?.byoCliCopiedAt,
      openedOs: installer.onboarding?.byoOpenedOs,
      tokenIssuedAt: issuedAt,
    },
  });

  try {
    const posted = await AgentMessageService.postMessage({
      agentName: derived.agentName,
      instanceId: derived.instanceId,
      displayName: derived.displayName,
      podId,
      content,
      metadata: { kind: 'stalled-connect-nudge' },
      authorKind: 'kernel',
    });
    const messageId = extractMessageId(posted);
    if (!messageId) {
      // postMessage can succeed-without-posting (`skipped: true` for duplicate
      // or suppressed sends). Counting that as delivered is the silent-success
      // shape: the episode stays claimed either way — correct, since something
      // decided this room did not need the message — but the caller must not
      // be told a nudge went out when none did.
      console.warn(
        `[stalled-connect] no message id for episode=${episode._id} `
        + `agent=${derived.agentName} — post skipped or shape changed`,
      );
      return false;
    }
    await StalledConnectEpisode.updateOne(
      { _id: episode._id },
      { $set: { nudgeMessageId: messageId } },
    );
    result.nudged.push({
      episodeId: String(episode._id),
      agentName: derived.agentName,
      podId,
      installer: installer.username,
    });
    return true;
  } catch (error) {
    console.warn('[stalled-connect] nudge post failed:', (error as Error).message);
    return false;
  }
};

/**
 * Keep the promise the nudge made.
 *
 * "I'll post here the moment I connect" is a commitment, and an unkept one
 * turns the recovery path into the same false promise #943 removed. So the
 * confirmation is not optional polish: it is the second half of the same
 * feature.
 */
const resolveConnected = async ({
  now, result,
}: { now: Date; result: StalledScanResult }): Promise<void> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../models/AgentRegistry');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { buildAgentUsername } = require('./agentIdentityService');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AttentionItemService = require('./attentionItemService');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');

  const open = await StalledConnectEpisode.find({ status: 'open' }).limit(200).lean();
  const tokensBySeat = await botTokensForMany((open as Array<Record<string, any>>).map((ep) => ({
    agentName: String(ep.agentName), instanceId: String(ep.instanceId),
  })));
  const resolveEpisode = async (ep: Record<string, any>): Promise<void> => {
    const install = await AgentInstallation.findById(ep.installationId).lean();
    // An uninstall keeps the row, and a post here would put the bot back in the pod.
    if (!install || install.status === 'uninstalled') {
      // Uninstalled while stalled: close it silently. There is no room to
      // congratulate and nobody waiting on the promise.
      await StalledConnectEpisode.updateOne(
        { _id: ep._id, status: 'open' },
        { $set: { status: 'resolved', resolvedAt: now } },
      );
      return;
    }
    const userTokens = tokensBySeat.get(botKey(String(ep.agentName), String(ep.instanceId))) || [];
    const derived = deriveAgentState(
      install as any, userTokens as any, String(install.installedBy || ''), now.getTime(),
    );
    // An MCP client uses its token without ever listening (TASK-345). It did
    // connect, and the nudge promised a post when it did, so it resolves too,
    // with copy that does not promise an answer to @mentions. Only a call the
    // MCP client itself made on this episode's token counts (`lastMcpSeenAt`);
    // anything less keeps waiting.
    let mcpSeenAt: Date | null = null;
    let openedOs: StalledConnectCopyEvidence['openedOs'] = null;
    if (derived.state === 'never-connected') {
      if (!ep.tokenIssuedAt) return;
      const since = new Date(ep.tokenIssuedAt);
      const installTokens = (install as { runtimeTokens?: BotTokens }).runtimeTokens || [];
      mcpSeenAt = latestMcpSeenSince([installTokens, userTokens], since);
      if (!mcpSeenAt) return;
      try {
        const installer = await User.findById(ep.installedBy).select('onboarding.byoOpenedOs').lean() as
          { onboarding?: { byoOpenedOs?: StalledConnectCopyEvidence['openedOs'] } } | null;
        openedOs = installer?.onboarding?.byoOpenedOs || null;
      } catch {
        // The OS only picks the wording; without it the generic copy is still true.
        openedOs = null;
      }
    }

    const handle = buildAgentUsername
      ? buildAgentUsername(String(ep.agentName), String(ep.instanceId))
      : String(ep.agentName);
    // `lastListenedAt` leaving null is a PERMANENT transition, so this timestamp
    // survives a wrapper that connected and stopped again between passes —
    // which is why the confirmation needs no time bound (ux-lead, 53307).
    // It is the LATEST listen, not the first: token rows keep no first-listen
    // time, so the post says "last checked in".
    const lastCheckInAt = derived.lastUsedAt ? new Date(derived.lastUsedAt) : null;
    const fixCommand = derived.fixCommand || `commonly agent run ${ep.agentName}`;
    let resolutionMessageId = '';
    let closeFailed = false;
    try {
      const posted = await AgentMessageService.postMessage({
        agentName: String(ep.agentName),
        instanceId: String(ep.instanceId),
        displayName: ep.displayName || String(ep.agentName),
        podId: String(ep.podId),
        content: mcpSeenAt
          ? composeStalledConnectMcpResolution({
            displayName: ep.displayName || String(ep.agentName),
            handle,
            seenAt: mcpSeenAt,
            fixCommand,
            openedOs,
          })
          : composeStalledConnectResolution({
            displayName: ep.displayName || String(ep.agentName),
            handle,
            lastCheckInAt,
            // Derived at POST time, not at connect time: the past is a fact, the
            // present is an inference, and they get different voices.
            presentState: derived.state,
            fixCommand,
          }),
        metadata: { kind: 'stalled-connect-resolved' },
      });
      resolutionMessageId = extractMessageId(posted) || '';
    } catch (error) {
      console.warn('[stalled-connect] resolution post failed:', (error as Error).message);
      closeFailed = true;
    }
    // With no nudge in the room, this close is the only line the seat gets, so
    // a failed post stays open for the next pass.
    if (closeFailed && !ep.nudgeMessageId) return;
    // The nudge asked the installer to start the agent, and they did. Its
    // "needs you" row resolves now as `actioned`, whether or not the
    // confirmation post above went out: a thread reply was never going to be
    // how this one got answered.
    if (ep.nudgeMessageId) await AttentionItemService.resolveActioned('message', String(ep.nudgeMessageId));

    await StalledConnectEpisode.updateOne(
      { _id: ep._id, status: 'open' },
      {
        $set: {
          status: 'resolved',
          resolvedAt: now,
          ...(resolutionMessageId ? { resolutionMessageId } : {}),
        },
      },
    );
    result.resolved.push({
      episodeId: String(ep._id), agentName: String(ep.agentName), podId: String(ep.podId),
    });
  };
  for (const ep of open as Array<Record<string, any>>) {
    // One episode's failed lookup must not end the pass for the ones after it.
    // The failed episode stays open and is tried again on the next pass, so a
    // lookup error fails toward silence, never toward a false "connected".
    try {
      await resolveEpisode(ep);
    } catch (error) {
      console.warn('[stalled-connect] resolution check failed:', (error as Error).message);
    }
  }
};

export default { scan, CONNECT_PATIENCE_MINUTES };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
