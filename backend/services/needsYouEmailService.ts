import crypto from 'crypto';
import { isReservedEmailDomain } from '../utils/reservedEmailDomain';
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const NeedsYouEmail = require('../models/NeedsYouEmail');
// eslint-disable-next-line global-require
const NeedsYouEmailQuota = require('../models/NeedsYouEmailQuota');
// eslint-disable-next-line global-require
const { sendEmail } = require('./emailService');

type EmailItem = {
  _id: unknown;
  recipientUserId: unknown;
  title: string;
  detail?: string;
  podName?: string;
  actorName?: string;
};

const primaryUrl = (raw: string | undefined, fallback: string): string => (
  String(raw || '').split(',').map((value) => value.trim()).find(Boolean) || fallback
).replace(/\/$/, '');

const escapeHtml = (value: unknown): string => String(value || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A row is claimed before crossing the mail provider boundary. A retry never
// sends the same ask twice, even when a source writer retries after a timeout.
export const sendNeedsYouEmail = async (item: EmailItem): Promise<void> => {
  let claimedId: unknown = null;
  try {
    const user = await User.findById(item.recipientUserId)
      .select('+digestUnsubscribeToken email verified isBot lastActive emailPreferences');
    if (!user?.email || user.verified !== true || user.isBot === true
      || user.emailPreferences?.needsYou === false || isReservedEmailDomain(user.email)) return;
    const now = new Date();
    if (user.lastActive && now.getTime() - new Date(user.lastActive).getTime() < 10 * 60 * 1000) return;
    if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) return;

    const clickToken = crypto.randomBytes(24).toString('hex');
    let claim;
    try {
      claim = await NeedsYouEmail.create({
        attentionItemId: item._id, recipientUserId: item.recipientUserId,
        clickToken, status: 'claimed',
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return;
      throw error;
    }
    claimedId = claim._id;

    const day = now.toISOString().slice(0, 10);
    try {
      await NeedsYouEmailQuota.updateOne(
        { recipientUserId: item.recipientUserId, day },
        { $setOnInsert: { count: 0 } }, { upsert: true },
      );
    } catch (error) {
      // Another worker won the day's unique row. Both can contend for one of
      // its three slots below; no fourth email can be claimed.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const slot = await NeedsYouEmailQuota.findOneAndUpdate(
      { recipientUserId: item.recipientUserId, day, count: { $lt: 3 } },
      { $inc: { count: 1 } }, { new: true },
    );
    if (!slot) {
      await NeedsYouEmail.updateOne({ _id: claim._id }, { $set: { status: 'overflow' } });
      return;
    }

    let unsubscribeToken = user.digestUnsubscribeToken;
    if (!unsubscribeToken) {
      const candidate = crypto.randomBytes(24).toString('hex');
      await User.updateOne(
        { _id: user._id, digestUnsubscribeToken: { $exists: false } },
        { $set: { digestUnsubscribeToken: candidate } },
      );
      const saved = await User.findById(user._id).select('+digestUnsubscribeToken');
      unsubscribeToken = saved?.digestUnsubscribeToken;
      if (!unsubscribeToken) throw new Error('Unsubscribe token could not be saved');
    }
    const backendUrl = primaryUrl(process.env.BACKEND_URL || process.env.COMMONLY_API_URL, 'http://localhost:5000');
    const clickUrl = `${backendUrl}/api/email/needs-you/open/${clickToken}`;
    const unsubscribeUrl = `${backendUrl}/api/email/unsubscribe/needs-you/${unsubscribeToken}`;
    const agent = String(item.actorName || 'Your agent').trim();
    const pod = String(item.podName || 'a pod').trim();
    const ask = String(item.detail || item.title || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const subject = `${agent} needs you in ${pod}`;
    await sendEmail({
      to: user.email,
      subject,
      textBody: `${subject}\n\n${ask}\n\nOpen the item: ${clickUrl}\n\nTurn off needs-you emails: ${unsubscribeUrl}`,
      htmlBody: `<!doctype html><html><body style="margin:0;background:#eef0f4;font-family:Arial,sans-serif;color:#101828"><main style="max-width:560px;margin:0 auto;padding:32px 20px"><section style="background:#fff;border:1px solid #d0d5dd;border-radius:6px;padding:24px"><h1 style="font-size:24px;margin:0 0 16px">${escapeHtml(agent)} needs you</h1><p style="color:#475467">In ${escapeHtml(pod)}</p><p>${escapeHtml(ask)}</p><p><a href="${escapeHtml(clickUrl)}" style="color:#1d3fd1">Open the item</a></p></section><p style="font-size:12px;color:#667085"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#1d3fd1">Turn off needs-you emails</a></p></main></body></html>`,
    });
    await NeedsYouEmail.updateOne({ _id: claim._id }, { $set: { status: 'sent', sentAt: now } });
  } catch (error) {
    if (claimedId) {
      try {
        await NeedsYouEmail.updateOne({ _id: claimedId }, { $set: { status: 'failed' } });
      } catch (markError) {
        console.warn('[needs-you-email] failure stamp could not be saved:', (markError as Error).message);
      }
    }
    console.warn('[needs-you-email] delivery failed:', (error as Error).message);
  }
};

export const recordNeedsYouClick = async (token: string): Promise<string | null> => {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const row = await NeedsYouEmail.findOne({ clickToken: token }).select('+clickToken attentionItemId');
  if (!row) return null;
  await NeedsYouEmail.updateOne({ _id: row._id, clickedAt: { $exists: false } }, { $set: { clickedAt: new Date() } });
  const frontendUrl = primaryUrl(process.env.FRONTEND_URL, 'http://localhost:3000');
  return `${frontendUrl}/v2/activity?item=${encodeURIComponent(String(row.attentionItemId))}`;
};
