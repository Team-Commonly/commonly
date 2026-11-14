import crypto from 'crypto';
import mongoose from 'mongoose';
import { escapeHtml } from '../utils/escape';
import { isReservedEmailDomain } from '../utils/reservedEmailDomain';
// eslint-disable-next-line global-require
const AttentionItem = require('../models/AttentionItem');
// eslint-disable-next-line global-require
const MentionEmailState = require('../models/MentionEmailState');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const PodVisit = require('../models/PodVisit');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { sendEmail } = require('./emailService');
// eslint-disable-next-line global-require
const { providerAccepted, digestSendingState } = require('./digestEmailService');
// eslint-disable-next-line global-require
const { isListedPodMember } = require('../utils/isPodMember');

/**
 * F512: a person's @mention of another person emails them once if they have
 * not opened that pod about 15 minutes later. Before this, every 'mention'
 * row skipped email (#2559), so a teammate's ask waited for the next digest.
 *
 * Ruling (Cofounder, 11-14): mentions written by people only, since an agent's
 * real asks already email as decision, approval, blocked or handoff. Never the
 * author (the mention writer already excludes them). One email per recipient
 * per pod per 6h; later mentions stay open and ride the digest. The digest
 * opt-out and the digest sending switch apply, and it goes out through the
 * same SMTP2GO path.
 *
 * A cron pass rather than a timer, so a restart cannot drop a pending email:
 * each pass re-derives what is due from the open rows.
 */

const MIN = 60 * 1000;
export const MENTION_EMAIL_DELAY_MS = 15 * MIN;
export const MENTION_EMAIL_WINDOW_MS = 6 * 60 * MIN;
// The first pass after a deploy must not mail out the backlog, and a row a
// long outage held back is the digest's by then.
const CATCH_UP_MS = 2 * 60 * MIN;
// A process that dies never stamps the close, so "open now" expires.
const OPEN_STALE_MS = 12 * 60 * MIN;
const BATCH = 200;

const validIds = (...ids: unknown[]): boolean => ids.every((id) => mongoose.isValidObjectId(id));

const upsertVisit = async (userId: unknown, podId: unknown, update: Record<string, unknown>): Promise<void> => {
  try {
    await PodVisit.updateOne({ userId, podId }, update, { upsert: true });
  } catch (error) {
    // Two first visits raced on the unique row; the loser's stamp still lands.
    if ((error as { code?: number }).code !== 11000) throw error;
    await PodVisit.updateOne({ userId, podId }, update);
  }
};

// Never throws: a visit stamp must not fail a message read or a socket join.
export const stampPodOpened = async (userId: unknown, podId: unknown, at: Date = new Date()): Promise<void> => {
  if (!validIds(userId, podId)) return;
  try {
    await upsertVisit(userId, podId, { $max: { openedAt: at } });
  } catch (error) {
    console.warn('[mention-email] pod open stamp failed:', (error as Error).message);
  }
};

export const stampPodClosed = async (userId: unknown, podIds: unknown[], at: Date = new Date()): Promise<void> => {
  await Promise.all((podIds || []).map(async (podId) => {
    if (!validIds(userId, podId)) return;
    try {
      await upsertVisit(userId, podId, { $max: { closedAt: at } });
    } catch (error) {
      console.warn('[mention-email] pod close stamp failed:', (error as Error).message);
    }
  }));
};

// Express middleware for a pod read: stamps the open once the read succeeded,
// so a refused read of someone else's pod stamps nothing. The time is the
// request's arrival: a leave that lands while the read is in flight must stay
// later than the open, or a quick click-through reads as "open now" for 12h.
export const stampPodOpenedOnRead = (req: any, res: any, next: () => void): void => {
  const userId = req.userId || req.user?.id;
  const podId = req.params?.podId;
  const at = new Date();
  if (userId && podId && typeof res.on === 'function') {
    res.on('finish', () => {
      if (res.statusCode < 400) void stampPodOpened(userId, podId, at);
    });
  }
  next();
};

