import { escapeHtml } from '../utils/escape';
import { isReservedEmailDomain } from '../utils/reservedEmailDomain';
import StalledConnectEpisode from '../models/StalledConnectEpisode';
// eslint-disable-next-line global-require
const AgentEvent = require('../models/AgentEvent');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { sendEmail } = require('./emailService');
// eslint-disable-next-line global-require
const { providerAccepted, digestSendingState } = require('./digestEmailService');
// eslint-disable-next-line global-require
const { primaryUrl, unsubscribeTokenFor } = require('./mentionEmailService');
// eslint-disable-next-line global-require
const emailReturns = require('./emailReturnService');
// eslint-disable-next-line global-require
const { isListedPodMember } = require('../utils/isPodMember');

/**
 * F522: a teammate @mentions an agent that was installed and never connected.
 * The mention sits in the agent's queue, nothing answers, and before this the
 * owner heard nothing until the digest's +24h stall line (F502). Now the owner
 * gets one email, at most once per agent install per 24h, saying who is
 * waiting, with the "finish connecting" link (F516) and a return tag (F519).
 *
 * "Never connected" is an open stalled-connect episode: the one derivation
 * (deriveAgentState) already decided it, 15 minutes after the token was
 * issued. "Waiting" is the agent's own pending mention events, so the count is
 * exactly what the agent would receive once it connects.
 *
 * F512's rules: written by people only (the event's senderIsHuman stamp),
 * never about the owner's own mentions, and the digest opt-out and sending
 * switch apply. Who and where, never what: no message text in the email.
 */

const HOUR = 60 * 60 * 1000;
export const WAITING_EMAIL_WINDOW_MS = 24 * HOUR;
// Events older than this are not "waiting" any more for this purpose.
export const WAITING_LOOKBACK_MS = 7 * 24 * HOUR;
const MENTION_TYPES = ['chat.mention', 'thread.mention'];
const EPISODE_LIMIT = 500;
const EVENT_LIMIT = 200;

export interface Waiting { count: number; names: string[]; latestAt: Date | null }

type EpisodeLike = {
  agentName: string; instanceId?: string; podId: unknown; installedBy: unknown; tokenIssuedAt?: Date;
};

/**
 * The mentions people have left for this never-connected agent in its pod:
 * pending, human-written, not the owner's own, since its current token was
 * issued (older events were for a key already replaced) and within the
 * lookback. Names are the senders' usernames, newest first, each once.
 */
