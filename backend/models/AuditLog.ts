/**
 * AuditLog — append-only record of security-relevant actions.
 *
 * Introduced for ADR-002 Phase 1b to log each attachment-token mint (who
 * requested a signed URL for which file, from which IP). The schema is kept
 * deliberately narrow: `action` is a free-form string so new audit-worthy
 * events can use the same collection without a model change, and the rest of
 * the fields cover the common "actor, target, when, where" shape.
 *
 * Retention and query patterns are deferred until a second use case exists.
 * TTL can be added later via a `createdAt` TTL index when needed.
 */

import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAuditLog extends Document {
  action: string;
  fileName?: string;
  // Generic target identifier for actions that aren't file-scoped (e.g. the
  // showcase publish toggle records the podId here). Added as the 2nd audit
  // use case; keep it free-form so future audit actions can reuse it.
  target?: string;
  // Optional free-form detail (e.g. the new value of a toggled flag).
  detail?: string;
  userId?: Types.ObjectId;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>({
  action: { type: String, required: true, index: true },
  fileName: { type: String, default: null },
  target: { type: String, default: null },
  detail: { type: String, default: null },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  ip: { type: String, default: null },
  userAgent: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
});

export default mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
