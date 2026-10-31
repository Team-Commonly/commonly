import mongoose, { Document, Model, Schema, Types } from 'mongoose';

// 'card' (ADR-020 D3): a message whose meaning lives in `payload`, not
// regex-sniffed out of `content`. The union and the schema enum below are
// declared independently — change BOTH.
export type MessageType = 'text' | 'image' | 'system' | 'card';
export type MessageAuthorKind = 'kernel' | null;

export interface IMessage extends Document {
  podId: Types.ObjectId;
  userId: Types.ObjectId;
  content: string;
  messageType: MessageType;
  /** Trusted Commonly-authored prose posted beside an agent identity. */
  authorKind?: MessageAuthorKind;
  // Structured component payload (approval cards). Mixed like
  // AgentEvent.payload; null/absent for ordinary messages.
  payload?: unknown;
  // Free-form service metadata. agentMessageService has passed this to the
  // constructor since forever, but strict-mode Mongoose silently DROPPED it
  // because the schema never declared it — declared now so the Mongo
  // fallback path stops losing it.
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  freshnessPending?: boolean;
  freshnessCommittedAt?: Date;
  // Set once `copyOne` (services/legacyMessageCopy) has written this message
  // into Postgres (reconciledPgId is the PG row). Set-once: its updateOne
  // filters on its absence, so concurrent copies cannot re-stamp.
  reconciledAt?: Date;
  reconciledPgId?: number;
  // Written by the removed TASK-313 reconciler; kept so existing rows load.
  reconcileFailedAt?: Date;
  reconcileError?: string;
  reconcileRetryAt?: Date;
  /** Written by the removed PG-outage fallback (TASK-503); history only. */
  pgFallback?: boolean;
}

const MessageSchema = new Schema<IMessage>({
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  messageType: {
    type: String,
    enum: ['text', 'image', 'system', 'card'],
    default: 'text',
  },
  // Trusted server-authored prose that shares an agent seat's identity.
  // Ordinary human and agent posts remain null.
  authorKind: { type: String, enum: ['kernel', null], default: null },
  payload: { type: Schema.Types.Mixed },
  metadata: { type: Schema.Types.Mixed },
  // Client pagination and the PG timestamp parser require four-digit years.
  // JS/Mongo accept extended ISO years (e.g. +078915), which PG rejects when
  // a client sends the stored value back as its pagination cursor.
  createdAt: {
    type: Date, default: Date.now, required: true,
    min: new Date('0001-01-01T00:00:00.000Z'),
    max: new Date('9999-12-31T23:59:59.999Z'),
  },
  updatedAt: { type: Date, default: Date.now },
  // New Mongo-only writes start pending. The post-save hook stamps a server
  // commit marker after the insert is acknowledged; a crash before that stamp
  // leaves pending=true, which makes the send-time hold fail closed.
  freshnessPending: { type: Boolean },
  freshnessCommittedAt: { type: Date },
  reconciledAt: { type: Date },
  reconciledPgId: { type: Number },
  reconcileFailedAt: { type: Date },
  reconcileError: { type: String },
  reconcileRetryAt: { type: Date },
  pgFallback: { type: Boolean },
});

// Pending fallback work is small; keep the bounded scan off legacy history.
MessageSchema.index(
  { pgFallback: 1, reconcileRetryAt: 1, createdAt: 1, _id: 1 },
  { partialFilterExpression: { pgFallback: true } },
);

MessageSchema.pre('save', function rememberWhetherThisIsANewPost(next) {
  (this as any).$locals.wasNewPost = this.isNew;
  if (this.isNew) this.freshnessPending = true;
  next();
});

MessageSchema.post('save', async (doc) => {
  if ((doc as any).$locals?.wasNewPost) {
    try {
      await (doc.constructor as Model<IMessage>).updateOne(
        { _id: doc._id },
        { $set: { freshnessPending: false }, $currentDate: { freshnessCommittedAt: true } },
      );
    } catch (error) {
      // The insert already committed. Keep its pending marker (a safe hold)
      // rather than report failure and invite a duplicate Mongo fallback.
      console.warn('[Message] freshness commit stamp failed:', (error as Error).message);
    }
  }
  // Mongo is the availability fallback for chat writes, so it must materialize
  // the same recipient-owned fact as the normal PostgreSQL writer.
  // eslint-disable-next-line global-require
  const {
    recordMentionedUsers,
    resolveMentionAttentionForReply,
  } = require('../services/attentionItemService');
  await recordMentionedUsers(doc);
  if ((doc as any).$locals?.wasNewPost) {
    await resolveMentionAttentionForReply({
      podId: doc.podId,
      recipientUserId: doc.userId,
      repliedAt: doc.createdAt,
    });
  }
});

MessageSchema.post('findOneAndDelete', async (doc) => {
  if (!doc) return;
  // eslint-disable-next-line global-require
  const { resolve } = require('../services/attentionItemService');
  await resolve('message', doc._id);
});

export const Message: Model<IMessage> = mongoose.model<IMessage>('Message', MessageSchema);

export default Message;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
