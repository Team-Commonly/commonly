const AppInstallation = require('../models/AppInstallation');
const { hash, safeEqual } = require('../utils/secret');

/**
 * Middleware to authenticate requests from app installations using Bearer token.
 * Expects header: Authorization: Bearer <token>
 * Attaches req.appInstallation on success.
 */
module.exports = async function appAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const [, token] = authHeader.split(' ');
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const tokenHash = hash(token);
    const inst = await AppInstallation.findOne({ tokenHash, status: 'active' });
    if (!inst) return res.status(401).json({ error: 'Invalid token' });

    if (inst.tokenExpiresAt && inst.tokenExpiresAt < new Date()) {
      return res.status(401).json({ error: 'Token expired' });
    }

    req.appInstallation = inst;
    return next();
  } catch (error) {
    console.error('appAuth error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
