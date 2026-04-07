import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type MessageType = 'text' | 'image' | 'system';

export interface IMessage extends Document {
  podId: Types.ObjectId;
  userId: Types.ObjectId;
  content: string;
  messageType: MessageType;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>({
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  messageType: {
    type: String,
    enum: ['text', 'image', 'system'],
    default: 'text',
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

export const Message: Model<IMessage> = mongoose.model<IMessage>('Message', MessageSchema);

export default Message;
