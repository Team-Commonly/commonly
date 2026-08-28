// ADR-026 D4: authenticates cm_daemon_* bearers against the AgentCredential
// ledger. A daemon credential authorizes agent-LIFECYCLE operations only —
// it deliberately does NOT pass agentRuntimeAuth and cannot act as any agent
// (Vera's scope ruling on #1312/S1). Sets req.daemonCredential.
import { Request, Response, NextFunction } from 'express';
import AgentCredential, { IAgentCredential } from '../models/AgentCredential';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hash } = require('../utils/secret') as { hash: (value: string) => string };

export interface DaemonAuthedRequest extends Request {
  daemonCredential?: IAgentCredential;
}

export default async function daemonAuth(
  req: DaemonAuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    if (!token || !token.startsWith('cm_daemon_')) {
      return res.status(401).json({ message: 'Missing daemon token' });
    }
    const credential = await AgentCredential.findOne({ tokenHash: hash(token), kind: 'daemon' });
    if (!credential || credential.status !== 'active') {
      return res.status(401).json({ message: 'Daemon token revoked or unknown' });
    }
    if (credential.expiresAt && credential.expiresAt < new Date()) {
      return res.status(401).json({ message: 'Daemon token expired' });
    }
    AgentCredential.updateOne({ _id: credential._id }, { $set: { lastUsedAt: new Date() } })
      .catch((err: Error) => console.warn('Failed to stamp daemon credential usage:', err.message));
    req.daemonCredential = credential;
    return next();
  } catch (err) {
    console.error('daemonAuth error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
}
// CJS compat
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
