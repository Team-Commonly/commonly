import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IDiscordMessageBuffer extends Document {
  integrationId: Types.ObjectId;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: Date;
  attachments: string[];
  reactions: string[];
  createdAt: Date;
  updatedAt: Date;
}

const DiscordMessageBufferSchema = new Schema<IDiscordMessageBuffer>(
  {
    integrationId: { type: Schema.Types.ObjectId, ref: 'Integration', required: true },
    messageId: { type: String, required: true },
    authorId: { type: String, required: true },
    authorName: { type: String, required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, required: true },
    attachments: [{ type: String }],
    reactions: [{ type: String }],
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'discord_message_buffer' },
);

DiscordMessageBufferSchema.index({ integrationId: 1, timestamp: -1 });
DiscordMessageBufferSchema.index({ messageId: 1 }, { unique: true });
DiscordMessageBufferSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export default mongoose.model<IDiscordMessageBuffer>('DiscordMessageBuffer', DiscordMessageBufferSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
