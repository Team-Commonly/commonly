import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const bcryptjs = require('bcryptjs');
// eslint-disable-next-line global-require
const jwt = require('jsonwebtoken');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const InvitationCode = require('../models/InvitationCode');
// eslint-disable-next-line global-require
const WaitlistRequest = require('../models/WaitlistRequest');
// eslint-disable-next-line global-require
const AgentIdentityService = require('../services/agentIdentityService');

interface AuthRequest extends Request {
  userId?: string;
  user?: { id: string };
}

interface RegisterBody {
  username?: string;
  email?: string;
  password?: string;
  invitationCode?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
}

interface WaitlistBody {
  email?: string;
  name?: string;
  organization?: string;
  useCase?: string;
  note?: string;
}

exports.register = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { username, email, password, invitationCode } = req.body as RegisterBody;
    if (!username || !email || !password) {
      res.status(400).json({ msg: 'Username, email and password are required' });
      return;
    }

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      res.status(400).json({ msg: 'User already exists' });
      return;
    }

    const salt = await bcryptjs.genSalt(10);
    const hashedPassword = await bcryptjs.hash(password, salt);

    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      invitationCode: invitationCode || null,
    });

    const payload = { user: { id: user._id } };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      verified: user.emailVerified || false,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        profilePicture: user.profilePicture,
        role: user.role,
      },
    });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getRegistrationPolicy = async (_req: Request, res: Response): Promise<void> => {
  try {
    const inviteCount = await InvitationCode.countDocuments({ isUsed: false });
    res.json({
      inviteOnly: process.env.INVITE_ONLY === 'true',
      invitationRequired: process.env.INVITATION_REQUIRED === 'true',
      hasInvitationCodes: inviteCount > 0,
      registrationOpen: process.env.REGISTRATION_OPEN !== 'false',
    });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.requestWaitlist = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, name, organization, useCase, note } = req.body as WaitlistBody;
    if (!email) {
      res.status(400).json({ msg: 'Email is required' });
      return;
    }
    const existing = await WaitlistRequest.findOne({ email });
    if (existing) {
      res.json({ msg: 'Already on waitlist', exists: true });
      return;
    }
    await WaitlistRequest.create({ email, name, organization, useCase, note });
    res.json({ msg: 'Added to waitlist', exists: false });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.verifyEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token } = req.query as { token?: string };
    if (!token) {
      res.status(400).json({ msg: 'Token is required' });
      return;
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as { user?: { id?: string } };
    const userId = decoded?.user?.id;
    if (!userId) {
      res.status(400).json({ msg: 'Invalid token' });
      return;
    }
    await User.findByIdAndUpdate(userId, { emailVerified: true });
    res.json({ msg: 'Email verified' });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(400).json({ msg: 'Invalid or expired token' });
  }
};

exports.login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body as LoginBody;
    if (!email || !password) {
      res.status(400).json({ msg: 'Email and password are required' });
      return;
    }

    const user = await User.findOne({ email });
    if (!user) {
      res.status(400).json({ msg: 'Invalid credentials' });
      return;
    }

    const isMatch = await bcryptjs.compare(password, user.password);
    if (!isMatch) {
      res.status(400).json({ msg: 'Invalid credentials' });
      return;
    }

    const payload = { user: { id: user._id } };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      verified: user.emailVerified || false,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        profilePicture: user.profilePicture,
        role: user.role,
      },
    });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.refresh = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const user = await User.findById(userId).select('-password');
    if (!user) {
      res.status(404).json({ msg: 'User not found' });
      return;
    }
    const payload = { user: { id: user._id } };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getProfile = async (req: AuthRequest, res: Response): Promise<void> => {
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

exports.getCurrentUser = async (req: AuthRequest, res: Response): Promise<void> => {
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
    const { profilePicture } = req.body as { profilePicture?: string };
    const user = await User.findByIdAndUpdate(
      userId,
      { profilePicture },
      { new: true },
    ).select('-password');
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
