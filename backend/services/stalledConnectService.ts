import StalledConnectEpisode from '../models/StalledConnectEpisode';
import { deriveAgentState } from './agentStateService';
import { composeStalledConnectNudge, composeStalledConnectResolution } from './stalledConnectCopy';

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

/**
 * The bot User row holds the legacy half of the token store. Both halves feed
 * `deriveAgentState`, so both must feed the issue-time calculation too, or a
 * seat whose only token lives on the User row looks tokenless and is skipped.
 */
const botTokensFor = async (agentName: string, instanceId: string) => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');
  const row = await User.findOne({
    isBot: true,
    'botMetadata.agentName': agentName,
    'botMetadata.instanceId': instanceId,
  }).select('agentRuntimeTokens.lastUsedAt agentRuntimeTokens.createdAt').lean() as
    { agentRuntimeTokens?: Array<{ lastUsedAt?: Date; createdAt?: Date }> } | null;
  return row?.agentRuntimeTokens || [];
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
    candidates: 0, nudged: [], resolved: [], skippedTooRecent: 0, skippedNotStalled: 0,
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
    ],
  }).limit(CANDIDATE_LIMIT).lean();
  result.candidates = candidates.length;

  for (const install of candidates as Array<Record<string, any>>) {
    const agentName = String(install.agentName || '').toLowerCase();
    const instanceId = String(install.instanceId || 'default');
    const userTokens = await botTokensFor(agentName, instanceId);

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

    await nudgeOnce({ install, derived, issuedAt, tokenSource: source, now, result });
  }

  return result;
};

const nudgeOnce = async ({
  install, derived, issuedAt, tokenSource, now, result,
}: {
  install: Record<string, any>;
  derived: { agentName: string; instanceId: string; displayName: string; fixCommand?: string };
  issuedAt: Date;
  tokenSource: 'installation' | 'user' | null;
  now: Date;
  result: StalledScanResult;
}): Promise<void> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { buildAgentUsername } = require('./agentIdentityService');

  const podId = String(install.podId);
  const installer = await User.findById(install.installedBy).select('username').lean() as
    { username?: string } | null;
  if (!installer?.username) return; // Nobody to address; a nameless nudge is noise.

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
    if (error?.code === 11000) return;
    throw error;
  }

  const content = composeStalledConnectNudge({
    installerName: installer.username,
    displayName: derived.displayName,
    handle,
    fixCommand: derived.fixCommand || `commonly agent run ${derived.agentName}`,
  });

  try {
    const posted = await AgentMessageService.postMessage({
      agentName: derived.agentName,
      instanceId: derived.instanceId,
      displayName: derived.displayName,
      podId,
      content,
      metadata: { kind: 'stalled-connect-nudge' },
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
      return;
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
  } catch (error) {
    console.warn('[stalled-connect] nudge post failed:', (error as Error).message);
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

  const open = await StalledConnectEpisode.find({ status: 'open' }).limit(200).lean();
  for (const ep of open as Array<Record<string, any>>) {
    const install = await AgentInstallation.findById(ep.installationId).lean();
    if (!install) {
      // Uninstalled while stalled: close it silently. There is no room to
      // congratulate and nobody waiting on the promise.
      await StalledConnectEpisode.updateOne(
        { _id: ep._id, status: 'open' },
        { $set: { status: 'resolved', resolvedAt: now } },
      );
      continue;
    }
    const userTokens = await botTokensFor(String(ep.agentName), String(ep.instanceId));
    const derived = deriveAgentState(
      install as any, userTokens as any, String(install.installedBy || ''), now.getTime(),
    );
    if (derived.state === 'never-connected') continue;

    const handle = buildAgentUsername
      ? buildAgentUsername(String(ep.agentName), String(ep.instanceId))
      : String(ep.agentName);
    // `lastUsedAt` leaving null is a PERMANENT transition, so this timestamp
    // survives a wrapper that connected and stopped again between passes —
    // which is why the confirmation needs no time bound (ux-lead, 53307).
    const firstSeenAt = derived.lastUsedAt ? new Date(derived.lastUsedAt) : now;
    let resolutionMessageId = '';
    try {
      const posted = await AgentMessageService.postMessage({
        agentName: String(ep.agentName),
        instanceId: String(ep.instanceId),
        displayName: ep.displayName || String(ep.agentName),
        podId: String(ep.podId),
        content: composeStalledConnectResolution({
          displayName: ep.displayName || String(ep.agentName),
          handle,
          firstSeenAt,
          // Derived at POST time, not at connect time: the past is a fact, the
          // present is an inference, and they get different voices.
          presentState: derived.state,
          fixCommand: derived.fixCommand || `commonly agent run ${ep.agentName}`,
        }),
        metadata: { kind: 'stalled-connect-resolved' },
      });
      resolutionMessageId = extractMessageId(posted) || '';
    } catch (error) {
      console.warn('[stalled-connect] resolution post failed:', (error as Error).message);
    }

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
  }
};

export default { scan, CONNECT_PATIENCE_MINUTES };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
