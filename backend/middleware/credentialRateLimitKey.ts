import { createHash } from 'crypto';
import type { Request } from 'express';
import { humanAuthCredential } from './auth';
import { resolveDualAuthCredential } from './dualAuth';
import { cloudflareIpRateLimitKeyGenerator } from './ipRateLimit';

// The limiter can see a request without header() in tests; it falls to the IP key.
type HeaderRequest = { header?: Request['header']; method?: string };
type WithHeader = Pick<Request, 'header'>;

const tokenKey = (credential: string, req: HeaderRequest): string => (credential
  ? `tok:${createHash('sha256').update(credential).digest('hex').slice(0, 16)}`
  : cloudflareIpRateLimitKeyGenerator(req as never));

/** For a route behind `auth` alone: the bucket is the token auth.ts verifies,
 * so a header that verifier never reads cannot move it (F455). */
export const humanCredentialRateLimitKey = (req: HeaderRequest): string => tokenKey(
  req.header ? humanAuthCredential(req as WithHeader) : '',
  req,
);

/** POST /api/messages/:podId is behind `auth`; DELETE /api/messages/:id is
 * behind dualAuth. They share one limiter, each keyed by its own verifier. */
export const messageWriteRateLimitKey = (req: HeaderRequest): string => (req.method === 'DELETE'
  ? tokenKey(req.header ? resolveDualAuthCredential(req as WithHeader).token : '', req)
  : humanCredentialRateLimitKey(req));