export const waitingOn = async (episode: EpisodeLike, now: Date = new Date()): Promise<Waiting> => {
  const floor = new Date(Math.max(
    now.getTime() - WAITING_LOOKBACK_MS,
    episode.tokenIssuedAt ? new Date(episode.tokenIssuedAt).getTime() : 0,
  ));
  const events = await AgentEvent.find({
    agentName: String(episode.agentName).toLowerCase(),
    instanceId: episode.instanceId || 'default',
    podId: episode.podId,
    status: 'pending',
    type: { $in: MENTION_TYPES },
    createdAt: { $gte: floor },
    'payload.senderIsHuman': true,
  }).select('payload.userId payload.username createdAt').sort({ createdAt: -1 }).limit(EVENT_LIMIT).lean();
  const owner = String(episode.installedBy);
  const mine = events.filter((event: any) => String(event.payload?.userId || '') !== owner);
  const names: string[] = [];
  for (const event of mine) {
    const name = String(event.payload?.username || '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return { count: mine.length, names, latestAt: mine.length ? new Date(mine[0].createdAt) : null };
};

/** "ana", "ana and bo", "ana and 2 others". */
export const whoIsWaiting = (names: string[]): string => {
  if (names.length === 0) return 'Someone';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
};

const connectUrl = (frontendUrl: string, episode: EpisodeLike): string => (
  `${frontendUrl}/v2/agents/byo?pod=${encodeURIComponent(String(episode.podId))}`
  + `&name=${encodeURIComponent(episode.agentName)}`
  + `&instanceId=${encodeURIComponent(episode.instanceId || 'default')}&reconnect=1`
);

const deliver = async (user: any, episode: any, podName: string, waiting: Waiting): Promise<void> => {
  const frontendUrl = primaryUrl(process.env.FRONTEND_URL, 'http://localhost:3000');
  const backendUrl = primaryUrl(process.env.BACKEND_URL || process.env.COMMONLY_API_URL, 'http://localhost:5000');
  const sendId = emailReturns.newSendId();
  const link = emailReturns.tagUrl(connectUrl(frontendUrl, episode), 'waiting', sendId);
  const unsubscribeUrl = `${backendUrl}/api/email/unsubscribe/${encodeURIComponent(await unsubscribeTokenFor(user))}`;
  const agent = String(episode.displayName || episode.agentName);
  const subject = `${waiting.names[0] || 'Someone'} is waiting on ${agent} in ${podName}`;
  const messages = waiting.count === 1 ? '1 message' : `${waiting.count} messages`;
  const detail = `${whoIsWaiting(waiting.names)} left ${agent} ${messages}. ${agent} hasn't connected yet, so nothing has answered.`;
  const button = `Finish connecting ${agent}`;
  const response = await sendEmail({
    to: user.email,
    subject,
    textBody: `${subject}\n\n${detail}\n\n${button}: ${link}\n\nTurn off these emails and the daily digest: ${unsubscribeUrl}`,
    htmlBody: `<!doctype html><html><body style="margin:0;background:#f8f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;"><main style="max-width:560px;margin:0 auto;padding:32px 20px;"><section style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;"><h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;">${escapeHtml(subject)}</h1><p style="margin:0 0 16px;color:#4b5563;line-height:1.55;">${escapeHtml(detail)}</p><p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2f6feb;color:#ffffff;text-decoration:none;font-weight:600;border-radius:8px;padding:10px 16px;">${escapeHtml(button)}</a></p></section><p style="margin:16px 0 0;text-align:center;color:#7b8494;font-size:12px;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#2456c8;">Turn off these emails and the daily digest</a></p></main></body></html>`,
  });
  if (!providerAccepted(response)) throw new Error('provider did not accept the email');
  await emailReturns.noteSend({ sendId, kind: 'waiting', recipientUserId: user._id, podId: episode.podId });
};

type Outcome = 'sent' | 'skipped' | 'failed';

const decide = async (episode: any, now: Date): Promise<Outcome> => {
  const install = await AgentInstallation.findOne({ _id: episode.installationId, status: 'active' })
    .select('_id waitingEmailAt').lean();
  if (!install) return 'skipped';
  const waiting = await waitingOn(episode, now);
  if (!waiting.count || !waiting.latestAt) return 'skipped';
  const previous: Date | null = install.waitingEmailAt ? new Date(install.waitingEmailAt) : null;
  // Only news: a mention after the last email, and that email 24h ago or more.
  if (previous && (waiting.latestAt <= previous || now.getTime() - previous.getTime() < WAITING_EMAIL_WINDOW_MS)) {
    return 'skipped';
  }

  const user = await User.findById(episode.installedBy)
    .select('+digestUnsubscribeToken email verified isBot emailPreferences');
  if (!user?.email || user.verified !== true || user.isBot === true
    || user.emailPreferences?.dailyDigest === false || isReservedEmailDomain(user.email)) return 'skipped';
  const pod = await Pod.findById(episode.podId).select('_id name members').lean();
  if (!pod || !isListedPodMember(pod, user._id)) return 'skipped';

  // Claimed before the provider call, against the value read above, so two
  // passes can't both send.
  const claimed = await AgentInstallation.updateOne(
    { _id: install._id, status: 'active', waitingEmailAt: previous || { $exists: false } },
    { $set: { waitingEmailAt: now } },
  );
  if (!claimed.modifiedCount) return 'skipped';
  try {
    await deliver(user, episode, String(pod.name || 'a pod'), waiting);
    return 'sent';
  } catch (error) {
    // A timeout has no answer, so it may have been delivered: keep the claim
    // rather than risk a second email. Anything else gives the window back.
    const axiosError = error as { isAxiosError?: boolean; response?: unknown };
    if (!(axiosError.isAxiosError && !axiosError.response)) {
      await AgentInstallation.updateOne(
        { _id: install._id, waitingEmailAt: now },
        previous ? { $set: { waitingEmailAt: previous } } : { $unset: { waitingEmailAt: 1 } },
      ).catch(() => undefined);
    }
    console.warn('[waiting-email] send failed:', (error as Error).message);
    return 'failed';
  }
};

export const sweepWaitingOwnerEmails = async (
  { now = new Date() }: { now?: Date } = {},
): Promise<{ scanned: number; sent: number; skipped: number; failed: number; disabled?: boolean }> => {
  const result = { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) return { ...result, disabled: true };
  if (await digestSendingState() !== 'on') return { ...result, disabled: true };
  const episodes = await StalledConnectEpisode.find({ status: 'open' })
    .select('installationId podId installedBy agentName instanceId displayName tokenIssuedAt nudgedAt')
    .sort({ nudgedAt: -1 }).limit(EPISODE_LIMIT).lean() as any[];
  // A reissue opens a new episode while the old stays open: the newest speaks.
  const newest = new Map<string, any>();
  for (const episode of episodes) {
    const key = String(episode.installationId);
    if (!newest.has(key)) newest.set(key, episode);
  }
  for (const episode of newest.values()) {
    result.scanned += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      result[await decide(episode, now)] += 1;
    } catch (error) {
      result.failed += 1;
      console.warn('[waiting-email] episode failed; the next pass retries:', (error as Error).message);
    }
  }
  return result;
};

export default { sweepWaitingOwnerEmails, waitingOn, whoIsWaiting };
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  sweepWaitingOwnerEmails, waitingOn, whoIsWaiting, WAITING_EMAIL_WINDOW_MS, WAITING_LOOKBACK_MS,
};
