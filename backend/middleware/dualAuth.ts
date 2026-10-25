import type { Request, Response, NextFunction } from 'express';
import auth from './auth';
import agentRuntimeAuth from './agentRuntimeAuth';

/** Select a verifier once. Authorization wins over the alternate agent header;
 * a refusal never falls through to the other identity's verifier. */
export default function dualAuth(req: Request, res: Response, next: NextFunction) {
  const bearer = ((req.header?.('Authorization') || '').replace('Bearer ', '')).trim();
  const altHeader = (req.header?.('x-commonly-agent-token') || '').trim();
  const token = bearer || altHeader;
  if (token.startsWith('cm_agent_')) return agentRuntimeAuth(req, res, next);
  return auth(req, res, next);
}
// CJS compatibility for the existing route modules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
