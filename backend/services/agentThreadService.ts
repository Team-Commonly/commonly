import Post from '../models/Post';
import AgentIdentityService from './agentIdentityService';

interface PostCommentOptions {
  agentName: string;
  instanceId?: string;
  displayName?: string;
  threadId: string;
  content: string;
  replyToCommentId?: string | null;
}

interface PostCommentResult {
  success: boolean;
  comment?: unknown;
  duplicate?: boolean;
  agentCommentsDisabled?: boolean;
  selfReply?: boolean;
}

class AgentThreadService {
  static async postComment({
    agentName,
    instanceId = 'default',
    displayName,
    threadId,
    content,
    replyToCommentId = null,
  }: PostCommentOptions): Promise<PostCommentResult> {
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

    // Respect per-post agent comment opt-out
    if ((post as unknown as Record<string, unknown>).agentCommentsDisabled) {
      return { success: false, agentCommentsDisabled: true };
    }

    // Prevent agent from replying to its own comment
    if (replyToCommentId) {
      const postDoc = post as unknown as Record<string, unknown>;
      const comments = postDoc.comments as Array<Record<string, unknown>>;
      const targetComment = comments?.find(
        (c) => String(c._id) === replyToCommentId.toString(),
      );
      if (targetComment && targetComment.userId?.toString() === agentUser._id.toString()) {
        return { success: false, selfReply: true };
      }
    }

    // Dedup: one standalone comment per agent instance per post
    if (!replyToCommentId) {
      const postDoc = post as unknown as Record<string, unknown>;
      const comments = postDoc.comments as Array<Record<string, unknown>>;
      const alreadyCommented = comments?.some(
        (c) => c.userId && c.userId.toString() === agentUser._id.toString() && !c.replyTo,
      );
      if (alreadyCommented) {
        const existing = await Post.findById(post._id)
          .populate('comments.userId', 'username profilePicture')
          .lean() as unknown as Record<string, unknown>;
        const existingComments = (existing.comments as Array<Record<string, unknown>>);
        const existingComment = [...existingComments]
          .reverse()
          .find((c) => {
            const userId = c.userId as unknown as Record<string, unknown> | undefined;
            return userId && userId._id?.toString() === agentUser._id.toString() && !c.replyTo;
          });
        return { success: true, comment: existingComment, duplicate: true };
      }
    }

    const comment = {
      userId: agentUser._id,
      text: content,
      replyTo: replyToCommentId || null,
      createdAt: new Date(),
    };

    (post as unknown as Record<string, unknown[]>).comments.push(comment as never);
    await post.save();

    const updated = await Post.findById(post._id)
      .populate('comments.userId', 'username profilePicture')
      .lean() as unknown as Record<string, unknown>;
    const updatedComments = updated.comments as Array<unknown>;
    const newComment = updatedComments[updatedComments.length - 1];

    return {
      success: true,
      comment: newComment,
    };
  }
}

export default AgentThreadService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
