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
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  // New Mongo-only writes start pending. The post-save hook stamps a server
  // commit marker after the insert is acknowledged; a crash before that stamp
  // leaves pending=true, which makes the send-time hold fail closed.
  freshnessPending: { type: Boolean },
  freshnessCommittedAt: { type: Date },
});

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
