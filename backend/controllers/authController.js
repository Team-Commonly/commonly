const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const sgMail = require('@sendgrid/mail');

// ✅ Configure SendGrid API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// 📌 Register User
exports.register = async (req, res) => {
    const { username, email, password } = req.body;

    try {
        let user = await User.findOne({ email });
        if (user) return res.status(400).json({ error: 'User already exists' });

        user = new User({ username, email, password, verified: false });

        await user.save();

        // 📌 Generate Verification Token
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });

        // 📌 Create Email Message
        const msg = {
            to: email,
            from: process.env.SENDGRID_FROM_EMAIL,
            subject: 'Verify Your Email - Commonly',
            text: `Click the link below to verify your email: ${process.env.FRONTEND_URL}/verify-email?token=${token}`,
            html: `<p>Click the link below to verify your email:</p>
                   <a href="${process.env.FRONTEND_URL}/verify-email?token=${token}">Verify Email</a>`
        };

        // 📌 Send Email via SendGrid
        await sgMail.send(msg);

        res.status(201).json({ message: 'User registered successfully. Check your email for verification.' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// 📌 Verify Email
exports.verifyEmail = async (req, res) => {
    try {
        const { token } = req.query;
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const user = await User.findByIdAndUpdate(decoded.id, { verified: true }, { new: true });
        if (!user) return res.status(400).json({ error: "Invalid token" });

        res.json({ message: "Email verified successfully" });

    } catch (err) {
        res.status(400).json({ error: "Invalid or expired token" });
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

        res.json({ token, verified: user.verified });

    } catch (err) {
        res.status(500).json({ error: err.message });
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
