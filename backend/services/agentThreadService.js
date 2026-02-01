const Post = require('../models/Post');
const AgentIdentityService = require('./agentIdentityService');

class AgentThreadService {
  static async postComment({
    agentName,
    instanceId = 'default',
    displayName,
    threadId,
    content,
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

    const comment = {
      userId: agentUser._id,
      text: content,
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
