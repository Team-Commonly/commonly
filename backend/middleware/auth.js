const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async function (req, res, next) {
  // Get token from header - support both Authorization and x-auth-token headers
  let token = req.header('Authorization')?.replace('Bearer ', '');

  // If no Authorization header, try x-auth-token
  if (!token) {
    token = req.header('x-auth-token');
  }

  // Check if no token
  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  // Check if this is an API token (starts with 'cm_')
  if (token.startsWith('cm_')) {
    try {
      const user = await User.findOne({ apiToken: token }).select(
        '_id username email role',
      );

      if (!user) {
        return res.status(401).json({ msg: 'Invalid API token' });
      }

      // Set user info for API token
      req.userId = user._id.toString();
      req.user = {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        role: user.role,
      };

      return next();
    } catch (err) {
      console.error('API token validation error:', err.message);
      return res.status(401).json({ msg: 'API token validation failed' });
    }
  }

  // Verify JWT token
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Add user ID from payload
    // Handle both token formats: { id: user._id } or { user: { id: user._id } }
    const id = decoded.id || (decoded.user && decoded.user.id);

    if (!id) {
      return res.status(401).json({ msg: 'Invalid token structure' });
    }

    // Set both req.userId and req.user.id for backward compatibility
    req.userId = id;
    req.user = { id };

    next();
  } catch (err) {
    console.error('Token validation error:', err.message);
    res.status(401).json({ msg: 'Token is not valid' });
  }
};
