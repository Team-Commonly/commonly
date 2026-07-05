const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const User = require('../models/User');
const Pod = require('../models/Pod');
const InvitationCode = require('../models/InvitationCode');
const WaitlistRequest = require('../models/WaitlistRequest');
const AgentIdentityService = require('../services/agentIdentityService');

const SMTP2GO_BASE_URL = process.env.SMTP2GO_BASE_URL || 'https://api.smtp2go.com/v3';
const SMTP2GO_SEND_URL = `${SMTP2GO_BASE_URL.replace(/\/$/, '')}/email/send`;

const parseBooleanEnv = (value: any) => {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
};

const isInviteOnlyRegistrationEnabled = () => {
  const explicitValue = parseBooleanEnv(process.env.REGISTRATION_INVITE_ONLY);
  if (explicitValue !== null) return explicitValue;
  return process.env.NODE_ENV === 'production';
};

const getInvitationCodes = () => (process.env.REGISTRATION_INVITE_CODES || '')
  .split(',')
  .map((code) => code.trim())
  .filter(Boolean);

const normalizeInviteCode = (code: any) => String(code || '').trim();
const normalizeEmail = (email: any) => String(email || '').trim().toLowerCase();

const isEnvInvitationCodeValid = (code: any) => {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return false;
  return getInvitationCodes().includes(normalized);
};

const consumeDbInvitationCode = async (code: any) => {
  const now = new Date();
  const normalized = normalizeInviteCode(code).toUpperCase();
  if (!normalized) return null;

  return InvitationCode.findOneAndUpdate(
    {
      code: normalized,
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      $expr: { $lt: ['$useCount', '$maxUses'] },
    },
    {
      $inc: { useCount: 1 },
      $set: { lastUsedAt: now },
    },
    { new: true },
  );
};

// Length cap first: the pattern backtracks polynomially on adversarial
// long inputs (CodeQL js/polynomial-redos), and RFC 5321 caps addresses at
// 254 chars anyway — nothing longer is a deliverable email.
const isValidEmail = (email: any) => typeof email === 'string'
  && email.length <= 254
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Give every new signup a default private workspace pod so the BYO
// onboarding flow has a target to install/talk-to an agent in. Matches
// the Mongo Pod shape created by podController.createPod (type 'chat',
// creator = sole member); joinPolicy 'invite-only' keeps it private.
// Best-effort: a pod-create hiccup must never fail signup — the user
// can always create a pod from the UI later. Shared by password
// registration and the OAuth signup path (oauthController).
const createDefaultWorkspacePod = async (userId: any) => {
  try {
    const pod = await Pod.create({
      name: 'My Workspace',
      description: 'Your private workspace',
      type: 'chat',
      joinPolicy: 'invite-only',
      createdBy: userId,
      members: [userId],
    });

    // Starter checklist — scripted onboarding on the real task board (no
    // dedicated checklist UI to maintain). Matches tasksApi's TASK-###
    // numbering so later tasks continue the sequence. Best-effort, same as
    // the pod itself.
    try {
      // eslint-disable-next-line global-require
      const Task = require('../models/Task');
      const starter = [
        {
          sourceRef: 'onboarding:connect-agent',
          title: 'Connect your first agent',
          notes: 'Bring Claude Code, Cursor, or Codex: Agents → "Connect your own agent" generates a token your local agent uses to join this workspace. Takes about two minutes.',
        },
        {
          sourceRef: 'onboarding:first-task',
          title: 'Give your agent its first task',
          notes: '@mention it in this pod chat and ask for something real — agents here read context, do the work, and post results back.',
        },
        {
          sourceRef: 'onboarding:invite-teammate',
          title: 'Invite a teammate',
          notes: 'Workspaces are better shared — humans and agents in the same room, one project memory. Use the pod invite link from the inspector panel.',
        },
      ];
      // Distinct sourceRefs give each seed a stable identity under the
      // unique (podId, sourceRef) partial index — re-running the seeding
      // for a pod can never silently duplicate the checklist.
      await Task.create(starter.map((t, i) => ({
        podId: pod._id,
        taskNum: i + 1,
        taskId: `TASK-${String(i + 1).padStart(3, '0')}`,
        title: t.title,
        notes: t.notes,
        source: 'onboarding',
        sourceRef: t.sourceRef,
        updates: [],
      })));
    } catch (taskError: any) {
      console.warn('[register] starter checklist seeding failed:', taskError?.message);
    }
  } catch (podError: any) {
    console.warn('[register] default workspace pod creation failed:', podError?.message);
  }
};

// Redeem an invitation code: env codes are reusable (marketing links), DB
// codes consume a use. Since registration opened up (2026-07-03), a code no
// longer gates signup — it grants the hosted-agent entitlement
// (entitlements.cloudAgents). Returns true when the code is good.
const redeemInvitationCode = async (code: any) => {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return false;
  if (isEnvInvitationCodeValid(normalized)) return true;
  return Boolean(await consumeDbInvitationCode(normalized));
};

