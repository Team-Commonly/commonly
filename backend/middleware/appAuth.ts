import { Request, Response, NextFunction } from 'express';
import AppInstallation from '../models/AppInstallation';

// eslint-disable-next-line global-require
const { hash } = require('../utils/secret') as { hash: (value: string) => string };

export default async function appAuth(req: Request, res: Response, next: NextFunction): Promise<void | Response> {
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
}
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
