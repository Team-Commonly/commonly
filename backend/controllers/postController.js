const Post = require('../models/Post');
const Pod = require('../models/Pod');
const User = require('../models/User');
const Activity = require('../models/Activity');
const AgentMentionService = require('../services/agentMentionService');

exports.createPost = async (req, res) => {
  const {
    content,
    image,
    tags,
    podId,
    category,
    source,
  } = req.body;
  try {
    const resolvedPodId = podId || null;
    if (resolvedPodId) {
      const pod = await Pod.findById(resolvedPodId).select('_id members').lean();
      const isMember = pod?.members?.some(
        (memberId) => memberId.toString() === req.userId.toString(),
      );
      if (!isMember) {
        return res.status(403).json({ error: 'You are not a member of this pod' });
      }
    }

    const resolvedCategory = (category || '').trim() || 'General';
    const resolvedSource = source && typeof source === 'object'
      ? {
        type: source.type || (resolvedPodId ? 'pod' : 'user'),
        provider: source.provider || 'internal',
        externalId: source.externalId || null,
        url: source.url || null,
        author: source.author || null,
        authorUrl: source.authorUrl || null,
        channel: source.channel || null,
      }
      : {
        type: resolvedPodId ? 'pod' : 'user',
        provider: 'internal',
      };

    const post = new Post({
      userId: req.userId,
      content,
      image,
      tags,
      podId: resolvedPodId,
      category: resolvedCategory,
      source: resolvedSource,
    });
    await post.save();
    res.status(201).json(post);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get user statistics (post count and comment count)
exports.getUserStats = async (req, res) => {
  try {
    const { userId } = req.params;
    const postCount = await Post.getPostCount(userId);
    const commentCount = await Post.getCommentCount(userId);
    res.json({ postCount, commentCount });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Search posts by content or tags
exports.searchPosts = async (req, res) => {
  try {
    const { query, tags, podId, category } = req.query;
    const searchQuery = {};

    if (query) {
      searchQuery.$or = [
        { content: { $regex: query, $options: 'i' } },
        { 'comments.text': { $regex: query, $options: 'i' } },
      ];
    }

    if (tags) {
      const tagArray = tags.split(',').map((tag) => tag.trim());
      searchQuery.tags = { $in: tagArray };
    }

    if (podId) {
      if (podId === 'global' || podId === 'none') {
        searchQuery.podId = null;
      } else {
        searchQuery.podId = podId;
      }
    }

    if (category) {
      searchQuery.category = category;
    }

    const posts = await Post.find(searchQuery)
      .populate('userId', 'username profilePicture')
      .populate('comments.userId', 'username profilePicture')
      .populate('podId', 'name type')
      .populate('likedBy', '_id')
      .sort({ createdAt: -1 });

    res.json(posts);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getPosts = async (req, res) => {
  try {
    const { podId, category } = req.query;
    const filter = {};
    if (podId) {
      if (podId === 'global' || podId === 'none') {
        filter.podId = null;
      } else {
        filter.podId = podId;
      }
    }
    if (category) {
      filter.category = category;
    }

    const posts = await Post.find(filter)
      .populate('userId', 'username profilePicture')
      .populate('comments.userId', 'username profilePicture')
      .populate('podId', 'name type')
      .populate('likedBy', '_id')
      .sort({ createdAt: -1 });
    res.json(posts);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// New method to get a single post by ID
exports.getPostById = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('userId', 'username profilePicture')
      .populate('comments.userId', 'username profilePicture')
      .populate('podId', 'name type')
      .populate('likedBy', '_id');
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Add a comment to a post
exports.addComment = async (req, res) => {
  try {
    const { text, podId: requestPodId, replyToCommentId } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Comment text is required' });
    }

    const post = await Post.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const commentingUser = await User.findById(req.userId).select('_id username').lean();

    // Create the comment object
    const comment = {
      userId: req.userId,
      text,
      replyTo: replyToCommentId || null,
      createdAt: new Date(),
    };

    // Add the comment to the post's comments array
    post.comments.push(comment);

    // Save the updated post
    await post.save();

    // Populate the user information for the new comment and return it
    const updatedPost = await Post.findById(post._id)
      .populate('userId', 'username profilePicture')
      .populate('comments.userId', 'username profilePicture');

    // Return only the newly added comment with populated user information
    const newComment = updatedPost.comments[updatedPost.comments.length - 1];

    // Enqueue agent mentions if applicable (thread context)
    try {
      const resolveMentionPod = async () => {
        const candidate = requestPodId || post.podId;
        if (candidate) {
          const pod = await Pod.findById(candidate).select('_id members').lean();
          const isMember = pod?.members?.some(
            (memberId) => memberId.toString() === req.userId.toString(),
          );
          return isMember ? pod._id : null;
        }
        const fallback = await Pod.findOne({ members: req.userId }).select('_id').lean();
        return fallback?._id || null;
      };

      const mentionPodId = await resolveMentionPod();
      if (mentionPodId) {
        let username = req.user?.username || commentingUser?.username;
        if (!username) {
          const user = await User.findById(req.userId).select('username').lean();
          username = user?.username;
        }
        await AgentMentionService.enqueueMentions({
          podId: mentionPodId,
          message: {
            _id: comment._id,
            id: comment._id,
            content: text,
            messageType: 'thread',
            source: 'thread',
            createdAt: comment.createdAt,
            thread: {
              postId: post._id,
              postContent: post.content,
              postUserId: post.userId,
              commentId: comment._id,
              commentText: text,
            },
          },
          userId: req.userId,
          username,
        });
      }
    } catch (mentionError) {
      console.warn('Failed to enqueue thread mentions:', mentionError.message);
    }

    try {
      const displayPodId = requestPodId || post.podId || null;
      await Activity.create({
        type: 'pod_event',
        actor: {
          id: req.userId,
          name: commentingUser?.username || req.user?.username || 'User',
          type: 'human',
          verified: false,
        },
        action: 'thread_comment',
        content: `New reply on thread: ${(post.content || '').slice(0, 120)}`,
        podId: displayPodId || undefined,
        sourceType: 'event',
        sourceId: post._id.toString(),
        visibility: 'pod',
        target: {
          title: `Thread reply by @${commentingUser?.username || 'user'}`,
          description: text.slice(0, 180),
          url: `/thread/${post._id}`,
        },
        involves: [
          {
            id: post.userId,
            name: 'thread-owner',
            type: 'human',
          },
        ],
      });
    } catch (activityError) {
      console.warn('Failed to create thread comment activity:', activityError.message);
    }

    res.status(201).json(newComment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Like a post
exports.likePost = async (req, res) => {
  try {
    const postId = req.params.id;
    const { userId } = req;

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if user has already liked this post
    const userLikedIndex = post.likedBy ? post.likedBy.indexOf(userId) : -1;

    if (userLikedIndex === -1) {
      // User hasn't liked the post yet, add like
      if (!post.likedBy) {
        post.likedBy = [];
      }
      post.likedBy.push(userId);
      post.likes += 1;
    } else {
      // User already liked the post, remove like
      post.likedBy.splice(userLikedIndex, 1);
      post.likes = Math.max(0, post.likes - 1);
    }

    await post.save();
    res.json({ likes: post.likes, liked: userLikedIndex === -1 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete a post
exports.deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if the user is the owner of the post
    if (post.userId.toString() !== req.userId) {
      return res
        .status(403)
        .json({ error: 'You are not authorized to delete this post' });
    }

    await Post.findByIdAndDelete(req.params.id);
    res.json({ message: 'Post deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Delete a comment
exports.deleteComment = async (req, res) => {
  try {
    const { id, commentId } = req.params;

    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Find the comment index
    const commentIndex = post.comments.findIndex(
      (comment) => comment._id.toString() === commentId,
    );

    if (commentIndex === -1) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    // Check if the user is the owner of the comment
    if (post.comments[commentIndex].userId.toString() !== req.userId) {
      return res
        .status(403)
        .json({ error: 'You are not authorized to delete this comment' });
    }

    // Remove the comment using splice
    post.comments.splice(commentIndex, 1);
    await post.save();

    res.json({ message: 'Comment deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.followThread = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select('_id content');
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const user = await User.findById(req.userId).select('_id username followedThreads');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const alreadyFollowing = (user.followedThreads || []).some(
      (thread) => String(thread.postId) === String(post._id),
    );

    if (!alreadyFollowing) {
      user.followedThreads = [
        ...(user.followedThreads || []),
        { postId: post._id, followedAt: new Date() },
      ];
      await user.save();
    }

    try {
      await Activity.create({
        type: 'pod_event',
        actor: {
          id: user._id,
          name: user.username,
          type: 'human',
          verified: false,
        },
        action: 'thread_followed',
        content: `${user.username} followed a thread`,
        sourceType: 'event',
        sourceId: post._id.toString(),
        visibility: 'private',
        target: {
          title: 'Followed thread',
          description: (post.content || '').slice(0, 180),
          url: `/thread/${post._id}`,
        },
        involves: [{ id: user._id, name: user.username, type: 'human' }],
      });
    } catch (activityError) {
      console.warn('Failed to create thread follow activity:', activityError.message);
    }

    return res.json({
      success: true,
      followed: true,
      postId: post._id.toString(),
      followedThreadsCount: user.followedThreads?.length || 0,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

exports.unfollowThread = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select('_id');
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const user = await User.findById(req.userId).select('_id followedThreads');
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.followedThreads = (user.followedThreads || []).filter(
      (thread) => String(thread.postId) !== String(post._id),
    );
    await user.save();

    return res.json({
      success: true,
      followed: false,
      postId: post._id.toString(),
      followedThreadsCount: user.followedThreads?.length || 0,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

exports.getFollowedThreads = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('followedThreads');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const followedThreads = user.followedThreads || [];
    if (!followedThreads.length) {
      return res.json({ threads: [] });
    }

    const postIds = followedThreads.map((thread) => thread.postId);
    const followedAtMap = new Map(
      followedThreads.map((thread) => [String(thread.postId), thread.followedAt || null]),
    );

    const posts = await Post.find({ _id: { $in: postIds } })
      .populate('userId', 'username profilePicture')
      .populate('comments.userId', 'username profilePicture')
      .populate('podId', 'name type')
      .sort({ createdAt: -1 })
      .lean();

    const normalized = posts.map((post) => ({
      ...post,
      followedAt: followedAtMap.get(String(post._id)) || null,
    }));

    return res.json({ threads: normalized });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};
