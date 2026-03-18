const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  podId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pod', default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  image: { type: String, default: '' },
  category: { type: String, default: 'General' },
  source: {
    type: {
      type: String,
      default: 'user',
    },
    provider: { type: String, default: 'internal' },
    externalId: { type: String, default: null },
    url: { type: String, default: null },
    author: { type: String, default: null },
    authorUrl: { type: String, default: null },
    channel: { type: String, default: null },
  },
  likes: { type: Number, default: 0 },
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  tags: [{ type: String }],
  comments: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      text: { type: String, required: true },
      replyTo: { type: mongoose.Schema.Types.ObjectId, default: null },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  agentCommentsDisabled: { type: Boolean, default: false },
});

// Static method to get post count for a user
postSchema.statics.getPostCount = function (userId) {
  return this.countDocuments({ userId });
};

// Static method to get comment count for a user
postSchema.statics.getCommentCount = function (userId) {
  return this.aggregate([
    { $unwind: '$comments' },
    { $match: { 'comments.userId': new mongoose.Types.ObjectId(userId) } },
    { $group: { _id: null, total: { $sum: 1 } } },
  ]).then((result) => result[0]?.total || 0);
};

module.exports = mongoose.model('Post', postSchema);
