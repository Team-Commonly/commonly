export {};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rateLimit = require('express-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const adminAuth = require('../../middleware/adminAuth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cloudflareIpRateLimitKeyGenerator } = require('../../middleware/ipRateLimit');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { agentAuthRefusalCounts } = require('../../services/agentAuthRefusals');

const router = express.Router();

// Inlined limiter so the route guard sees a rate limit ahead of auth. Skipped
// under NODE_ENV=test. Admin-gated, so this is defense-in-depth.
const adminAgentAuthRefusalsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req: any, res: any) => res.status(429).json({ error: 'rate_limited' }),
});

// GET /api/admin/agent-auth/refusals
// Per-reason count of agentRuntimeAuth refusals since this backend process
// started. Answers "has this agent tried to connect and failed" at reason
// granularity; the token fingerprint in the log lines is the per-client handle.
router.get('/refusals', adminAgentAuthRefusalsRateLimit, auth, adminAuth, (_req: any, res: any) => {
  res.json(agentAuthRefusalCounts());
});

module.exports = router;
