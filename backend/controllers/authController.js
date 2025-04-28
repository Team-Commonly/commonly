const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sgMail = require('@sendgrid/mail');
const User = require('../models/User');

// ✅ Configure SendGrid API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// 📌 Register User
exports.register = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Check if user already exists
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Create new user instance
    user = new User({
      username,
      email,
      password,
      verified: false,
    });

    // Hash password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    // Save user to database
    await user.save();

    // Generate email verification token
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });

    // Create email message with verification link
    const msg = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Verify Your Email - Commonly',
      text: `Click the link below to verify your email: ${process.env.FRONTEND_URL}/verify-email?token=${token}`,
      html: `<p>Click the link below to verify your email:</p>
             <a href="${process.env.FRONTEND_URL}/verify-email?token=${token}">Verify Email</a>`,
    };

    // Send email
    await sgMail.send(msg);

    return res.status(201).json({ message: 'User registered successfully. Check your email for verification.' });
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

    const user = await User.findByIdAndUpdate(decoded.id, { verified: true }, { new: true });
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
      return res.status(400).json({ error: 'Email not verified. Please check your inbox.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    return res.json({
      token,
      verified: user.verified,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        profilePicture: user.profilePicture,
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

    // Find the user
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update profile picture if provided
    if (profilePicture) {
      user.profilePicture = profilePicture;
    }

    await user.save();

    // Return the updated user without the password
    const updatedUser = await User.findById(req.userId).select('-password');
    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
