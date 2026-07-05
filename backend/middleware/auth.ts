import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import User from '../models/User';

export default async function auth(req: Request, res: Response, next: NextFunction): Promise<void | Response> {
  let token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) token = req.header('x-auth-token');

  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  if (token.startsWith('cm_')) {
    try {
      const user = await User.findOne({ apiToken: token }).select(
        '_id username email role apiTokenScopes apiTokenCreatedAt banned',
      );

      if (!user) return res.status(401).json({ msg: 'Invalid API token' });
      if ((user as unknown as { banned?: boolean }).banned) {
        return res.status(403).json({ msg: 'This account has been suspended.' });
      }

      req.userId = user._id.toString();
      req.user = {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        role: user.role,
      };
      req.authType = 'apiToken';
      req.apiTokenScopes = user.apiTokenScopes || [];
      req.apiTokenCreatedAt = user.apiTokenCreatedAt || null;
      return next();
    } catch (err: unknown) {
      console.error('API token validation error:', (err as Error).message);
      return res.status(401).json({ msg: 'API token validation failed' });
    }
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as Record<string, unknown>;
    const id = (decoded.id || (decoded.user as Record<string, unknown>)?.id) as string | undefined;

    if (!id) return res.status(401).json({ msg: 'Invalid token structure' });

    // Admin moderation: one indexed read so a ban (or account deletion) takes
    // effect on the NEXT request, not at JWT expiry days later.
    const live = await User.findById(id).select('banned').lean() as { banned?: boolean } | null;
    if (!live) return res.status(401).json({ msg: 'Account no longer exists' });
    if (live.banned) return res.status(403).json({ msg: 'This account has been suspended.' });

    req.userId = id;
    req.user = { id };
    next();
  } catch (err: unknown) {
    console.error('Token validation error:', (err as Error).message);
    res.status(401).json({ msg: 'Token is not valid' });
  }
}
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
