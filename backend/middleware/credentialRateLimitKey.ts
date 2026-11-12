import { createHash } from 'crypto';
import type { Request } from 'express';
import { resolveDualAuthCredential } from './dualAuth';
import { cloudflareIpRateLimitKeyGenerator } from './ipRateLimit';

// The limiter can see a request without header() in tests; it falls to the IP key.
type HeaderRequest = { header?: Request['header']; method?: string };
type WithHeader = Pick<Request, 'header'>;

/** The token auth() verifies: Authorization (a "Bearer " prefix dropped), else
 * x-auth-token. It mirrors auth.ts's first two lines rather than being imported
 * by auth.ts, because any edit to auth.ts makes CodeQL re-flag every route that
 * runs auth() for js/missing-rate-limiting. A test runs auth() itself and fails
 * if the two ever read different tokens. */
export function humanAuthCredential(req: WithHeader): string {
  return req.header('Authorization')?.replace('Bearer ', '') || req.header('x-auth-token') || '';
}

const tokenKey = (credential: string, req: HeaderRequest, prefix = 'tok'): string => (credential
  ? `${prefix}:${createHash('sha256').update(credential).digest('hex').slice(0, 16)}`
  : cloudflareIpRateLimitKeyGenerator(req as never));

/** For a route behind `auth` alone: the bucket is the token auth.ts verifies,
 * so a header that verifier never reads cannot move it (F455), and a person on
 * x-auth-token is not left on the shared address bucket (F456). */
export const humanCredentialRateLimitKey = (req: HeaderRequest): string => tokenKey(
  req.header ? humanAuthCredential(req as WithHeader) : '',
  req,
);

/** For a route behind dualAuth: the bucket is the credential dualAuth chose,
 * whichever header carried it (F141, F456). */
export const dualCredentialRateLimitKey = (req: HeaderRequest, prefix = 'tok'): string => tokenKey(
  req.header ? resolveDualAuthCredential(req as WithHeader).token : '',
  req,
  prefix,
);

/** POST /api/messages/:podId is behind `auth`; DELETE /api/messages/:id is
 * behind dualAuth. They share one limiter, each keyed by its own verifier. */
export const messageWriteRateLimitKey = (req: HeaderRequest): string => (req.method === 'DELETE'
  ? dualCredentialRateLimitKey(req)
  : humanCredentialRateLimitKey(req));