// Reused by oauthController so social signups honor the same invite gate.
exports.isInviteOnlyRegistrationEnabled = isInviteOnlyRegistrationEnabled;
exports.isEnvInvitationCodeValid = isEnvInvitationCodeValid;
exports.consumeDbInvitationCode = consumeDbInvitationCode;
exports.redeemInvitationCode = redeemInvitationCode;
exports.createDefaultWorkspacePod = createDefaultWorkspacePod;

// 📌 Register User
exports.register = async (req: any, res: any) => {
  try {
    const {
      username,
      email,
      password,
      invitationCode,
    } = req.body;

    const normalizedEmail = normalizeEmail(email);
    const normalizedUsername = String(username || '').trim();
    const rawPassword = String(password || '');

    if (!normalizedUsername || !normalizedEmail || !rawPassword) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    // Check if email or username already exists
    const existingUser = await User.findOne({
      $or: [
        { email: normalizedEmail },
        { username: normalizedUsername },
      ],
    });
    if (existingUser) {
      if (String(existingUser.email || '').toLowerCase() === normalizedEmail) {
        return res.status(400).json({ error: 'User already exists' });
      }
      return res.status(400).json({ error: 'Username already exists' });
    }

    // Invitation codes grant the hosted-agent entitlement. When the instance
    // still runs invite-only registration they additionally gate signup.
    // A provided-but-invalid code always fails loudly — the user typed it
    // expecting cloud access; silently dropping it would be worse.
    const normalizedInvitation = normalizeInviteCode(invitationCode);
    let invitationRedeemed = false;
    if (normalizedInvitation) {
      invitationRedeemed = await redeemInvitationCode(normalizedInvitation);
      if (!invitationRedeemed) {
        return res.status(403).json({
          error: 'Invalid invitation code.',
          code: 'INVITATION_INVALID',
        });
      }
    }

    if (isInviteOnlyRegistrationEnabled() && !invitationRedeemed) {
      const codes = getInvitationCodes();
      const activeDbCodeExists = await InvitationCode.exists({
        isActive: true,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      });
      if (!codes.length && !activeDbCodeExists) {
        return res.status(503).json({
          error: 'Registration is currently invite-only and invitation codes are not configured.',
          code: 'INVITATION_CONFIG_MISSING',
        });
      }
      return res.status(403).json({
        error: 'Invitation code is required before registration.',
        code: 'INVITATION_REQUIRED',
      });
    }

    const hasEmailConfig = Boolean(process.env.SMTP2GO_API_KEY)
      && Boolean(process.env.SMTP2GO_FROM_EMAIL)
      && Boolean(process.env.FRONTEND_URL);
    // When email is not configured there is no way to deliver a verification
    // link, so auto-verify regardless of NODE_ENV — otherwise a prod deploy
    // without SMTP would create verified=false accounts that login() permanently
    // blocks (no email ever arrives to unblock them).
    const shouldAutoVerify = !hasEmailConfig;
    if (shouldAutoVerify) {
      console.warn(
        'Auto-verifying new account because email delivery is not configured (SMTP2GO_API_KEY/SMTP2GO_FROM_EMAIL/FRONTEND_URL missing).',
      );
    }

    // Create new user instance. A redeemed invitation grants hosted-agent
    // access from day one; everyone else starts BYO-only.
    const user = new User({
      username: normalizedUsername,
      email: normalizedEmail,
      password: rawPassword,
      verified: shouldAutoVerify,
      entitlements: { cloudAgents: invitationRedeemed },
    });

    // Save user to database
    await user.save();

    await createDefaultWorkspacePod(user._id);

    if (hasEmailConfig) {
      // Generate email verification token
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
        expiresIn: '1d',
      });

      const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
      const html = `<p>Click the link below to verify your email:</p>
               <a href="${verifyUrl}">Verify Email</a>`;
      const text = `Click the link below to verify your email: ${verifyUrl}`;

      try {
        console.log('SMTP2GO send attempt:', {
          to: email,
          sender: process.env.SMTP2GO_FROM_EMAIL,
          fromName: process.env.SMTP2GO_FROM_NAME,
        });
        const smtpRes = await axios.post(SMTP2GO_SEND_URL, {
          api_key: process.env.SMTP2GO_API_KEY,
          to: [email],
          sender: process.env.SMTP2GO_FROM_EMAIL,
          from_name: process.env.SMTP2GO_FROM_NAME || 'Commonly',
          subject: 'Verify Your Email - Commonly',
          text_body: text,
          html_body: html,
        }, { timeout: 30000 });
        console.log('SMTP2GO send response:', smtpRes?.data);
      } catch (sendError: any) {
        console.error('SMTP2GO error during registration:', sendError?.response?.data || sendError.message);
        return res.status(502).json({
          error: 'Email delivery failed. Please verify SMTP2GO configuration.',
        });
      }
    }

    return res
      .status(201)
      .json({
        message: hasEmailConfig
          ? 'User registered successfully. Check your email for verification.'
          : 'User registered successfully. Email verification is not required.',
      });
  } catch (err: any) {
    console.error(err.message);
    if (err?.code === 11000) {
      const key = Object.keys(err.keyPattern || {})[0] || '';
      if (key === 'username') {
        return res.status(400).json({ error: 'Username already exists' });
      }
      if (key === 'email') {
        return res.status(400).json({ error: 'User already exists' });
      }
      return res.status(400).json({ error: 'Duplicate user record.' });
    }
    return res.status(500).json({ error: 'Server error' });
  }
};

