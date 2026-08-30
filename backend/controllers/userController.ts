const User = require('../models/User');
const Activity = require('../models/Activity');
const Post = require('../models/Post');
const Pod = require('../models/Pod');
const AgentIdentityService = require('../services/agentIdentityService');
const { normalizeAvatarUrl } = require('../services/avatarService');

// Credentials. These must never reach a response body under any circumstance,
// not even the account's own profile: `apiToken` is a live `cm_` bearer that
// authenticates as this user (middleware/auth.ts), and `agentRuntimeTokens`
// carries agent runtime credentials. The UI receives a freshly minted token
// from POST /api/auth/api-token/generate, which is the only place it belongs.
const SECRET_USER_FIELDS = [
  'password',
  'apiToken',
  'agentRuntimeTokens',
  'digestUnsubscribeToken',
];

// Account-private, but legitimately visible to the account holder (and to an
// admin). Leaking these to any logged-in stranger is what turned a profile
// lookup into an enumeration tool: `GET /api/users/:id` used to return another
// user's email and their plaintext apiToken to any authenticated caller.
const PRIVATE_USER_FIELDS = [
  'email',
  'emailPreferences',
  'digestPreferences',
  'entitlements',
  'apiTokenScopes',
  'apiTokenCreatedAt',
  'authProviders',
  'contacts',
  'activityFeed',
  'banned',
  'banReason',
];

/**
 * Serialize a user for a response.
 *
 * `viewerId` is the caller. When it does not match the profile's owner, the
 * account-private block is dropped as well as the secrets. Secrets are dropped
 * unconditionally — a spread of `toObject()` is how they escaped before, so
 * the deletion happens here rather than relying on every call site to project
 * correctly.
 */
const toSocialProfile = (userDoc: any, viewerId: any = null) => {
  const followers = Array.isArray(userDoc.followers) ? userDoc.followers : [];
  const following = Array.isArray(userDoc.following) ? userDoc.following : [];
  const viewerIdStr = viewerId ? String(viewerId) : null;
  const isFollowing = Boolean(
    viewerIdStr && followers.some((id: any) => String(id) === viewerIdStr),
  );

  const plain = typeof userDoc.toObject === 'function' ? userDoc.toObject() : { ...userDoc };
  for (const field of SECRET_USER_FIELDS) delete plain[field];

  const isSelf = Boolean(viewerIdStr && String(userDoc._id) === viewerIdStr);
  if (!isSelf) {
    for (const field of PRIVATE_USER_FIELDS) delete plain[field];
  }

  // Agent User rows keep their durable seat username for authentication and
  // routing (for example, `vale`). The social surface must use the same
  // curated identity label as the rest of the product (for example, `Vale`).
  // Humans intentionally retain their username: their display label is not a
  // separate identity field.
  const displayName = userDoc.isBot
    ? AgentIdentityService.resolveAgentDisplayLabel(userDoc, userDoc.username)
    : userDoc.username;

  return {
    ...plain,
    displayName,
    followersCount: followers.length,
    followingCount: following.length,
    followedThreadsCount: Array.isArray(userDoc.followedThreads) ? userDoc.followedThreads.length : 0,
    isFollowing,
  };
};

// Get current user profile
exports.getCurrentProfile = async (req: any, res: any) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.json(toSocialProfile(user, req.user.id));
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// Update user profile
exports.updateProfile = async (req: any, res: any) => {
  try {
    const { username, bio, profilePicture } = req.body;

    // Build user object
    const userFields: any = {};
    if (username) userFields.username = username;
    if (bio) userFields.bio = bio;
    if (profilePicture !== undefined) {
      userFields.profilePicture = normalizeAvatarUrl(profilePicture);
    }

    // Update user
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: userFields },
      { new: true },
    ).select('-password');
    await AgentIdentityService.syncUserToPostgreSQL(user);

    res.json(toSocialProfile(user, req.user.id));
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// Get user by ID
exports.getUserById = async (req: any, res: any) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.json(toSocialProfile(user, req.user.id));
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'User not found' });
    }
    res.status(500).send('Server Error');
  }
};

exports.getUserPublicActivity = async (req: any, res: any) => {
  try {
    const targetUserId = String(req.params.id || '').trim();
    if (!targetUserId) {
      return res.status(400).json({ error: 'User id is required' });
    }

    const [user, recentPublicPosts, joinedPods] = await Promise.all([
      User.findById(targetUserId).select('_id username'),
      Post.find({ userId: targetUserId, podId: null })
        .select('_id content category createdAt likes comments source')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Pod.find({ members: targetUserId })
        .select('_id name type createdAt members createdBy')
        .populate('createdBy', 'username profilePicture')
        .sort({ updatedAt: -1 })
        .limit(8)
        .lean(),
    ]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      userId: user._id.toString(),
      username: user.username,
      recentPublicPosts: (recentPublicPosts || []).map((post: any) => ({
        id: post._id.toString(),
        content: post.content || '',
        category: post.category || 'General',
        createdAt: post.createdAt,
        likes: post.likes || 0,
        commentCount: Array.isArray(post.comments) ? post.comments.length : 0,
        sourceType: post.source?.type || 'user',
      })),
      joinedPods: (joinedPods || []).map((pod: any) => ({
        id: pod._id.toString(),
        name: pod.name || 'Untitled Pod',
        type: pod.type || 'chat',
        membersCount: Array.isArray(pod.members) ? pod.members.length : 0,
        createdAt: pod.createdAt,
        createdBy: pod.createdBy
          ? {
            id: pod.createdBy._id?.toString?.() || '',
            username: pod.createdBy.username || '',
            profilePicture: pod.createdBy.profilePicture || '',
          }
          : null,
      })),
    });
  } catch (err: any) {
    console.error(err.message);
    return res.status(500).send('Server Error');
  }
};

exports.followUser = async (req: any, res: any) => {
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

    const alreadyFollowing = (actor.following || []).some((id: any) => String(id) === targetUserId);
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
    } catch (activityError: any) {
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
  } catch (err: any) {
    console.error(err.message);
    return res.status(500).send('Server Error');
  }
};

exports.unfollowUser = async (req: any, res: any) => {
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

    actor.following = (actor.following || []).filter((id: any) => String(id) !== targetUserId);
    target.followers = (target.followers || []).filter((id: any) => String(id) !== actorUserId);
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
  } catch (err: any) {
    console.error(err.message);
    return res.status(500).send('Server Error');
  }
};

export {};
