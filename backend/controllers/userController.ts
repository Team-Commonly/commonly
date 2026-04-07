import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Activity = require('../models/Activity');
// eslint-disable-next-line global-require
const Post = require('../models/Post');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const AgentIdentityService = require('../services/agentIdentityService');

interface AuthRequest extends Request {
  userId?: string;
  user?: { id: string };
}

exports.getCurrentProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const user = await User.findById(userId).select('-password');
    if (!user) {
      res.status(404).json({ msg: 'User not found' });
      return;
    }
    res.json(user);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const { username, bio, profilePicture } = req.body as {
      username?: string;
      bio?: string;
      profilePicture?: string;
    };
    const update: Record<string, unknown> = {};
    if (username !== undefined) update.username = username;
    if (bio !== undefined) update.bio = bio;
    if (profilePicture !== undefined) update.profilePicture = profilePicture;
    const user = await User.findByIdAndUpdate(userId, update, { new: true }).select('-password');
    if (!user) {
      res.status(404).json({ msg: 'User not found' });
      return;
    }
    res.json(user);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getUserById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      res.status(404).json({ msg: 'User not found' });
      return;
    }
    res.json(user);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'User not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.getUserPublicActivity = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.params.id).select('-password') as {
      _id: unknown; username: string;
    } | null;
    if (!user) {
      res.status(404).json({ msg: 'User not found' });
      return;
    }
    const [posts, pods] = await Promise.all([
      Post.find({ userId: user._id, podId: null })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      Pod.find({ members: user._id })
        .populate('createdBy', 'username profilePicture')
        .lean(),
    ]);
    res.json({
      userId: user._id,
      username: user.username,
      recentPublicPosts: posts,
      joinedPods: pods,
    });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.followUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const actorId = req.userId || req.user?.id;
    const targetId = req.params.id;
    const [actor, target] = await Promise.all([
      User.findById(actorId),
      User.findById(targetId),
    ]);
    if (!actor || !target) {
      res.status(404).json({ msg: 'User not found' });
      return;
    }
    if (!actor.following) actor.following = [];
    if (!target.followers) target.followers = [];
    const alreadyFollowing = actor.following.some((id: { toString(): string }) => id.toString() === targetId);
    if (!alreadyFollowing) {
      actor.following.push(targetId);
      target.followers.push(actorId);
      await Promise.all([actor.save(), target.save()]);
    }
    res.json({
      success: true,
      following: true,
      target: { id: target._id, username: target.username, followersCount: target.followers.length },
      actor: { id: actor._id, username: actor.username, followingCount: actor.following.length },
    });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.unfollowUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const actorId = req.userId || req.user?.id;
    const targetId = req.params.id;
    const [actor, target] = await Promise.all([
      User.findById(actorId),
      User.findById(targetId),
    ]);
    if (!actor || !target) {
      res.status(404).json({ msg: 'User not found' });
      return;
    }
    if (actor.following) {
      actor.following = actor.following.filter((id: { toString(): string }) => id.toString() !== targetId);
    }
    if (target.followers) {
      target.followers = target.followers.filter((id: { toString(): string }) => id.toString() !== actorId);
    }
    await Promise.all([actor.save(), target.save()]);
    res.json({
      success: true,
      following: false,
      target: { id: target._id, username: target.username, followersCount: (target.followers || []).length },
      actor: { id: actor._id, username: actor.username, followingCount: (actor.following || []).length },
    });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};
