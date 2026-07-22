// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { sendEmail } = require('./emailService');

interface DigestRunResult {
  success?: boolean;
  digest?: { _id?: unknown };
}

interface DigestSummary {
  _id: unknown;
  title?: string;
  content?: string;
  metadata?: {
    totalItems?: number;
    userId?: string;
    emailedAt?: Date;
  };
}

interface DigestUser {
  _id: unknown;
  email?: string;
  verified?: boolean;
  isBot?: boolean;
  emailPreferences?: { dailyDigest?: boolean };
  digestUnsubscribeToken?: string;
  getOrCreateDigestUnsubscribeToken: () => string;
  save: () => Promise<unknown>;
}

export interface DigestEmailResult {
  eligible: number;
  sent: number;
  skipped: number;
  failed: number;
  unconfigured: boolean;
}

const primaryUrl = (raw: string | undefined, fallback: string): string => {
  const configured = String(raw || '').split(',').map((value) => value.trim()).filter(Boolean)[0];
  return (configured || fallback).replace(/\/$/, '');
};

const escapeHtml = (value: unknown): string => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const cleanMarkdownLine = (line: string): string => line
  .replace(/^[-*]\s+/, '')
  .replace(/^#+\s*/, '')
  .replace(/^>\s*/, '')
  .replace(/[*_`]/g, '')
  .trim();

export const extractTopItems = (content: string | undefined, limit = 5): string[] => {
  const lines = String(content || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^[-*]\s+/.test(line));
  const candidates = bullets.length > 0
    ? bullets
    : lines.filter((line) => !/^#|^>|^---+$/.test(line));
  return candidates.map(cleanMarkdownLine).filter(Boolean).slice(0, limit);
};

const buildEmailBodies = (summary: DigestSummary, unsubscribeToken: string) => {
  const title = summary.title || 'Your Commonly daily digest';
  const items = extractTopItems(summary.content);
  const frontendUrl = primaryUrl(process.env.FRONTEND_URL, 'http://localhost:3000');
  const backendUrl = primaryUrl(
    process.env.BACKEND_URL || process.env.COMMONLY_API_URL,
    'http://localhost:5000',
  );
  const appUrl = `${frontendUrl}/v2`;
  const unsubscribeUrl = `${backendUrl}/api/email/unsubscribe/${encodeURIComponent(unsubscribeToken)}`;
  const textItems = items.length > 0
    ? items.map((item) => `- ${item}`).join('\n')
    : 'Open Commonly to catch up on today\'s activity.';
  const htmlItems = items.length > 0
    ? `<ul style="margin:16px 0;padding-left:22px;color:#111827;line-height:1.55;">${items.map((item) => `<li style="margin:0 0 8px;">${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p style="margin:16px 0;color:#4b5563;line-height:1.55;">Open Commonly to catch up on today&#39;s activity.</p>';

  return {
    subject: title,
    textBody: `${title}\n\n${textItems}\n\nOpen Commonly: ${appUrl}\n\nUnsubscribe from daily digests: ${unsubscribeUrl}`,
    // Email clients cannot reliably consume the app's CSS variables, so these
    // inline values mirror the canonical Commonly tokens: accent, text,
    // border, and system-font stack. Digest content is escaped above.
    htmlBody: `<!doctype html><html><body style="margin:0;background:#f8f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;"><main style="max-width:600px;margin:0 auto;padding:32px 20px;"><section style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;"><h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;letter-spacing:-0.03em;">${escapeHtml(title)}</h1>${htmlItems}<p style="margin:24px 0 0;"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#2f6feb;color:#ffffff;text-decoration:none;font-weight:600;border-radius:8px;padding:10px 16px;">Open Commonly</a></p></section><p style="margin:16px 0 0;text-align:center;color:#7b8494;font-size:12px;line-height:1.45;">You receive this because daily digests are enabled for your Commonly account. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#2456c8;">Unsubscribe</a></p></main></body></html>`,
  };
};

export class DigestEmailService {
  async sendDigestEmails(currentRun: DigestRunResult[] = []): Promise<DigestEmailResult> {
    const result: DigestEmailResult = {
      eligible: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      unconfigured: false,
    };

    if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) {
      console.warn('Digest email delivery skipped: SMTP2GO is not configured.');
      result.unconfigured = true;
      return result;
    }

    const summaryIds = currentRun
      .filter((entry) => entry?.success && entry.digest?._id)
      .map((entry) => entry.digest?._id);
    if (summaryIds.length === 0) return result;

    const summaries = await Summary.find({
      _id: { $in: summaryIds },
      type: 'daily-digest',
      'metadata.totalItems': { $gt: 0 },
      'metadata.emailedAt': { $exists: false },
    }) as DigestSummary[];
    result.eligible = summaries.length;

    for (const summary of summaries) {
      const userId = summary.metadata?.userId;
      try {
        if (!userId) {
          result.skipped += 1;
          continue;
        }

        const user = await User.findById(userId)
          .select('+digestUnsubscribeToken email verified isBot emailPreferences') as DigestUser | null;
        if (!user?.email || user.verified !== true || user.isBot === true
          || user.emailPreferences?.dailyDigest === false) {
          result.skipped += 1;
          continue;
        }

        let unsubscribeToken = user.digestUnsubscribeToken;
        if (!unsubscribeToken) {
          unsubscribeToken = user.getOrCreateDigestUnsubscribeToken();
          await user.save();
        }

        // Claim before crossing the SMTP boundary. Email has no transactional
        // acknowledgement we can coordinate with MongoDB, so at-most-once is
        // the safer failure mode: a crash can drop one digest, but can never
        // deliver the same digest twice on a retry or concurrent cron run.
        const emailedAt = new Date();
        const claim = await Summary.updateOne(
          { _id: summary._id, 'metadata.emailedAt': { $exists: false } },
          { $set: { 'metadata.emailedAt': emailedAt } },
        );
        const claimed = Number(claim?.modifiedCount ?? claim?.nModified ?? 0) === 1;
        if (!claimed) {
          result.skipped += 1;
          continue;
        }
        if (summary.metadata) summary.metadata.emailedAt = emailedAt;

        const bodies = buildEmailBodies(summary, unsubscribeToken);
        await sendEmail({
          to: user.email,
          subject: bodies.subject,
          textBody: bodies.textBody,
          htmlBody: bodies.htmlBody,
        });

        result.sent += 1;
      } catch (error) {
        result.failed += 1;
        console.error('Digest email delivery failed:', {
          summaryId: String(summary._id || ''),
          userId: String(userId || ''),
          error: (error as Error)?.message || String(error),
        });
      }
    }

    return result;
  }
}

export default new DigestEmailService();
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
