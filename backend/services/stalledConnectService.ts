import StalledConnectEpisode from '../models/StalledConnectEpisode';
import { deriveAgentState, keyOnlyOnPage } from './agentStateService';
import { isGuestOfIdentity, ownsRuntimeIdentity } from './runtimeIdentityOwnership';
import { composeStalledConnectNotice } from './stalledConnectCopy';

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
 * unused, the person who installed it gets a private Activity "Needs you" row
 * saying so, which points at the agent's panel, where the start command
 * already lives for them alone. It closes itself when the agent connects.
 *
 * NOTHING IS POSTED (F666). Until F666 the seat said this in the room, as the
 * agent, with the start command, and then posted a confirmation when it
 * connected. Both were addressed to the installer and read by every member.
 * The install intro stopped doing the same for never-connected seats; this
 * follows it. A seat that was offline at install gets no later hello either:
 * its first message introduces it.
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
const CONNECT_PATIENCE_MINUTES = Number(
  process.env.STALLED_CONNECT_PATIENCE_MINUTES || 15,
);

/** Cap on installs examined per pass; the candidate set is normally ~45. */
const CANDIDATE_LIMIT = 500;

interface StalledScanResult {
  candidates: number;
  nudged: Array<{ episodeId: string; agentName: string; podId: string; installer: string }>;
  resolved: Array<{ episodeId: string; agentName: string; podId: string }>;
  skippedTooRecent: number;
  skippedNotStalled: number;
  skippedGuest: number;
  skippedSameToken: number;
  /** Installs that declared `config.runtime.listens: false`: nothing is meant to run. */
  skippedNoListener: number;
}

interface TokenEpisodeKey {
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

type BotTokens = Array<{ lastListenedAt?: Date; lastMcpSeenAt?: Date; lastUsedAt?: Date; createdAt?: Date }>;

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


// Any call on a token still on the row. Settings stops offering Connect once it
// sees one, whatever the token's age, and replacing that key could cut off
// whatever made the call. Revoking a token removes its row.
const anyCallRecorded = (tokenLists: BotTokens[]): boolean => tokenLists.some(
  (list) => (list || []).some((row) => row?.lastUsedAt),
);

/** Listen evidence: a check-in on any token in either store. A `reachable` or
 * `unknown` derived state alone is not one (a native or unclassified runtime). */
const hasListened = (tokenLists: BotTokens[]): boolean => tokenLists.some(
  (list) => (list || []).some((row) => row?.lastListenedAt),
);

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
  // Filled when given: a seat on a machine starts there, not from the page's Connect.
  machines?: Map<string, unknown>,
  // Filled when given: the bot's own id, which its first listen closes rows by.
  botIds?: Map<string, unknown>,
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
    'botMetadata.agentName botMetadata.instanceId botMetadata.machineId agentRuntimeTokens.lastListenedAt '
      + 'agentRuntimeTokens.lastMcpSeenAt agentRuntimeTokens.lastUsedAt agentRuntimeTokens.createdAt',
  ).lean() as Array<{
    _id?: unknown;
    botMetadata?: { agentName?: string; instanceId?: string; machineId?: unknown };
    agentRuntimeTokens?: BotTokens;
  }>;
  for (const row of rows) {
    const key = botKey(String(row.botMetadata?.agentName), String(row.botMetadata?.instanceId));
    if (!byKey.has(key)) {
      byKey.set(key, row.agentRuntimeTokens || []);
      machines?.set(key, row.botMetadata?.machineId);
      botIds?.set(key, row._id);
    }
  }
  return byKey;
};

