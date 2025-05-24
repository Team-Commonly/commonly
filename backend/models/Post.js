const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  image: { type: String, default: '' },
  likes: { type: Number, default: 0 },
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  tags: [{ type: String }],
  comments: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      text: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  createdAt: { type: Date, default: Date.now },
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
  ]).then((result) => (result[0]?.total || 0));
};

module.exports = mongoose.model('Post', postSchema);
