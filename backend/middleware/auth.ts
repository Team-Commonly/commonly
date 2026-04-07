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
        '_id username email role apiTokenScopes apiTokenCreatedAt',
      );

      if (!user) return res.status(401).json({ msg: 'Invalid API token' });

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

    req.userId = id;
    req.user = { id };
    next();
  } catch (err: unknown) {
    console.error('Token validation error:', (err as Error).message);
    res.status(401).json({ msg: 'Token is not valid' });
  }
}
