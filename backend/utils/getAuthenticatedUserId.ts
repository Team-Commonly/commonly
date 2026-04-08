import type { Request } from 'express';

type AuthRequest = Request & {
  userId?: string;
  user?: { id?: string; _id?: string };
};

const getAuthenticatedUserId = (req: AuthRequest): string | null =>
  req.userId || req.user?.id || req.user?._id || null;

module.exports = getAuthenticatedUserId;
