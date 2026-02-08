const User = require('../models/User');
const Activity = require('../models/Activity');
const AgentIdentityService = require('../services/agentIdentityService');

const toSocialProfile = (userDoc, viewerId = null) => {
  const followers = Array.isArray(userDoc.followers) ? userDoc.followers : [];
  const following = Array.isArray(userDoc.following) ? userDoc.following : [];
  const viewerIdStr = viewerId ? String(viewerId) : null;
  const isFollowing = Boolean(
    viewerIdStr && followers.some((id) => String(id) === viewerIdStr),
  );

  return {
    ...userDoc.toObject(),
    followersCount: followers.length,
    followingCount: following.length,
    followedThreadsCount: Array.isArray(userDoc.followedThreads) ? userDoc.followedThreads.length : 0,
    isFollowing,
  };
};

// Get current user profile
exports.getCurrentProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.json(toSocialProfile(user, req.user.id));
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// Update user profile
exports.updateProfile = async (req, res) => {
  try {
    const { username, bio, profilePicture } = req.body;

    // Build user object
    const userFields = {};
    if (username) userFields.username = username;
    if (bio) userFields.bio = bio;
    if (profilePicture) userFields.profilePicture = profilePicture;

    // Update user
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: userFields },
      { new: true },
    ).select('-password');
    await AgentIdentityService.syncUserToPostgreSQL(user);

    res.json(toSocialProfile(user, req.user.id));
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// Get user by ID
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.json(toSocialProfile(user, req.user.id));
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.status(500).send('Server Error');
  }
};

exports.followUser = async (req, res) => {
  try {
    const targetUserId = String(req.params.id || '');
    const actorUserId = String(req.userId || req.user?.id || '');

    if (!targetUserId) return res.status(400).json({ error: 'Target user is required' });
    if (targetUserId === actorUserId) {
      return res.status(400).json({ error: 'You cannot follow yourself' });
    }

    const [actor, target] = await Promise.all([
      User.findById(actorUserId).select('_id username following'),
      User.findById(targetUserId).select('_id username followers'),
    ]);

    if (!actor || !target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const alreadyFollowing = (actor.following || []).some((id) => String(id) === targetUserId);
    if (!alreadyFollowing) {
      actor.following = [...(actor.following || []), target._id];
      target.followers = [...(target.followers || []), actor._id];
      await Promise.all([actor.save(), target.save()]);
    }

    try {
      await Activity.create({
        type: 'pod_event',
        actor: {
          id: actor._id,
          name: actor.username,
          type: 'human',
          verified: false,
        },
        action: 'user_followed',
        content: `${actor.username} followed @${target.username}`,
        sourceType: 'event',
        sourceId: target._id.toString(),
        visibility: 'private',
        involves: [
          { id: actor._id, name: actor.username, type: 'human' },
          { id: target._id, name: target.username, type: 'human' },
        ],
      });
    } catch (activityError) {
      console.warn('followUser activity create failed:', activityError.message);
    }

    return res.json({
      success: true,
      following: true,
      target: {
        id: target._id.toString(),
        username: target.username,
        followersCount: target.followers?.length || 0,
      },
      actor: {
        id: actor._id.toString(),
        username: actor.username,
        followingCount: actor.following?.length || 0,
      },
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).send('Server Error');
  }
};

exports.unfollowUser = async (req, res) => {
  try {
    const targetUserId = String(req.params.id || '');
    const actorUserId = String(req.userId || req.user?.id || '');

    if (!targetUserId) return res.status(400).json({ error: 'Target user is required' });
    if (targetUserId === actorUserId) {
      return res.status(400).json({ error: 'You cannot unfollow yourself' });
    }

    const [actor, target] = await Promise.all([
      User.findById(actorUserId).select('_id username following'),
      User.findById(targetUserId).select('_id username followers'),
    ]);

    if (!actor || !target) {
      return res.status(404).json({ error: 'User not found' });
    }

    actor.following = (actor.following || []).filter((id) => String(id) !== targetUserId);
    target.followers = (target.followers || []).filter((id) => String(id) !== actorUserId);
    await Promise.all([actor.save(), target.save()]);

    return res.json({
      success: true,
      following: false,
      target: {
        id: target._id.toString(),
        username: target.username,
        followersCount: target.followers?.length || 0,
      },
      actor: {
        id: actor._id.toString(),
        username: actor.username,
        followingCount: actor.following?.length || 0,
      },
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).send('Server Error');
  }
};
