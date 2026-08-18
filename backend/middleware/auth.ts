import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import User from '../models/User';

// User.lastActive was only ever set at account creation, which made every
// activity-based metric (returned D1/D7 in /api/admin/analytics/funnel,
// DAU/WAU in /usage) a structural zero. Move it with real authenticated
// traffic: at most one write per user per 15 minutes, fire-and-forget so the
// request path never waits on it. The throttle map is process-lifetime and
// bounded by the count of distinct active users; a restart just means one
// extra write per user.
const LAST_ACTIVE_INTERVAL_MS = 15 * 60 * 1000;
const lastActiveWrites = new Map<string, number>();
export function touchLastActive(id: string): void {
  const now = Date.now();
  const prev = lastActiveWrites.get(id);
  if (prev && now - prev < LAST_ACTIVE_INTERVAL_MS) return;
  lastActiveWrites.set(id, now);
  try {
    User.updateOne({ _id: id }, { lastActive: new Date(now) }).catch(() => {
      // Retry on the next request rather than silently going stale for 15 min.
      lastActiveWrites.delete(id);
    });
  } catch {
    // Telemetry is fail-open: a throwing write path must never turn into a
    // 401 for an otherwise-valid request.
    lastActiveWrites.delete(id);
  }
}

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
      touchLastActive(user._id.toString());
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
    // `username` rides along on a query that already runs. Without it,
    // `req.user` on this path is `{ id }` only — and every consumer that
    // reads `req.user?.username` silently gets undefined.
    const live = await User.findById(id).select('banned username').lean() as
      { banned?: boolean; username?: string } | null;
    if (!live) return res.status(401).json({ msg: 'Account no longer exists' });
    if (live.banned) return res.status(403).json({ msg: 'This account has been suspended.' });

    req.userId = id;
    // The API-token path above sets username; this one did not, and the two
    // shapes are not interchangeable. messageController reads
    // `req.user?.username` and hands it to agentMentionService, which builds
    // the frame every woken agent reads:
    //
    //   [Trigger: this turn was raised by **unknown** (message 54955), ...]
    //
    // `formatAuthorFrame` falls back to 'unknown' on a missing username
    // (agentMentionService.ts:598). Since the web UI authenticates by JWT,
    // that fallback fired for EVERY human message — observed live in a
    // running seat's argv, on a message posted by a signed-in human.
    //
    // The cost is not cosmetic. That frame is how a woken agent learns a
    // HUMAN raised the turn rather than a peer, which is the distinction
    // driving whether it answers now or treats the wake as peer chatter.
    req.user = { id, username: live.username };
    touchLastActive(id);
    next();
  } catch (err: unknown) {
    console.error('Token validation error:', (err as Error).message);
    res.status(401).json({ msg: 'Token is not valid' });
  }
}
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