const sawIt = (visit: any, mentionAt: number, now: number): boolean => {
  if (!visit) return false;
  const opened = visit.openedAt ? new Date(visit.openedAt).getTime() : 0;
  const closed = visit.closedAt ? new Date(visit.closedAt).getTime() : 0;
  if (opened >= mentionAt || closed >= mentionAt) return true;
  return opened > closed && now - opened < OPEN_STALE_MS;
};

const primaryUrl = (raw: string | undefined, fallback: string): string => (
  String(raw || '').split(',').map((value) => value.trim()).find(Boolean) || fallback
).replace(/\/$/, '');

const unsubscribeTokenFor = async (user: any): Promise<string> => {
  if (user.digestUnsubscribeToken) return user.digestUnsubscribeToken;
  const candidate = crypto.randomBytes(24).toString('hex');
  await User.updateOne(
    { _id: user._id, digestUnsubscribeToken: { $exists: false } },
    { $set: { digestUnsubscribeToken: candidate } },
  );
  const saved = await User.findById(user._id).select('+digestUnsubscribeToken');
  if (!saved?.digestUnsubscribeToken) throw new Error('Unsubscribe token could not be saved');
  return saved.digestUnsubscribeToken;
};

const deliver = async (user: any, row: any): Promise<void> => {
  const frontendUrl = primaryUrl(process.env.FRONTEND_URL, 'http://localhost:3000');
  const backendUrl = primaryUrl(process.env.BACKEND_URL || process.env.COMMONLY_API_URL, 'http://localhost:5000');
  const podUrl = `${frontendUrl}/v2/pods/${encodeURIComponent(String(row.podId))}`;
  const unsubscribeUrl = `${backendUrl}/api/email/unsubscribe/${encodeURIComponent(await unsubscribeTokenFor(user))}`;
  // Who and where, never what: pod text can be private, and a preview pane
  // shows the body to anyone near the screen.
  const subject = `${row.actorName || 'Someone'} mentioned you in ${row.podName || 'a pod'}`;
  const response = await sendEmail({
    to: user.email,
    subject,
    textBody: `${subject}\n\nOpen the pod: ${podUrl}\n\nTurn off these emails and the daily digest: ${unsubscribeUrl}`,
    htmlBody: `<!doctype html><html><body style="margin:0;background:#f8f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;"><main style="max-width:560px;margin:0 auto;padding:32px 20px;"><section style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;"><h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">${escapeHtml(subject)}</h1><p style="margin:0;"><a href="${escapeHtml(podUrl)}" style="display:inline-block;background:#2f6feb;color:#ffffff;text-decoration:none;font-weight:600;border-radius:8px;padding:10px 16px;">Open the pod</a></p></section><p style="margin:16px 0 0;text-align:center;color:#7b8494;font-size:12px;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#2456c8;">Turn off these emails and the daily digest</a></p></main></body></html>`,
  });
  if (!providerAccepted(response)) throw new Error('provider did not accept the email');
};

type Outcome = 'sent' | 'skipped' | 'failed';

