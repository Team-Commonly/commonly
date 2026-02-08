const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const User = require('../models/User');
const AgentIdentityService = require('../services/agentIdentityService');

const SMTP2GO_BASE_URL = process.env.SMTP2GO_BASE_URL || 'https://api.smtp2go.com/v3';
const SMTP2GO_SEND_URL = `${SMTP2GO_BASE_URL.replace(/\/$/, '')}/email/send`;

// 📌 Register User
exports.register = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Check if user already exists
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hasEmailConfig = Boolean(process.env.SMTP2GO_API_KEY)
      && Boolean(process.env.SMTP2GO_FROM_EMAIL)
      && Boolean(process.env.FRONTEND_URL);
    const shouldAutoVerify = !hasEmailConfig && process.env.NODE_ENV !== 'production';

    // Create new user instance
    user = new User({
      username,
      email,
      password,
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
    return res.status(500).json({ error: 'Server error' });
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
      expiresIn: '1h',
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