export const scan = async ({
  now = new Date(),
  patienceMinutes = CONNECT_PATIENCE_MINUTES,
}: { now?: Date; patienceMinutes?: number } = {}): Promise<StalledScanResult> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../models/AgentRegistry');

  const result: StalledScanResult = {
    candidates: 0, nudged: [], resolved: [], skippedTooRecent: 0, skippedNotStalled: 0, skippedGuest: 0, skippedSameToken: 0, skippedNoListener: 0,
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
  const machinesBySeat = new Map<string, unknown>();
  const botIdsBySeat = new Map<string, unknown>();
  const tokensBySeat = await botTokensForMany(
    (candidates as Array<Record<string, any>>).map(seatOf), machinesBySeat, botIdsBySeat,
  );
  const explained = await explainedTokens((candidates as Array<Record<string, any>>).map((row) => seatOf(row).agentName));
  // Sibling cover counts only an install still waiting on a listener: one that
  // declared none had its notice closed quietly, which told nobody to start this one.
  const activeRows = new Set((candidates as Array<Record<string, any>>)
    .filter((row) => row.config?.runtime?.listens !== false).map((row) => String(row._id)));

  for (const install of candidates as Array<Record<string, any>>) {
    const { agentName, instanceId } = seatOf(install);
    const userTokens = tokensBySeat.get(botKey(agentName, instanceId)) || [];

    const { issuedAt, source } = resolveTokenEpisode(install.runtimeTokens, userTokens);
    if (!issuedAt) continue;
    if (now.getTime() - issuedAt.getTime() < patienceMinutes * MINUTE_MS) {
      result.skippedTooRecent += 1;
      continue;
    }
    // An identity that declared it runs no listener calls Commonly over its API
    // when it works. Its install greeting already says a mention won't wake it,
    // so "nothing is running, start it with `commonly agent run`" would be false.
    if (install.config?.runtime?.listens === false) {
      result.skippedNoListener += 1;
      continue;
    }

    // Owner as caller, the same reading the owner's own panel makes.
    const derived = deriveAgentState(
      install as any, userTokens as any, String(install.installedBy || ''), now.getTime(),
    );
    if (derived.state !== 'never-connected') {
      result.skippedNotStalled += 1;
      continue;
    }
    // A room's row names whoever opened it, and the notice is for whoever runs
    // the agent, who gets it on their own install.
    if (await isGuestOfIdentity(install.installedBy, agentName, instanceId)) {
      result.skippedGuest += 1;
      continue;
    }
    // An MCP client never listens, so it derives never-connected however often
    // it calls in. "Nothing is running" would be false for one that has called
    // on this token, so it gets no notice, and the next pass closes its episode.
    const mcpConnected = Boolean(latestMcpSeenSince([install.runtimeTokens || [], userTokens], issuedAt));
    // One token can back the person's pod and their own room. The notice is
    // for them, so one they got for another install they still reach covers
    // this one. Anything less, and this install gets its own: silence is the failure.
    const told = tokenKey(agentName, instanceId, install.installedBy, issuedAt);
    const line = explained.get(told);
    if (line && line.installationId !== String(install._id) && activeRows.has(line.installationId)
      && await readsPod(line.podId, install.installedBy)) {
      result.skippedSameToken += 1;
      continue;
    }
    // Connect only for its one owner: anyone else's replacement is refused.
    // It picks which way the notice points: Connect, or the start command.
    const connectable = keyOnlyOnPage(install as any, machinesBySeat.get(botKey(agentName, instanceId)))
      && !anyCallRecorded([install.runtimeTokens || [], userTokens])
      && (await ownsRuntimeIdentity(install.installedBy, agentName, instanceId.toLowerCase())
        .catch((error: Error) => {
          console.warn('Could not read the stalled agent\'s owner:', error.message);
          return { owned: false };
        })).owned;
    const delivered = await nudgeOnce({
      install,
      derived,
      issuedAt,
      tokenSource: source,
      mcpConnected,
      connectable,
      agentUserId: botIdsBySeat.get(botKey(agentName, instanceId)),
      now,
      result,
    });
    if (delivered) explained.set(told, { installationId: String(install._id), podId: String(install.podId) });
  }

  return result;
};

type ExplainedLine = { installationId: string; podId: string };

/** Leaving a pod keeps the row, so a notice for that pod may be out of their reach. */
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

/** Where each person's token has a notice that actually reached them: a private
 * Needs-you row (F666), or before it a pod post. An episode alone proves
 * nothing: it's claimed before the write, and an MCP seat's has none. A failed
 * read returns none, and the cost is one notice too many (rule 19). */
