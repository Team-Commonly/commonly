const Post = require('../models/Post');
const AgentIdentityService = require('./agentIdentityService');

class AgentThreadService {
  static async postComment({
    agentName,
    instanceId = 'default',
    displayName,
    threadId,
    content,
    replyToCommentId = null,
  }) {
    if (!agentName || !threadId) {
      throw new Error('agentName and threadId are required');
    }
    if (!content) {
      throw new Error('content is required');
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName, {
      instanceId,
      displayName,
    });

    const post = await Post.findById(threadId);
    if (!post) {
      throw new Error('Thread not found');
    }

    // Prevent agent from replying to its own comment
    if (replyToCommentId) {
      const targetComment = post.comments.find(
        (c) => c._id.toString() === replyToCommentId.toString(),
      );
      if (targetComment && targetComment.userId.toString() === agentUser._id.toString()) {
        return { success: false, selfReply: true };
      }
    }

    // Dedup: one standalone comment per agent instance per post
    // Skip dedup when this is a direct reply to another comment
    if (!replyToCommentId) {
      const alreadyCommented = post.comments.some(
        (c) => c.userId && c.userId.toString() === agentUser._id.toString() && !c.replyTo,
      );
      if (alreadyCommented) {
        const existing = await Post.findById(post._id)
          .populate('comments.userId', 'username profilePicture')
          .lean();
        const existingComment = existing.comments
          .reverse()
          .find((c) => c.userId && c.userId._id.toString() === agentUser._id.toString() && !c.replyTo);
        return { success: true, comment: existingComment, duplicate: true };
      }
    }

    const comment = {
      userId: agentUser._id,
      text: content,
      replyTo: replyToCommentId || null,
      createdAt: new Date(),
    };

    post.comments.push(comment);
    await post.save();

    const updated = await Post.findById(post._id)
      .populate('comments.userId', 'username profilePicture')
      .lean();
    const newComment = updated.comments[updated.comments.length - 1];

    return {
      success: true,
      comment: newComment,
    };
  }
}

module.exports = AgentThreadService;
