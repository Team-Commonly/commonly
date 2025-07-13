const User = require('../models/User');

const adminAuth = async (req, res, next) => {
  try {
    // First check if user is authenticated (auth middleware should run first)
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    // Get user details to check role
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Check if user is admin
    if (user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('Admin auth middleware error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = adminAuth;
