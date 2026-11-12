import type { Request, Response, NextFunction } from 'express';
import auth from './auth';
import agentRuntimeAuth from './agentRuntimeAuth';
import { agentRuntimeCredential } from './agentRuntimeCredential';

/** The chosen credential also keys rate limits. An unrelated header cannot
 * rotate the bucket while a runtime token continues to authenticate: the agent
 * token is read by the same parser agentRuntimeAuth verifies with (F169). */
export function resolveDualAuthCredential(
  req: Pick<Request, 'header'>,
): { verifier: 'agent' | 'human'; token: string } {
  const agentToken = agentRuntimeCredential(req);
  if (agentToken.startsWith('cm_agent_')) return { verifier: 'agent', token: agentToken };
  // The human side reads the header the way auth.ts does. x-auth-token remains
  // a human-verifier input, even if its text starts cm_agent_.
  const bearer = ((req.header?.('Authorization') || '').replace('Bearer ', '')).trim();
  return { verifier: 'human', token: bearer || req.header?.('x-auth-token') || '' };
}

/** Select once; refusal never falls through to another identity's verifier. */
export default function dualAuth(req: Request, res: Response, next: NextFunction) {
  if (resolveDualAuthCredential(req).verifier === 'agent') return agentRuntimeAuth(req, res, next);
  return auth(req, res, next);
}
// CJS compatibility for the existing route modules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
