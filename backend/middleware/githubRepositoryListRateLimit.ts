import rateLimit from 'express-rate-limit';
import { integrationsRateLimitKey } from './integrationRateLimit';

// One read of the repository picker can spend 33 requests of the person's own
// GitHub token, which their hosted GitHub tools also spend. It gets its own
// small bucket: `listIntegrationsRateLimit` would allow thousands a minute.
export const githubRepositoryListRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: integrationsRateLimitKey,
  handler: (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void } }) => {
    res.status(429).json({ msg: 'rate limit exceeded: 10 repository lists per 60s' });
  },
});
