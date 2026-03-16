const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const User = require('../models/User');
const InvitationCode = require('../models/InvitationCode');
const WaitlistRequest = require('../models/WaitlistRequest');
const AgentIdentityService = require('../services/agentIdentityService');

const SMTP2GO_BASE_URL = process.env.SMTP2GO_BASE_URL || 'https://api.smtp2go.com/v3';
const SMTP2GO_SEND_URL = `${SMTP2GO_BASE_URL.replace(/\/$/, '')}/email/send`;

const parseBooleanEnv = (value) => {
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

const normalizeInviteCode = (code) => String(code || '').trim();
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const isEnvInvitationCodeValid = (code) => {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return false;
  return getInvitationCodes().includes(normalized);
};

const consumeDbInvitationCode = async (code) => {
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

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// 📌 Register User
exports.register = async (req, res) => {
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

    if (isInviteOnlyRegistrationEnabled()) {
      const normalizedInvitation = normalizeInviteCode(invitationCode);
      if (!normalizedInvitation) {
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

      const envCodeValid = isEnvInvitationCodeValid(normalizedInvitation);
      if (!envCodeValid) {
        const consumed = await consumeDbInvitationCode(normalizedInvitation);
        if (!consumed) {
          return res.status(403).json({
            error: 'Invalid invitation code.',
            code: 'INVITATION_INVALID',
          });
        }
      }
    }

    const hasEmailConfig = Boolean(process.env.SMTP2GO_API_KEY)
      && Boolean(process.env.SMTP2GO_FROM_EMAIL)
      && Boolean(process.env.FRONTEND_URL);
    const shouldAutoVerify = !hasEmailConfig && process.env.NODE_ENV !== 'production';

    // Create new user instance
    const user = new User({
      username: normalizedUsername,
      email: normalizedEmail,
      password: rawPassword,
      verified: shouldAutoVerify,
    });

    // Save user to database
    await user.save();

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
      } catch (sendError) {
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
          : 'User registered successfully. Email verification skipped in development.',
      });
  } catch (err) {
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

exports.getRegistrationPolicy = async (_req, res) => {
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
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.requestWaitlist = async (req, res) => {
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
  } catch (err) {
    console.error('Failed to submit waitlist request:', err);
    return res.status(500).json({ error: 'Failed to submit waitlist request' });
  }
};

// 📌 Verify Email
exports.verifyEmail = async (req, res) => {
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
exports.login = async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'User not found' });

    // Check if the email is verified
    if (!user.verified) {
      return res
        .status(400)
        .json({ error: 'Email not verified. Please check your inbox.' });
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
  } catch (err) {
    console.error(err.message);
    return res.status(500).send('Server error');
  }
};

// New method to get user profile
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get current user information
exports.getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update user profile
exports.updateProfile = async (req, res) => {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
