import { Request, Response, NextFunction } from 'express';
import { AgentInstallation } from '../models/AgentRegistry';
import User, { IUser } from '../models/User';
// Throttled fail-open lastActive writer (shared with human auth — see #668).
// Without this, every runtime-token agent's User.lastActive stays frozen at
// its creation date, so profiles/rosters show working agents as never active.
import { touchLastActive } from './auth';
import Pod from '../models/Pod';
import AgentCredential from '../models/AgentCredential';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isConfiguredDevTierGitHubIssueWriter } = require('../services/githubIssueWriteCapability') as typeof import('../services/githubIssueWriteCapability');

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

/**
 * #1322 added a default-off capability after the established OpenClaw seats
 * already had active AgentInstallation rows. New installs receive the grant
 * in the install route, but the runtime-auth boundary is the one place every
 * existing seat must cross before it can spend the GitHub credential.
 *
 * Reconcile there, before a route sees req.agentInstallations. That turns the
 * first authenticated request after deploy into a safe, server-derived
 * backfill for every active installation of a configured dev identity. It
 * avoids relying on a reinstall/reprovision and avoids trusting the
 * user-editable installation config. Failed reconciliation leaves the field
 * false, so the subsequent write gate remains fail-closed.
 */
const backfillDevTierGitHubIssueWrite = async <T extends { githubIssueWrite?: boolean }>(
  agentName: string,
  instanceId: string,
  installations: T[],
): Promise<T[]> => {
  if (!installations.length || installations.some((installation) => installation?.githubIssueWrite === true)) {
    return installations;
  }

  const shouldGrant = await isConfiguredDevTierGitHubIssueWriter({ agentName, instanceId });
  if (!shouldGrant) return installations;

  try {
    await AgentInstallation.updateMany(
      {
        agentName,
        instanceId,
        status: 'active',
        githubIssueWrite: { $ne: true },
      },
      { $set: { githubIssueWrite: true } },
    );
    installations.forEach((installation) => {
      installation.githubIssueWrite = true;
    });
  } catch (err) {
    console.warn('[agent-auth] could not backfill GitHub issue write capability:', (err as Error).message);
  }

  return installations;
};