const explainedTokens = async (agentNames: string[]): Promise<Map<string, ExplainedLine>> => {
  const explained = new Map<string, ExplainedLine>();
  try {
    const episodes = await StalledConnectEpisode.find({
      agentName: { $in: [...new Set(agentNames)] },
      $or: [{ noticedAt: { $ne: null } }, { nudgeMessageId: { $nin: [null, ''] } }],
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

/** Whether this install's agent has listened since the pass read it. A failed
 * read answers false: the row stays, and the next pass or the listen closes it. */
const connectedSince = async (
  install: Record<string, any>, agentName: string, instanceId: string,
): Promise<boolean> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../models/AgentRegistry');
  try {
    const fresh = await AgentInstallation.findById(install._id).lean();
    if (!fresh) return false;
    const tokens = await botTokensForMany([{ agentName, instanceId }]);
    const userTokens = tokens.get(botKey(agentName, instanceId)) || [];
    return hasListened([(fresh as { runtimeTokens?: BotTokens }).runtimeTokens || [], userTokens]);
  } catch (error) {
    console.warn('[stalled-connect] re-check after the write failed:', (error as Error).message);
    return false;
  }
};

/** Whether the episode has closed. A failed read answers false: the row stays,
 * and the agent's first listen still closes it. */
const episodeClosed = async (episodeId: unknown): Promise<boolean> => {
  try {
    const fresh = await StalledConnectEpisode.findById(episodeId).select('status').lean() as
      { status?: string } | null;
    return !fresh || fresh.status !== 'open';
  } catch (error) {
    console.warn('[stalled-connect] episode re-check after the write failed:', (error as Error).message);
    return false;
  }
};

const nudgeOnce = async ({
  install, derived, issuedAt, tokenSource, mcpConnected, connectable, agentUserId, now, result,
}: {
  install: Record<string, any>;
  derived: { agentName: string; instanceId: string; displayName: string };
  issuedAt: Date;
  tokenSource: 'installation' | 'user' | null;
  mcpConnected: boolean;
  connectable: boolean;
  agentUserId?: unknown;
  now: Date;
  result: StalledScanResult;
}): Promise<boolean> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AttentionItemService = require('./attentionItemService');

  const podId = String(install.podId);
  const installer = await User.findById(install.installedBy).select('username').lean() as
    { username?: string } | null;
  if (!installer?.username) return false; // Nobody to tell.

  // Claim the episode BEFORE writing the row. The unique index is the
  // once-per-token rule, and claiming first means a duplicate pass loses here,
  // so it can never reopen a row the person already marked handled. A write
  // that then fails leaves a claimed episode with no `noticedAt`, and the next
  // pass retries it below.
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
    if (error?.code !== 11000) throw error;
    // Unless no notice ever reached them: a claim whose row write failed (or
    // whose installer was out of the pod) is retried, never left silent. Two
    // passes racing here can both write, which reopens the one row twice:
    // over-delivery, the safe direction.
    episode = await StalledConnectEpisode.findOne({
      installationId: install._id, tokenIssuedAt: issuedAt, status: 'open',
      noticedAt: null, nudgeMessageId: { $in: [null, ''] },
    }).lean();
    if (!episode) return false;
  }
  // The episode stays open with no row, and the next pass closes it.
  if (mcpConnected) return false;

  // The installer's private row. Nothing is posted into the pod (F666).
  const { title, detail } = composeStalledConnectNotice({ displayName: derived.displayName, connectable });
  try {
    const recorded = await AttentionItemService.recordStalledConnect({
      recipientUserId: install.installedBy,
      podId,
      installationId: install._id,
      agentUserId,
      episodeId: episode._id,
      tokenIssuedAt: issuedAt,
      title,
      detail,
    });
    if (!recorded?.recorded) {
      // Not a member of the pod any more: Activity hides a row for a pod its
      // recipient can't open, so nothing reached them, and a sibling install
      // they still reach is free to tell them.
      console.warn(
        `[stalled-connect] no row for episode=${episode._id} agent=${derived.agentName}: ${recorded?.reason || 'not recorded'}`,
      );
      return false;
    }
    await StalledConnectEpisode.updateOne({ _id: episode._id }, { $set: { noticedAt: now } });
    // The token state above was read at the top of the pass. If the agent
    // listened since, its first-listen hook may have run before this row
    // existed and closed nothing. Re-read AFTER the write: the listen stamp
    // lands before that hook resolves, so either this read sees the stamp or
    // the hook runs after the write and closes the row itself.
    if (await connectedSince(install, derived.agentName, derived.instanceId)) {
      await AttentionItemService.resolveStalledConnectEpisode(install._id, episode._id, { actioned: true });
      return true;
    }
    // This pass read the episode open before it wrote, and another pass may
    // have closed it since (an uninstall). Later passes only visit open
    // episodes, so a row written after that close would stay open for good.
    // Re-read AFTER the write: the closing pass resolves the episode's row
    // again once the episode is closed, so either it sees this row or this
    // read sees the close.
    if (await episodeClosed(episode._id)) {
      await AttentionItemService.resolveStalledConnectEpisode(install._id, episode._id, { actioned: false });
      return true;
    }
    result.nudged.push({
      episodeId: String(episode._id),
      agentName: derived.agentName,
      podId,
      installer: installer.username,
    });
    return true;
  } catch (error) {
    console.warn('[stalled-connect] notice write failed:', (error as Error).message);
    return false;
  }
};

/**
 * Close what the agent's connecting answered.
 *
 * The installer's row asked them to start the agent, so it resolves as
 * `actioned` once the agent connects, by listening or as an MCP client that
 * called in on this episode's token. Usually the first-listen hook has closed
 * it already (installIntroOnListen); this pass is the backstop, and it closes
 * the episode. Nothing is posted (F666): the old "I connected" line was the
 * second half of a pod post that no longer exists.
 */
export const RESOLVE_PAGE_SIZE = 200;

const resolveConnected = async ({
  now, result,
}: { now: Date; result: StalledScanResult }): Promise<void> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../models/AgentRegistry');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AttentionItemService = require('./attentionItemService');

  // The row is resolved before the episode closes, so a failed resolve keeps
  // the episode open for the next pass, and again after: a pass that claimed
  // this episode may write its row between the two, having read the episode
  // still open (it re-reads after writing, so it sees any close made later).
  const closeEpisode = async (ep: Record<string, any>, actioned: boolean): Promise<void> => {
    await StalledConnectEpisode.updateOne(
      { _id: ep._id, status: 'open' },
      { $set: { status: 'resolved', resolvedAt: now } },
    );
    result.resolved.push({
      episodeId: String(ep._id), agentName: String(ep.agentName), podId: String(ep.podId),
    });
    await AttentionItemService.resolveStalledConnectEpisode(ep.installationId, ep._id, { actioned });
  };

  const resolveEpisode = async (
    ep: Record<string, any>, tokensBySeat: Map<string, BotTokens>,
  ): Promise<void> => {
    const install = await AgentInstallation.findById(ep.installationId).lean();
    // Plain `resolve`, not `resolveActioned`: nobody started the agent the row
    // asked about. `message` closes the row of a pre-F666 pod post.
    const closeQuietly = async (): Promise<void> => {
      // Storage errors throw, so the episode stays open and the next pass retries.
      if (ep.nudgeMessageId) await AttentionItemService.resolve('message', String(ep.nudgeMessageId), { strict: true });
      await AttentionItemService.resolveStalledConnectEpisode(ep.installationId, ep._id, { actioned: false });
      await closeEpisode(ep, false);
    };
    // An uninstall keeps the install row; there is nothing left to start. No
    // uninstall path closes the Needs-you row itself (there are several), so
    // this pass does, on its next run.
    if (!install || install.status === 'uninstalled') {
      await closeQuietly();
      return;
    }
    // An install that declared no listener can have an episode opened before it
    // said so. It will never listen, so that episode must not wait for it.
    const noListener = install.config?.runtime?.listens === false;
    const userTokens = tokensBySeat.get(botKey(String(ep.agentName), String(ep.instanceId))) || [];
    const installTokens = (install as { runtimeTokens?: BotTokens }).runtimeTokens || [];
    // Only listen evidence closes it as `actioned`: a `reachable` or `unknown`
    // state (a native or unclassified runtime) never showed the agent started.
    // An MCP client uses its token without ever listening (TASK-345). It did
    // connect, so it resolves too. Only a call the MCP client itself made on
    // this episode's token counts (`lastMcpSeenAt`); anything less keeps waiting.
    if (!hasListened([installTokens, userTokens])) {
      const mcpSeenAt = ep.tokenIssuedAt
        ? latestMcpSeenSince([installTokens, userTokens], new Date(ep.tokenIssuedAt)) : null;
      if (!mcpSeenAt) {
        if (noListener) await closeQuietly();
        return;
      }
    }
    if (ep.nudgeMessageId) await AttentionItemService.resolveActioned('message', String(ep.nudgeMessageId), { strict: true });
    await AttentionItemService.resolveStalledConnectEpisode(ep.installationId, ep._id, { actioned: true });
    await closeEpisode(ep, true);
  };
  // Every open episode, a page at a time in _id order (F505). A never-
  // connected episode stays open for good, so the open set only grows; one
  // unsorted batch of 200 left whatever fell outside it open forever, and the
  // digest could still call a connected agent "not connected yet".
  let after: unknown = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await StalledConnectEpisode.find({ status: 'open', ...(after ? { _id: { $gt: after } } : {}) })
      .sort({ _id: 1 }).limit(RESOLVE_PAGE_SIZE).lean() as Array<Record<string, any>>;
    if (!page.length) break;
    // eslint-disable-next-line no-await-in-loop
    const tokensBySeat = await botTokensForMany(page.map((ep) => ({
      agentName: String(ep.agentName), instanceId: String(ep.instanceId),
    })));
    for (const ep of page) {
      // One episode's failed lookup must not end the pass for the ones after it.
      // The failed episode stays open and is tried again on the next pass, so a
      // lookup error fails toward silence, never toward a false "connected".
      try {
        // eslint-disable-next-line no-await-in-loop
        await resolveEpisode(ep, tokensBySeat);
      } catch (error) {
        console.warn('[stalled-connect] resolution check failed:', (error as Error).message);
      }
    }
    if (page.length < RESOLVE_PAGE_SIZE) break;
    after = page[page.length - 1]._id;
  }
};

export default { scan, CONNECT_PATIENCE_MINUTES };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
