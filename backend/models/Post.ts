import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IPostSource {
  type: string;
  provider: string;
  externalId?: string | null;
  url?: string | null;
  author?: string | null;
  authorUrl?: string | null;
  channel?: string | null;
}

export interface IPostComment {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  text: string;
  replyTo?: Types.ObjectId | null;
  createdAt: Date;
}

export interface IPost extends Document {
  podId?: Types.ObjectId | null;
  userId: Types.ObjectId;
  content: string;
  image: string;
  category: string;
  source: IPostSource;
  likes: number;
  likedBy: Types.ObjectId[];
  tags: string[];
  comments: IPostComment[];
  createdAt: Date;
  agentCommentsDisabled: boolean;
}

export interface IPostModel extends Model<IPost> {
  getPostCount(userId: string | Types.ObjectId): Promise<number>;
  getCommentCount(userId: string | Types.ObjectId): Promise<number>;
}

const postSchema = new Schema<IPost, IPostModel>({
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', default: null },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  image: { type: String, default: '' },
  category: { type: String, default: 'General' },
  source: {
    type: { type: String, default: 'user' },
    provider: { type: String, default: 'internal' },
    externalId: { type: String, default: null },
    url: { type: String, default: null },
    author: { type: String, default: null },
    authorUrl: { type: String, default: null },
    channel: { type: String, default: null },
  },
  likes: { type: Number, default: 0 },
  likedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  tags: [{ type: String }],
  comments: [
    {
      userId: { type: Schema.Types.ObjectId, ref: 'User' },
      text: { type: String, required: true },
      replyTo: { type: Schema.Types.ObjectId, default: null },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  agentCommentsDisabled: { type: Boolean, default: false },
});

postSchema.statics.getPostCount = function (userId: string | Types.ObjectId) {
  return this.countDocuments({ userId });
};

postSchema.statics.getCommentCount = function (userId: string | Types.ObjectId) {
  return this.aggregate([
    { $unwind: '$comments' },
    { $match: { 'comments.userId': new mongoose.Types.ObjectId(userId.toString()) } },
    { $group: { _id: null, total: { $sum: 1 } } },
  ]).then((result: Array<{ total: number }>) => result[0]?.total || 0);
};

export default mongoose.model<IPost, IPostModel>('Post', postSchema);