const decide = async (row: any, now: Date): Promise<Outcome | null> => {
  // Claim the row first: whichever pass wins decides it, once.
  const claimed = await AttentionItem.updateOne(
    { _id: row._id, status: 'open', mentionEmailCheckedAt: { $exists: false } },
    { $set: { mentionEmailCheckedAt: now } },
    { timestamps: false },
  );
  if (!claimed.modifiedCount) return null;

  if (!row.actorUserId) return 'skipped';
  const author = await User.findById(row.actorUserId).select('isBot').lean();
  if (!author || author.isBot === true) return 'skipped';

  const user = await User.findById(row.recipientUserId)
    .select('+digestUnsubscribeToken email verified isBot emailPreferences');
  if (!user?.email || user.verified !== true || user.isBot === true
    || user.emailPreferences?.dailyDigest === false || isReservedEmailDomain(user.email)) return 'skipped';

  const pod = await Pod.findById(row.podId).select('_id members').lean();
  if (!pod || !isListedPodMember(pod, user._id)) return 'skipped';

  const mentionAt = new Date(row.sourceCreatedAt || row.createdAt).getTime();
  const visit = await PodVisit.findOne({ userId: user._id, podId: row.podId }).lean();
  if (sawIt(visit, mentionAt, now.getTime())) return 'skipped';

  // The 6h window, claimed before the provider call. An existing row inside
  // the window makes the upsert insert, which the unique index refuses.
  let previous: Date | undefined;
  try {
    const before = await MentionEmailState.findOneAndUpdate(
      {
        recipientUserId: user._id,
        podId: row.podId,
        $or: [
          { lastEmailAt: { $exists: false } },
          { lastEmailAt: { $lte: new Date(now.getTime() - MENTION_EMAIL_WINDOW_MS) } },
        ],
      },
      { $set: { lastEmailAt: now, attentionItemId: row._id } },
      { upsert: true, new: false },
    ).lean();
    previous = before?.lastEmailAt;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return 'skipped';
    throw error;
  }

  try {
    await deliver(user, row);
    return 'sent';
  } catch (error) {
    // A timeout or a dropped connection with no answer may still have been
    // accepted. Keep the claim: a missed email beats one every pass.
    const err = error as { isAxiosError?: boolean; response?: unknown; message?: string };
    if (err.isAxiosError && !err.response) {
      console.warn('[mention-email] no answer from the provider; not retrying:', err.message);
      return 'failed';
    }
    console.warn('[mention-email] delivery failed; the next pass retries:', err.message);
    // Give the window and the row back, so a refused send is not a used one.
    try {
      await MentionEmailState.updateOne(
        { recipientUserId: user._id, podId: row.podId, lastEmailAt: now },
        previous ? { $set: { lastEmailAt: previous } } : { $unset: { lastEmailAt: 1 } },
      );
      await AttentionItem.updateOne(
        { _id: row._id, mentionEmailCheckedAt: now },
        { $unset: { mentionEmailCheckedAt: 1 } },
        { timestamps: false },
      );
    } catch (releaseError) {
      console.warn('[mention-email] release after a failed send failed:', (releaseError as Error).message);
    }
    return 'failed';
  }
};

export const sweepMentionEmails = async (
  { now = new Date() }: { now?: Date } = {},
): Promise<{ scanned: number; sent: number; skipped: number; failed: number; disabled?: boolean }> => {
  const result = { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) return { ...result, disabled: true };
  if (await digestSendingState() !== 'on') return { ...result, disabled: true };
  // Nothing can be told "seen" from "not seen" before the first visit stamp
  // existed, so the first passes after rollout don't mail mentions people
  // already read on the old image.
  const firstVisit = await PodVisit.findOne({}).sort({ _id: 1 }).select('_id').lean();
  if (!firstVisit) return result;
  const floor = new Date(Math.max(now.getTime() - CATCH_UP_MS, firstVisit._id.getTimestamp().getTime()));
  const due = new Date(now.getTime() - MENTION_EMAIL_DELAY_MS);
  // The mention's own time decides, not the row's: a backfill re-records old
  // mentions with a fresh createdAt.
  const rows = await AttentionItem.find({
    kind: 'mention',
    status: 'open',
    mentionEmailCheckedAt: { $exists: false },
    createdAt: { $lte: due, $gte: floor },
    $or: [
      { sourceCreatedAt: { $gte: floor, $lte: due } },
      { sourceCreatedAt: { $exists: false } },
    ],
  }).sort({ createdAt: 1 }).limit(BATCH).lean();
  for (const row of rows) {
    result.scanned += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await decide(row, now);
      if (outcome) result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      console.warn('[mention-email] row failed; the next pass retries:', (error as Error).message);
      // eslint-disable-next-line no-await-in-loop
      await AttentionItem.updateOne(
        { _id: row._id, mentionEmailCheckedAt: now },
        { $unset: { mentionEmailCheckedAt: 1 } },
        { timestamps: false },
      ).catch(() => undefined);
    }
  }
  return result;
};

export default { sweepMentionEmails, stampPodOpened, stampPodClosed, stampPodOpenedOnRead };
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  sweepMentionEmails, stampPodOpened, stampPodClosed, stampPodOpenedOnRead,
  MENTION_EMAIL_DELAY_MS, MENTION_EMAIL_WINDOW_MS,
};
