const User = require('../models/User');
const Activity = require('../models/Activity');
const Post = require('../models/Post');
const Pod = require('../models/Pod');
const AgentIdentityService = require('../services/agentIdentityService');
const { normalizeAvatarUrl } = require('../services/avatarService');
const {
  isValidUsername,
  isFreeUsername,
} = require('../services/derivedUsername');

// Credentials. These must never reach a response body under any circumstance,
// not even the account's own profile: `apiToken` is a live `cm_` bearer that
// authenticates as this user (middleware/auth.ts), and `agentRuntimeTokens`
// carries agent runtime credentials. The UI receives a freshly minted token
// from POST /api/auth/api-token/generate, which is the only place it belongs.
const SECRET_USER_FIELDS = [
  'password',
  'apiToken',
  'agentRuntimeTokens',
  'deviceTokens',
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

// Reservation metadata is used only by username availability checks. It is
// not part of a profile response: historical message text remains the only
// public record of the previous handle.
const INTERNAL_USER_FIELDS = ['previousUsernames', 'accountDeletionRequestedAt'];

const isValidAccountLabel = (value: unknown) => typeof value === 'string'
  && value.trim().length > 0
  && value.trim().length <= 80;

// The chat author slot renders a single human label. Match its identity rule
// with an indexed, case-insensitive lookup so two accounts cannot save labels
// that appear identical there. `strength: 2` keeps accent distinctions while
// folding case (for example, `Lily` and `lIlY`).
const ACCOUNT_LABEL_COLLATION = { locale: 'en', strength: 2 };

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
  for (const field of INTERNAL_USER_FIELDS) delete plain[field];

  const isSelf = Boolean(viewerIdStr && String(userDoc._id) === viewerIdStr);
  if (!isSelf) {
    for (const field of PRIVATE_USER_FIELDS) delete plain[field];
  }

  // Agent User rows keep their durable seat username for authentication and
  // routing (for example, `vale`). The social surface must use the same
  // curated identity label as the rest of the product (for example, `Vale`).
  // Human usernames stay routable while the optional display name is the
  // presentation label chosen in Settings.
  const displayName = userDoc.isBot
    ? AgentIdentityService.resolveAgentDisplayLabel(userDoc, userDoc.username)
    : userDoc.displayName || userDoc.username;

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
    const { username, displayName, bio, profilePicture } = req.body;

    // The username is set when the account is made. This route edits the
    // profile around it: name, bio and picture.
    if (username !== undefined) {
      return res.status(400).json({
        error: 'The username can\'t be changed here.',
        code: 'username_not_editable',
      });
    }

    if (displayName !== undefined) {
      if (!isValidAccountLabel(displayName)) {
        return res.status(400).json({ error: 'Name must be between 1 and 80 characters.' });
      }

      const normalizedDisplayName = displayName.trim();
      const nameOwner = await User.findOne({
        _id: { $ne: req.user.id },
        $or: [
          { username: normalizedDisplayName },
          { displayName: normalizedDisplayName },
          { 'botMetadata.displayName': normalizedDisplayName },
        ],
      })
        .collation(ACCOUNT_LABEL_COLLATION)
        .select('_id');

      if (nameOwner) {
        return res.status(400).json({ error: 'That name belongs to someone else here' });
      }
    }

    // Build user object
    const userFields: any = {};
    if (displayName !== undefined) userFields.displayName = displayName.trim();
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
    if (!user) return res.status(404).json({ msg: 'User not found' });
    const synced = await AgentIdentityService.syncUserToPostgreSQL(user);
    // A name save changes the display column that PostgreSQL chat joins read.
    // Do not claim success when that mirror failed: a retry of the same Save
    // re-runs the idempotent update and brings the render path into sync.
    if (displayName !== undefined && synced === false) {
      return res.status(503).json({
        error: 'Your name was saved, but chat is catching up. Please save again in a moment.',
      });
    }

    res.json(toSocialProfile(user, req.user.id));
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// Rename the routable handle without changing historical message text. The
// old handle is stored as a reservation on the same account: it remains
// unavailable to new accounts, but the mention pipeline only reads the
// current `username`, so future @old-handle mentions do not route.
exports.updateUsername = async (req: any, res: any) => {
  try {
    const requestedUsername = String(req.body?.username || '').trim().toLowerCase();
    if (!isValidUsername(requestedUsername)) {
      return res.status(400).json({
        error: 'Username must be 2-40 lowercase letters, digits, or hyphens, starting with a letter or digit.',
        code: 'invalid_username',
      });
    }

    const currentUser = await User.findById(req.user.id).select('_id username isBot');
    if (!currentUser) return res.status(404).json({ msg: 'User not found' });
    if (currentUser.isBot) {
      return res.status(400).json({
        error: 'Agent usernames cannot be changed here.',
        code: 'username_not_editable',
      });
    }

    const currentUsername = String(currentUser.username || '');
    if (currentUsername.toLowerCase() === requestedUsername) {
      const unchanged = await User.findById(req.user.id).select('-password');
      return res.json(toSocialProfile(unchanged, req.user.id));
    }

    if (!await isFreeUsername(requestedUsername, req.user.id)) {
      return res.status(409).json({
        error: 'That username is already taken.',
        code: 'username_taken',
      });
    }

    let user;
    try {
      user = await User.findOneAndUpdate(
        { _id: req.user.id },
        {
          $set: { username: requestedUsername },
          $addToSet: { previousUsernames: currentUsername.toLowerCase() },
        },
        { new: true },
      ).select('-password');
    } catch (error: any) {
      if (error?.code === 11000) {
        return res.status(409).json({
          error: 'That username is already taken.',
          code: 'username_taken',
        });
      }
      throw error;
    }

    if (!user) return res.status(404).json({ msg: 'User not found' });
    const synced = await AgentIdentityService.syncUserToPostgreSQL(user);
    if (synced === false) {
      return res.status(503).json({
        error: 'Your username was saved, but chat is catching up. Please try again in a moment.',
        code: 'username_sync_pending',
      });
    }

    return res.json(toSocialProfile(user, req.user.id));
  } catch (err: any) {
    console.error(err.message);
    return res.status(500).send('Server Error');
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
