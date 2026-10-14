// ESM import (not require) so CodeQL's js/missing-rate-limiting query
// recognises the limiters on each route — same pattern as messages.ts.
import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const {
  createPost,
  getPosts,
  getPostById,
  addComment,
  searchPosts,
  likePost,
  deletePost,
  deleteComment,
  followThread,
  unfollowThread,
  getFollowedThreads,
  toggleAgentComments,
} = require('../controllers/postController');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');

interface RateLimitReq {
  ip?: string;
  get?: (header: string) => string | undefined;
}
interface RateLimitRes {
  status: (n: number) => RateLimitRes;
  json: (d: unknown) => void;
}

// Keyed on the caller's token, hashed: Authorization or x-auth-token, the two
// headers middleware/auth reads. Not on IP — in production req.ip is a
// cloudflared pod for every caller, so an IP key would throttle all users as
// one. The Cloudflare-aware IP helper is only the fallback for a request with
// no token, which auth then refuses anyway.
const postsRateLimitKey = (req: RateLimitReq): string => {
  const token = req.get?.('authorization') || req.get?.('x-auth-token');
  if (token) {
    return `tok:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  }
  return cloudflareIpRateLimitKeyGenerator(req as never);
};

// Same budgets as the chat routes in messages.ts. 240 reads/min is four a
// second sustained, well above feed scrolling, search-as-you-type and thread
// opens; 60 writes/min is one a second, far above anyone posting, commenting,
// following or liking by hand. Each limiter is shared across its routes, so
// the budget is per token across the router, not per route.
const postsReadRateLimit = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: postsRateLimitKey,
  handler: (_req: unknown, res: RateLimitRes) => {
    res.status(429).json({ error: 'rate limit exceeded: 240 post reads per 60s' });
  },
});

const postsWriteRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: postsRateLimitKey,
  handler: (_req: unknown, res: RateLimitRes) => {
    res.status(429).json({ error: 'rate limit exceeded: 60 post writes per 60s' });
  },
});

const router: ReturnType<typeof express.Router> = express.Router();

// The limiter goes first on every route: auth does a Mongo lookup, and a
// limiter behind it would leave that lookup unprotected.
router.post('/', postsWriteRateLimit, auth, createPost);
// Posts read paths require auth so pod-scoped queries can resolve the
// caller's identity for the canViewPod gate in getPosts / getPostById.
// Landing / marketing pages don't fetch posts, so this is a safe upgrade.
router.get('/', postsReadRateLimit, auth, getPosts);
router.get('/search', postsReadRateLimit, auth, searchPosts);
router.get('/following/threads', postsReadRateLimit, auth, getFollowedThreads);
router.get('/:id', postsReadRateLimit, auth, getPostById);
router.post('/:id/comments', postsWriteRateLimit, auth, addComment);
router.post('/:id/follow', postsWriteRateLimit, auth, followThread);
router.delete('/:id/follow', postsWriteRateLimit, auth, unfollowThread);
router.post('/:id/like', postsWriteRateLimit, auth, likePost);
router.delete('/:id', postsWriteRateLimit, auth, deletePost);
router.delete('/:id/comments/:commentId', postsWriteRateLimit, auth, deleteComment);
router.patch('/:id/agent-comments', postsWriteRateLimit, auth, toggleAgentComments);

module.exports = router;

export {};