// 📌 Redeem an invitation code on an existing account → grants the
// hosted-agent entitlement. The post-signup counterpart of the optional
// code field at registration: BYO users upgrade whenever they get a code.
exports.redeemInvitation = async (req: any, res: any) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.entitlements?.cloudAgents) {
      // Don't burn a use on an account that already has access.
      return res.json({
        message: 'Hosted agents are already unlocked for this account.',
        entitlements: user.entitlements,
      });
    }

    const redeemed = await redeemInvitationCode(req.body?.invitationCode);
    if (!redeemed) {
      return res.status(403).json({
        error: 'Invalid invitation code.',
        code: 'INVITATION_INVALID',
      });
    }

    user.entitlements = { ...(user.entitlements || {}), cloudAgents: true };
    await user.save();

    return res.json({
      message: 'Hosted agents unlocked.',
      entitlements: user.entitlements,
    });
  } catch (err: any) {
    console.error('Failed to redeem invitation:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.getRegistrationPolicy = async (_req: any, res: any) => {
  try {
    const inviteOnly = isInviteOnlyRegistrationEnabled();
    const activeDbCodeExists = await InvitationCode.exists({
      isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
    const hasInvitationCodes = getInvitationCodes().length > 0 || Boolean(activeDbCodeExists);
    return res.json({
      inviteOnly,
      invitationRequired: inviteOnly,
      hasInvitationCodes,
      registrationOpen: !inviteOnly || hasInvitationCodes,
    });
  } catch (err: any) {
    console.error(err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.requestWaitlist = async (req: any, res: any) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim();
    const organization = String(req.body?.organization || '').trim();
    const useCase = String(req.body?.useCase || '').trim();
    const note = String(req.body?.note || '').trim();

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        error: 'This email is already registered.',
        code: 'ALREADY_REGISTERED',
      });
    }

    const existingPending = await WaitlistRequest.findOne({ email, status: 'pending' });
    if (existingPending) {
      return res.status(200).json({
        message: 'Your waitlist request is already pending review.',
        requestId: existingPending._id,
      });
    }

    const created = await WaitlistRequest.create({
      email,
      name,
      organization,
      useCase,
      note,
      status: 'pending',
    });

    return res.status(201).json({
      message: 'Waitlist request submitted. A global admin can review and send an invitation code by email.',
      requestId: created._id,
    });
  } catch (err: any) {
    console.error('Failed to submit waitlist request:', err);
    return res.status(500).json({ error: 'Failed to submit waitlist request' });
  }
};

// ── Password reset ───────────────────────────────────────────────────────────
// Reset tokens are JWTs signed with JWT_SECRET + the user's current password
// hash: no server-side token state, yet the token self-invalidates the moment
// the password changes (single-use in effect). OAuth-only accounts (no
// password) can use this flow to ADD a password — they've proven control of
// the email, which is the same bar signup uses.

const resetTokenSecret = (user: any) => `${process.env.JWT_SECRET}:${user.password || 'oauth-only'}`;

// 📌 Forgot password — always 200 (no account enumeration)
exports.forgotPassword = async (req: any, res: any) => {
  const genericResponse = {
    message: 'If that email has an account, a reset link is on its way.',
  };
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) return res.json(genericResponse);

    const user = await User.findOne({ email, isBot: { $ne: true } });
    const hasEmailConfig = Boolean(process.env.SMTP2GO_API_KEY)
      && Boolean(process.env.SMTP2GO_FROM_EMAIL)
      && Boolean(process.env.FRONTEND_URL);
    if (!user || !hasEmailConfig) {
      if (user && !hasEmailConfig) {
        console.warn('[forgot-password] email delivery not configured; reset link not sent for', email);
      }
      return res.json(genericResponse);
    }

    const token = jwt.sign(
      { id: user._id, purpose: 'password-reset' },
      resetTokenSecret(user),
      { expiresIn: '1h' },
    );
    const resetUrl = `${process.env.FRONTEND_URL}/v2/reset-password?token=${token}`;
    try {
      await axios.post(SMTP2GO_SEND_URL, {
        api_key: process.env.SMTP2GO_API_KEY,
        to: [user.email],
        sender: process.env.SMTP2GO_FROM_EMAIL,
        from_name: process.env.SMTP2GO_FROM_NAME || 'Commonly',
        subject: 'Reset your password - Commonly',
        text_body: `Reset your Commonly password (link valid for 1 hour): ${resetUrl}\n\nIf you didn't request this, ignore this email — your password is unchanged.`,
        html_body: `<p>Reset your Commonly password (link valid for 1 hour):</p><a href="${resetUrl}">Reset password</a><p>If you didn't request this, ignore this email — your password is unchanged.</p>`,
      }, { timeout: 30000 });
    } catch (sendError: any) {
      console.error('SMTP2GO error during password reset:', sendError?.response?.data || sendError.message);
    }
    return res.json(genericResponse);
  } catch (err: any) {
    console.error('forgot-password failed:', err.message);
    return res.json(genericResponse);
  }
};

