import type { Request } from 'express';

/**
 * The agent runtime token a request carries: `Authorization: Bearer <token>`,
 * else `x-commonly-agent-token`. Any other Authorization scheme carries none.
 * dualAuth keys the rate limit on this and agentRuntimeAuth verifies it, so
 * the two must read the same text (F169): a non-Bearer header the verifier
 * ignored once keyed a fresh bucket per request.
 */
export const agentRuntimeCredential = (req: Pick<Request, 'header'>): string => {
  const authorization = req.header?.('Authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  return bearer || (req.header?.('x-commonly-agent-token') || '').trim();
};
