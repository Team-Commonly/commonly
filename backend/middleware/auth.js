const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
    // Get token from header
    const token = req.header('Authorization')?.replace('Bearer ', '');

    // Check if no token
    if (!token) {
        return res.status(401).json({ msg: 'No token, authorization denied' });
    }

    // Verify token
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Add user ID from payload
        // The token can have either { id: user._id } or { user: { id: user._id } }
        req.userId = decoded.id || (decoded.user && decoded.user.id);
        
        if (!req.userId) {
            return res.status(401).json({ msg: 'Invalid token structure' });
        }
        
        next();
    } catch (err) {
        res.status(401).json({ msg: 'Token is not valid' });
    }
}; 