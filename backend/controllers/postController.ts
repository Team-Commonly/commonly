import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const Post = require('../models/Post');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Activity = require('../models/Activity');

interface AuthRequest extends Request {
  userId?: string;
  user?: { id: string; username?: string };
}

interface CreatePostBody {
  content?: string;
  image?: string;
  tags?: string[];
  podId?: string | null;
  category?: string;
  source?: {
    type?: string;
    provider?: string;
    externalId?: string;
    url?: string;
    author?: string;
    authorUrl?: string;
    channel?: string;
  };
}

interface AddCommentBody {
  text?: string;
  podId?: string;
  replyToCommentId?: string;
}

interface GetPostsQuery {
  podId?: string;
  category?: string;
  sort?: string;
  page?: string;
  limit?: string;
}

interface SearchPostsQuery {
  query?: string;
  tags?: string;
  podId?: string;
  category?: string;
}

exports.createPost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const { content, image, tags, podId, category, source } = req.body as CreatePostBody;
    if (!content) {
      res.status(400).json({ msg: 'Content is required' });
      return;
    }
    const post = await Post.create({
      userId,
      content,
      image,
      tags: tags || [],
      podId: podId || null,
      category: category || 'General',
      source: source || null,
    });
    res.json(post);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getUserStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.params.id || req.userId || req.user?.id;
    const [postCount, commentCount] = await Promise.all([
      Post.countDocuments({ userId }),
      Post.countDocuments({ 'comments.userId': userId }),
    ]);
    res.json({ postCount, commentCount });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.searchPosts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { query, tags, podId, category } = req.query as SearchPostsQuery;
    const filter: Record<string, unknown> = {};
    if (podId) filter.podId = podId;
    if (category) filter.category = category;
    if (tags) filter.tags = { $in: tags.split(',').map((t) => t.trim()) };
    if (query) {
      filter.$text = { $search: query };
    }
    const posts = await Post.find(filter)
      .populate('userId', 'username profilePicture')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(posts);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getPosts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { podId, category, sort = 'recent', page = '1', limit = '20' } = req.query as GetPostsQuery;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = {};
    if (podId) filter.podId = podId;
    if (category) filter.category = category;

    const sortOrder = sort === 'hot' ? { likes: -1, createdAt: -1 } : { createdAt: -1 };

    const [posts, total] = await Promise.all([
      Post.find(filter)
        .populate('userId', 'username profilePicture')
        .sort(sortOrder)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Post.countDocuments(filter),
    ]);

    res.json({
      posts,
      hasMore: skip + posts.length < total,
      total,
      page: pageNum,
    });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getPostById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('userId', 'username profilePicture')
      .lean();
    if (!post) {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    res.json(post);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.addComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const { text, podId, replyToCommentId } = req.body as AddCommentBody;
    if (!text) {
      res.status(400).json({ msg: 'Comment text is required' });
      return;
    }
    const post = await Post.findById(req.params.id);
    if (!post) {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    const comment: Record<string, unknown> = { userId, text, createdAt: new Date() };
    if (replyToCommentId) comment.replyTo = replyToCommentId;
    post.comments.push(comment);
    await post.save();

    const savedComment = post.comments[post.comments.length - 1] as Record<string, unknown>;

    // Enqueue agent mentions (lazy import to avoid circular deps)
    try {
      // eslint-disable-next-line global-require
      const AgentMentionService = require('../services/agentMentionService');
      await AgentMentionService.enqueueMentions({
        podId: podId || post.podId,
        message: { id: savedComment._id, content: text, user_id: userId },
        userId,
        username: req.user?.username,
      });
    } catch (mentionErr) {
      const me = mentionErr as { message?: string };
      console.warn('AgentMentionService error on comment:', me.message);
    }

    res.json(post);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.likePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const post = await Post.findById(req.params.id) as {
      likes?: Array<{ toString(): string }>;
      save(): Promise<void>;
      _id: unknown;
    } | null;
    if (!post) {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    if (!post.likes) post.likes = [];
    const alreadyLiked = post.likes.some((id) => id.toString() === String(userId));
    if (alreadyLiked) {
      post.likes = post.likes.filter((id) => id.toString() !== String(userId));
    } else {
      post.likes.push(userId as unknown as { toString(): string });
    }
    await post.save();
    res.json({ likes: post.likes.length, liked: !alreadyLiked });
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.deletePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const post = await Post.findById(req.params.id) as { userId?: { toString(): string }; deleteOne?(): Promise<void> } | null;
    if (!post) {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    if (post.userId?.toString() !== String(userId)) {
      res.status(401).json({ msg: 'Not authorized to delete this post' });
      return;
    }
    await post.deleteOne?.();
    res.json({ msg: 'Post deleted' });
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.deleteComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const post = await Post.findById(req.params.id) as {
      comments: Array<{ _id: { toString(): string }; userId?: { toString(): string } }>;
      save(): Promise<void>;
    } | null;
    if (!post) {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    const comment = post.comments.find((c) => c._id.toString() === req.params.commentId);
    if (!comment) {
      res.status(404).json({ msg: 'Comment not found' });
      return;
    }
    if (comment.userId?.toString() !== String(userId)) {
      res.status(401).json({ msg: 'Not authorized to delete this comment' });
      return;
    }
    post.comments = post.comments.filter((c) => c._id.toString() !== req.params.commentId) as typeof post.comments;
    await post.save();
    res.json(post);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Post or comment not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.followThread = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    await User.findByIdAndUpdate(userId, { $addToSet: { followedThreads: req.params.id } });
    res.json({ msg: 'Thread followed' });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.unfollowThread = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    await User.findByIdAndUpdate(userId, { $pull: { followedThreads: req.params.id } });
    res.json({ msg: 'Thread unfollowed' });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.toggleAgentComments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const post = await Post.findById(req.params.id) as {
      userId?: { toString(): string };
      agentCommentsDisabled?: boolean;
      save(): Promise<void>;
    } | null;
    if (!post) {
      res.status(404).json({ msg: 'Post not found' });
      return;
    }
    if (post.userId?.toString() !== String(userId)) {
      res.status(401).json({ msg: 'Not authorized' });
      return;
    }
    post.agentCommentsDisabled = !post.agentCommentsDisabled;
    await post.save();
    res.json({ agentCommentsDisabled: post.agentCommentsDisabled });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getFollowedThreads = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const user = await User.findById(userId).select('followedThreads').lean() as {
      followedThreads?: string[];
    } | null;
    if (!user) {
      res.status(404).json({ msg: 'User not found' });
      return;
    }
    const threads = user.followedThreads || [];
    const posts = await Post.find({ _id: { $in: threads } })
      .populate('userId', 'username profilePicture')
      .lean();
    res.json(posts);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};
