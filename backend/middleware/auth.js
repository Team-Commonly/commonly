const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
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

    // Verify token
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