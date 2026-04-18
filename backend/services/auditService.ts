/**
 * auditService — thin wrapper over the AuditLog model so route code doesn't
 * import the model directly. Introduced for ADR-002 Phase 1b; grows as more
 * call sites adopt the pattern.
 *
 * Writes are fire-and-forget: a DB failure here must never block the calling
 * route (e.g. failing to record an audit line shouldn't 500 a signed-URL
 * mint). Errors are logged and swallowed.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AuditLog = require('../models/AuditLog');

export const ACTION_ATTACHMENT_TOKEN_MINT = 'attachment.token.mint';

interface AttachmentMintEntry {
  fileName: string;
  userId: string;
  ip?: string;
  userAgent?: string;
}

export async function logAttachmentTokenMint(entry: AttachmentMintEntry): Promise<void> {
  try {
    await AuditLog.create({
      action: ACTION_ATTACHMENT_TOKEN_MINT,
      fileName: entry.fileName,
      userId: entry.userId,
      ip: entry.ip || null,
      userAgent: entry.userAgent || null,
    });
  } catch (err) {
    const e = err as { message?: string };
    console.error('auditService.logAttachmentTokenMint failed:', e.message);
  }
}
