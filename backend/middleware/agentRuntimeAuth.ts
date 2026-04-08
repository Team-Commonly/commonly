import { Request, Response, NextFunction } from 'express';
import { AgentInstallation } from '../models/AgentRegistry';
import User, { IUser } from '../models/User';
import Pod from '../models/Pod';

// eslint-disable-next-line global-require
const { hash } = require('../utils/secret') as { hash: (value: string) => string };

const normalizeTokenIdentityValue = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const deriveInstanceIdFromUsername = (agentName: string, username: string): string | null => {
  const normalizedAgent = normalizeTokenIdentityValue(agentName);
  const normalizedUsername = normalizeTokenIdentityValue(username);
  if (!normalizedAgent || !normalizedUsername) return null;
  if (normalizedUsername === normalizedAgent) return 'default';
  const prefix = `${normalizedAgent}-`;
  if (normalizedUsername.startsWith(prefix)) {
    const suffix = normalizedUsername.slice(prefix.length).trim();
    return suffix || null;
  }
  return null;
};

const resolveTokenAgentIdentity = (agentUser: IUser): { agentName: string; instanceId: string } => {
  const meta = agentUser?.botMetadata || {};
  const username = normalizeTokenIdentityValue(agentUser?.username);
  const agentName = normalizeTokenIdentityValue(meta.agentName || meta.instanceId || username);

  const metadataInstanceId = normalizeTokenIdentityValue(meta.instanceId);
  const usernameInstanceId = deriveInstanceIdFromUsername(agentName, username);
  let instanceId = metadataInstanceId || usernameInstanceId || 'default';
  if (usernameInstanceId && (!metadataInstanceId || metadataInstanceId === 'default')) {
    instanceId = usernameInstanceId;
  }

  return { agentName, instanceId };
};

const extractToken = (req: Request): string | undefined => {
  const authHeader = req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.replace('Bearer ', '').trim();
  }
  return req.header('x-commonly-agent-token');
};

export default async function agentRuntimeAuth(req: Request, res: Response, next: NextFunction): Promise<void | Response> {
  try {
    const token = extractToken(req);
    if (!token || !token.startsWith('cm_agent_')) {
      return res.status(401).json({ message: 'Missing agent token' });
    }

    const tokenHash = hash(token);

    const agentUser = await User.findOne({
      'agentRuntimeTokens.tokenHash': tokenHash,
      isBot: true,
    });

    if (agentUser) {
      const tokenRecord = agentUser.agentRuntimeTokens.find((t) => t.tokenHash === tokenHash);
      if (tokenRecord?.expiresAt && tokenRecord.expiresAt < new Date()) {
        return res.status(401).json({ message: 'Session token expired' });
      }

      try {
        await User.updateOne(
          { _id: agentUser._id, 'agentRuntimeTokens.tokenHash': tokenHash },
          { $set: { 'agentRuntimeTokens.$.lastUsedAt': new Date() } },
        );
      } catch (err: unknown) {
        console.warn('Failed to update agent token usage on User:', (err as Error).message);
      }

      const { agentName, instanceId } = resolveTokenAgentIdentity(agentUser);

      const installations = await AgentInstallation.find({
        agentName,
        instanceId,
        status: 'active',
      }).lean();
      const installationPodIds = installations
        .map((inst) => inst?.podId?.toString())
        .filter(Boolean) as string[];
      const dmPods = await Pod.find({
        type: 'agent-admin',
        members: agentUser._id,
      }).select('_id').lean();
      const dmPodIds = dmPods.map((pod) => pod._id?.toString()).filter(Boolean) as string[];
      const authorizedPodIds = Array.from(new Set([...installationPodIds, ...dmPodIds]));

      req.agentUser = agentUser;
      req.agentInstallations = installations as never[];
      req.agentAuthorizedPodIds = authorizedPodIds;
      req.agentInstallation = (installations[0] as never) || null;
      return next();
    }

    const installation = await AgentInstallation.findOne({
      'runtimeTokens.tokenHash': tokenHash,
      status: 'active',
    });

    if (!installation) {
      return res.status(401).json({ message: 'Invalid agent token' });
    }

    try {
      await AgentInstallation.updateOne(
        { _id: installation._id, 'runtimeTokens.tokenHash': tokenHash },
        { $set: { 'runtimeTokens.$.lastUsedAt': new Date() } },
      );
    } catch (err: unknown) {
      console.warn('Failed to update agent token usage:', (err as Error).message);
    }

    req.agentInstallation = installation as never;
    req.agentInstallations = [installation] as never[];
    req.agentAuthorizedPodIds = [installation?.podId?.toString()].filter(Boolean) as string[];
    return next();
  } catch (error) {
    console.error('Agent auth error:', error);
    return res.status(500).json({ message: 'Agent auth failed' });
  }
}
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
