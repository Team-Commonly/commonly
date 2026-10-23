import { createHash, createHmac, timingSafeEqual } from 'crypto';
import express from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const rateLimit = require('express-rate-limit');
import { boundPodForGithubEvent, githubLocation } from '../../services/githubGigService';
import GithubGigDelivery from '../../models/GithubGigDelivery';
import { eventHandlers } from '../../services/installable/eventHandlers';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';

const router = express.Router();
const DELIVERY_ID = /^[0-9a-fA-F-]{20,80}$/;
export const githubGigRawBody = express.raw({ type: 'application/json', limit: '25mb' });
export const githubGigRawError = (error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error?.type === 'entity.too.large') { res.status(413).end(); return; }
  next(error);
};

export const verifyGithubGigSignature = (body: unknown, signature: unknown, secret: unknown): boolean => {
  if (!Buffer.isBuffer(body) || typeof secret !== 'string' || !secret || typeof signature !== 'string') return false;
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(signature.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export const createGithubGigRateLimit = (max = 3_000) => rateLimit({
  windowMs: 60_000,
  max,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req: express.Request) => `github-gig:${cloudflareIpRateLimitKeyGenerator(req)}`,
  handler: (req: express.Request, res: express.Response) => {
    // Count bad signatures too, while preserving their empty 401 on overflow.
    const signed = verifyGithubGigSignature(req.body, req.get('X-Hub-Signature-256'), process.env.GITHUB_GIG_WEBHOOK_SECRET);
    res.status(signed ? 429 : 401).end();
  },
});
const githubGigRateLimit = createGithubGigRateLimit();

router.post('/', githubGigRateLimit, (req, res, next) => {
  // Verify on raw bytes before parsing, looking up a binding, or claiming a
  // delivery. Signature failures have one indistinguishable response.
  if (!verifyGithubGigSignature(req.body, req.get('X-Hub-Signature-256'), process.env.GITHUB_GIG_WEBHOOK_SECRET)) {
    res.status(401).end();
    return;
  }
  next();
}, async (req, res) => {
  if (process.env.GITHUB_GIG_ENABLED !== 'true') return res.status(204).end();
  let payload: any;
  try { payload = JSON.parse((req.body as Buffer).toString('utf8')); } catch { return res.status(400).end(); }
  const eventType = String(req.get('X-GitHub-Event') || '');
  const action = String(payload?.action || '');
  const supported = (eventType === 'pull_request'
      && (action === 'opened' || (action === 'closed' && payload?.pull_request?.merged === true)))
    || (eventType === 'pull_request_review' && action === 'submitted')
    || (eventType === 'issues' && (action === 'opened' || action === 'closed'))
    || (eventType === 'check_run' && action === 'completed' && payload?.check_run?.conclusion === 'failure'
      && process.env.GITHUB_GIG_CHECKS_READ_ENABLED === 'true');
  if (!supported) return res.status(204).end();
  const location = githubLocation(payload);
  if (!location) return res.status(204).end();
  let podId: string | null;
  try { podId = await boundPodForGithubEvent(location); } catch { return res.status(503).end(); }
  // App-wide deliveries from unbound repositories do not create even a
  // deduplication row. The one connection lookup is indexed by installationId.
  if (!podId) return res.status(204).end();
  const deliveryId = String(req.get('X-GitHub-Delivery') || '');
  if (!DELIVERY_ID.test(deliveryId)) return res.status(400).end();
  // The delivery header is outside the HMAC; a replay with a new id must
  // still meet the same permanent receipt. The digest is of signed raw bytes.
  const bodyHash = createHash('sha256').update(req.body as Buffer).digest('hex');
  try {
    await GithubGigDelivery.create({ deliveryId, bodyHash });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return res.status(204).end();
    return res.status(503).end();
  }
  try {
    // Finish before acknowledging. On failure, release the receipt so GitHub
    // can retry; only completed work keeps the permanent replay key.
    await eventHandlers['github.gig']({ eventType, payload, podId, location } as any);
    return res.status(204).end();
  } catch {
    console.warn('[github-gig] bound delivery processing failed', { deliveryId, eventType, podId });
    try { await GithubGigDelivery.deleteOne({ deliveryId }); } catch {
      console.warn('[github-gig] receipt release failed', { deliveryId, eventType, podId });
    }
    return res.status(503).end();
  }
});

export default router;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