export default async function agentRuntimeAuth(req: Request, res: Response, next: NextFunction): Promise<void | Response> {
  try {
    const token = extractToken(req);
    if (!token || !token.startsWith('cm_agent_')) {
      return res.status(401).json({ message: 'Missing agent token' });
    }

    const tokenHash = hash(token);

    // ADR-026 Phase 0: the credential collection is consulted FIRST. A
    // credential-backed token enforces status + expiry + issuer lineage —
    // a child whose parent daemon credential is revoked is dead, even
    // though the bearer string itself is intact. Legacy embedded tokens
    // (no credential row) fall through to the original path unchanged.
    const credential = await AgentCredential.findOne({ tokenHash, kind: 'runtime' });
    if (credential) {
      if (credential.status !== 'active') {
        return res.status(401).json({ message: 'Token revoked' });
      }
      if (credential.expiresAt && credential.expiresAt < new Date()) {
        return res.status(401).json({ message: 'Session token expired' });
      }
      if (credential.parentId) {
        const parent = await AgentCredential.findById(credential.parentId).select('status').lean();
        if (!parent || parent.status !== 'active') {
          return res.status(401).json({ message: 'Issuing credential revoked' });
        }
      }
      AgentCredential.updateOne({ _id: credential._id }, { $set: { lastUsedAt: new Date() } })
        .catch((err: Error) => console.warn('Failed to update credential usage:', err.message));
    }

    const agentUser = await User.findOne({
      'agentRuntimeTokens.tokenHash': tokenHash,
      isBot: true,
    });

    if (agentUser) {
      const tokenRecord = agentUser.agentRuntimeTokens.find((t) => t.tokenHash === tokenHash);
      if (tokenRecord?.expiresAt && tokenRecord.expiresAt < new Date()) {
        return res.status(401).json({ message: 'Session token expired' });
      }
      // Pre-update value: a token with no lastUsedAt is authenticating for
      // the very first time — the #909 verified-listening moment. Observed
      // once per token; drives the connect-agent starter task below (#916).
      const isFirstTokenUse = !tokenRecord?.lastUsedAt;

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
      await backfillDevTierGitHubIssueWrite(agentName, instanceId, installations);
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
      touchLastActive(String(agentUser._id));
      req.agentInstallations = installations as never[];
      req.agentAuthorizedPodIds = authorizedPodIds;
      req.agentInstallation = (installations[0] as never) || null;

      if (isFirstTokenUse) {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const { completeConnectAgentStarterTask } = require('../services/starterTaskService');
        void completeConnectAgentStarterTask({
          podIds: installationPodIds,
          agentLabel: agentUser.botMetadata?.displayName || agentName,
        });
      }
      return next();
    }

    const installation = await AgentInstallation.findOne({
      'runtimeTokens.tokenHash': tokenHash,
      status: 'active',
    });

    if (!installation) {
      return res.status(401).json({ message: 'Invalid agent token' });
    }

    // Same first-use observation as the User-token path above (#916).
    const legacyTokenRecord = (installation.runtimeTokens || [])
      .find((t: { tokenHash?: string }) => t.tokenHash === tokenHash);
    const isFirstLegacyTokenUse = !legacyTokenRecord?.lastUsedAt;

    try {
      await AgentInstallation.updateOne(
        { _id: installation._id, 'runtimeTokens.tokenHash': tokenHash },
        { $set: { 'runtimeTokens.$.lastUsedAt': new Date() } },
      );
    } catch (err: unknown) {
      console.warn('Failed to update agent token usage:', (err as Error).message);
    }

    // Task #66: a token may be bound to one AgentInstallation row, but the
    // agent identity (agentName + instanceId) can have multiple active
    // installations across pods. Surface ALL of them so the /events
    // endpoint's podIds-from-installations filter doesn't silently drop
    // events for the pods this token wasn't originally minted for.
    // Path 1 (User-row tokens) already enumerates all installations the
    // same way — this just makes path 2 (install-bound legacy tokens)
    // match. Hit empirically 2026-05-18 when Cody's token from her old
    // Codex Hub install couldn't see events from a new pod she'd been
    // freshly installed into.
    const allActiveInstallations = await AgentInstallation.find({
      agentName: installation.agentName,
      instanceId: installation.instanceId || 'default',
      status: 'active',
    });
    await backfillDevTierGitHubIssueWrite(
      installation.agentName,
      installation.instanceId || 'default',
      allActiveInstallations,
    );

    req.agentInstallation = installation as never;
    req.agentInstallations = allActiveInstallations as never[];
    req.agentAuthorizedPodIds = allActiveInstallations
      .map((inst: { podId?: { toString: () => string } }) => inst?.podId?.toString())
      .filter(Boolean) as string[];

    if (isFirstLegacyTokenUse) {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const { completeConnectAgentStarterTask } = require('../services/starterTaskService');
      void completeConnectAgentStarterTask({
        podIds: req.agentAuthorizedPodIds,
        agentLabel: installation.displayName || installation.agentName,
      });
    }

    // Also resolve and attach the bot User so downstream routes that derive
    // `req.agentUser._id` (file-upload uploaderId, message authorship) work
    // for agents authenticated via the legacy installation-token path. The
    // bot-user-token path above already sets `req.agentUser` directly. Both
    // paths represent the same agent; making them populate the same fields
    // means routes don't need to branch on which auth shape landed.
    //
    // Discovered when nova hit `401 Agent identity required` on
    // commonly_attach_file uploads — her runtime token had been issued to
    // `AgentInstallation.runtimeTokens` (legacy) and the upload route
    // checks `req.agentUser?._id` only.
    try {
      const botUser = await User.findOne({
        isBot: true,
        'botMetadata.agentName': installation.agentName,
        'botMetadata.instanceId': installation.instanceId || 'default',
      });
      if (botUser) {
        req.agentUser = botUser;
        touchLastActive(String(botUser._id));
      }
    } catch (err: unknown) {
      console.warn('[agentRuntimeAuth] failed to resolve bot user for legacy token path:', (err as Error).message);
    }

    return next();
  } catch (error) {
    console.error('Agent auth error:', error);
    return res.status(500).json({ message: 'Agent auth failed' });
  }
}
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
