import crypto from 'crypto';
// eslint-disable-next-line global-require
const store = require('../repositories/emailReturnRepository');

/**
 * F519: does an email bring the person back? Every link in the digest, a
 * needs-you ask, a teammate's @mention and a waiting-on-your-agent note (F522)
 * carries ?em=<kind>.<send id>. The
 * id is random and names no one; the row it points at (email_sends) is
 * written only once the provider accepted the email. The first signed-in
 * visit that arrives with the tag marks the row returned, for the recipient
 * only. The stalled-connect lines ride the digest, so they count as digest.
 *
 * The tag is a query parameter because sign-in keeps the destination's query
 * through every path (safeNextPath on both ends, and Launch's #4138 for the
 * OAuth refusals), so a signed-out click still counts once they sign in.
 */

export const EMAIL_KINDS = ['digest', 'needs-you', 'mention', 'waiting'] as const;
export type EmailKind = typeof EMAIL_KINDS[number];

const TAG = /^(digest|needs-you|mention|waiting)\.([a-f0-9]{24})$/;

export const newSendId = (): string => crypto.randomBytes(12).toString('hex');

export const tagFor = (kind: EmailKind, sendId: string): string => `${kind}.${sendId}`;

export const parseTag = (raw: unknown): { kind: EmailKind; sendId: string } | null => {
  const match = typeof raw === 'string' ? TAG.exec(raw) : null;
  return match ? { kind: match[1] as EmailKind, sendId: match[2] } : null;
};

// Adds em=<tag> to a URL, keeping its own query and fragment.
export const tagUrl = (url: string, kind: EmailKind, sendId: string): string => {
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  return `${base}${base.includes('?') ? '&' : '?'}em=${encodeURIComponent(tagFor(kind, sendId))}${hash}`;
};

// After the provider accepted the email. Never throws: attribution must not
// turn a delivered email into a failed one.
export const noteSend = async (send: {
  sendId: string; kind: EmailKind; recipientUserId: unknown; podId?: unknown; sentAt?: Date;
}): Promise<void> => {
  try {
    await store.recordSend({
      sendId: send.sendId,
      kind: send.kind,
      recipientUserId: String(send.recipientUserId),
      podId: send.podId ? String(send.podId) : null,
      sentAt: send.sentAt || new Date(),
    });
  } catch (error) {
    console.warn('[email-return] send could not be recorded:', (error as Error).message);
  }
};

/**
 * A signed-in visit arrived with a tag. Records the first return for the
 * recipient; anyone else's visit, a repeat or an unknown tag records nothing.
 * The caller has already applied the usage-events consent rules. Never throws.
 */
export const recordEmailReturn = async (userId: unknown, rawTag: unknown, at: Date = new Date()): Promise<boolean> => {
  const tag = parseTag(rawTag);
  if (!tag || !userId) return false;
  try {
    return await store.recordReturn(tag.sendId, tag.kind, String(userId), at);
  } catch (error) {
    console.warn('[email-return] return could not be recorded:', (error as Error).message);
    return false;
  }
};

export const emailReturnCounts = async (since: Date) => store.countsSince(since);

export default {
  EMAIL_KINDS, newSendId, tagFor, parseTag, tagUrl, noteSend, recordEmailReturn, emailReturnCounts,
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  EMAIL_KINDS, newSendId, tagFor, parseTag, tagUrl, noteSend, recordEmailReturn, emailReturnCounts,
};
