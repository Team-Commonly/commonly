import Post from '../models/Post';
import User from '../models/User';
import AgentIdentityService from './agentIdentityService';

interface PostCommentOptions {
  agentName: string;
  instanceId?: string;
  displayName?: string;
  threadId: string;
  content: string;
  replyToCommentId?: string | null;
  // The wrapper's reply for a comment @ (F225): the seat may already have
  // answered through commonly_post_thread_comment, which nothing but this
  // read can see. A tool call leaves it off, so "on it" then "done" both post.
  onlyIfUnanswered?: boolean;
}

interface PostCommentResult {
  success: boolean;
  comment?: unknown;
  duplicate?: boolean;
  agentCommentsDisabled?: boolean;
  selfReply?: boolean;
  skipped?: boolean;
  reason?: string;
}

class AgentThreadService {
  static async postComment({
    agentName,
    instanceId = 'default',
    displayName,
    threadId,
    content,
    replyToCommentId = null,
    onlyIfUnanswered = false,
  }: PostCommentOptions): Promise<PostCommentResult> {
    if (!agentName || !threadId) {
      throw new Error('agentName and threadId are required');
    }
    if (!content) {
      throw new Error('content is required');
    }

    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName, {
      instanceId,
      displayName,
    });

    const post = await Post.findById(threadId);
    if (!post) {
      throw new Error('Thread not found');
    }

    // The sentinel contract holds on a comment as it does in a pod: NO_REPLY
    // alone, or a reply opening with it, posts nothing. A lazy require, as the
    // other callers do: that module loads the whole event stack.
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const sanitized = require('./agentMessageService').sanitizeAgentContent(content, {
      agentName, instanceId, podId: (post as unknown as Record<string, unknown>).podId,
    });
    if (!sanitized) {
      return { success: true, skipped: true, reason: 'silent_or_empty' };
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
      // Only a threaded reply to this exact comment counts. An unthreaded one
      // may answer an earlier comment, and a double post beats a lost answer.
      if (onlyIfUnanswered) {
        const answer = comments?.find(
          (c) => c.userId?.toString() === agentUser._id.toString()
            && c.replyTo?.toString() === replyToCommentId.toString(),
        );
        if (answer) return { success: true, comment: answer, duplicate: true };
      }
    }

    // Dedup: one standalone comment per agent instance per post
    if (!replyToCommentId) {
      const postDoc = post as unknown as Record<string, unknown>;
      const comments = postDoc.comments as Array<Record<string, unknown>>;
      const alreadyCommented = comments?.some(
        (c) => c.userId && c.userId.toString() === agentUser._id.toString() && !c.replyTo,
      );
      // The rule is one standalone comment, not silence for good. A seat @'d on
      // this post that drops replyToCommentId would be handed its old comment
      // and end with NO_REPLY, so a person speaking since reopens it. Another
      // agent does not: two curators would take turns forever.
      const lastOwn = (comments || []).map((c) => c.userId?.toString()).lastIndexOf(agentUser._id.toString());
      const speakersSince = (comments || []).slice(lastOwn + 1).map((c) => c.userId).filter(Boolean);
      const personSpokeSince = alreadyCommented && speakersSince.length > 0
        && await User.exists({ _id: { $in: speakersSince }, isBot: { $ne: true } });
      if (alreadyCommented && !personSpokeSince) {
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
      text: sanitized,
      replyTo: replyToCommentId || null,
      createdAt: new Date(),
    };

    // The check above read a copy, and a redelivered mention can run a second
    // turn on the same comment, so here the write repeats the check.
    if (replyToCommentId && onlyIfUnanswered) {
      const pushed = await Post.updateOne(
        {
          _id: post._id,
          comments: { $not: { $elemMatch: { userId: agentUser._id, replyTo: replyToCommentId } } },
        },
        { $push: { comments: comment } },
      );
      if (pushed.modifiedCount === 0) {
        const raced = await Post.findById(post._id).lean() as unknown as Record<string, unknown>;
        const answer = (raced.comments as Array<Record<string, unknown>>).find(
          (c) => c.userId?.toString() === agentUser._id.toString()
            && c.replyTo?.toString() === replyToCommentId.toString(),
        );
        return { success: true, comment: answer, duplicate: true };
      }
    } else {
      (post as unknown as Record<string, unknown[]>).comments.push(comment as never);
      await post.save();
    }

    const updated = await Post.findById(post._id)
      .populate('comments.userId', 'username profilePicture')
      .lean() as unknown as Record<string, unknown>;
    const updatedComments = updated.comments as Array<Record<string, unknown>>;
    const ownReply = (c: Record<string, unknown>) => (c.userId as Record<string, unknown> | null)?._id?.toString()
      === agentUser._id.toString() && c.replyTo?.toString() === replyToCommentId?.toString();
    const newComment = replyToCommentId && onlyIfUnanswered
      ? updatedComments.find(ownReply)
      : updatedComments[updatedComments.length - 1];

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