// 📌 Reset password — consumes the emailed token
exports.resetPassword = async (req: any, res: any) => {
  try {
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');
    if (!token || password.length < 8) {
      return res.status(400).json({ error: 'A reset token and a password of at least 8 characters are required.' });
    }

    // Decode (unverified) to find the user, then verify against the
    // per-user secret — this is what makes a used token dead: the password
    // hash it was signed against no longer exists.
    const decoded: any = jwt.decode(token);
    if (!decoded?.id || decoded.purpose !== 'password-reset') {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }
    const user = await User.findById(decoded.id);
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link.' });

    try {
      jwt.verify(token, resetTokenSecret(user));
    } catch {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }

    user.password = password; // pre-save hook hashes
    // Resetting via email proves address ownership — unblock login for
    // accounts that never finished the signup verification email.
    user.verified = true;
    await user.save();

    return res.json({ message: 'Password updated. You can sign in now.' });
  } catch (err: any) {
    console.error('reset-password failed:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};

// 📌 Verify Email
exports.verifyEmail = async (req: any, res: any) => {
  try {
    const { token } = req.query;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findByIdAndUpdate(
      decoded.id,
      { verified: true },
      { new: true },
    );
    if (!user) return res.status(400).json({ error: 'Invalid token' });

    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired token' });
  }
};

// 📌 Login User
exports.login = async (req: any, res: any) => {
  const { password } = req.body;
  // Coerce email to a string BEFORE it reaches Mongo. Without this a body like
  // {"email":{"$ne":null}} is interpreted as a query operator and matches an
  // arbitrary user (NoSQL injection → account enumeration). register/
  // forgotPassword already normalize; login was the gap.
  const email = normalizeEmail(req.body?.email);
  try {
    if (!email) return res.status(400).json({ error: 'User not found' });
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'User not found' });

    // Admin moderation: banned accounts cannot start a session.
    if (user.banned) {
      return res.status(403).json({ error: 'This account has been suspended.' });
    }

    // Check if the email is verified
    if (!user.verified) {
      return res
        .status(400)
        .json({ error: 'Email not verified. Please check your inbox.' });
    }

    // OAuth-only accounts have no password hash — send them to their provider
    // instead of letting bcrypt throw on an undefined hash.
    if (!user.password) {
      const providers = (user.authProviders || []).map((p: any) => p.provider).join(' or ');
      return res.status(400).json({
        error: `This account signs in with ${providers || 'a linked provider'}. Use the social sign-in button.`,
        code: 'OAUTH_ONLY_ACCOUNT',
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    return res.json({
      token,
      verified: user.verified,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        profilePicture: user.profilePicture,
        role: user.role,
      },
    });
  } catch (err: any) {
    console.error(err.message);
    return res.status(500).send('Server error');
  }
};

// 🔄 Refresh Token — issue a new 7d token from a still-valid token
exports.refresh = async (req: any, res: any) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    return res.json({ token });
  } catch (err: any) {
    console.error(err.message);
    return res.status(500).send('Server error');
  }
};

// New method to get user profile
exports.getProfile = async (req: any, res: any) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// Get current user information
exports.getCurrentUser = async (req: any, res: any) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// Update user profile
exports.updateProfile = async (req: any, res: any) => {
  try {
    const { profilePicture } = req.body;
    const userId = req.userId || req.user?.id;

    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update profile picture if provided
    if (profilePicture) {
      user.profilePicture = profilePicture;
    }

    await user.save();
    await AgentIdentityService.syncUserToPostgreSQL(user);

    // Return the updated user without the password
    const updatedUser = await User.findById(userId).select('-password');
    res.json(updatedUser);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export {};
