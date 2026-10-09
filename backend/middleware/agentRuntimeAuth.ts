import { Request, Response, NextFunction } from 'express';
import { AgentInstallation } from '../models/AgentRegistry';
import User, { IUser } from '../models/User';
// Throttled fail-open lastActive writer (shared with human auth — see #668).
// Without this, every runtime-token agent's User.lastActive stays frozen at
// its creation date, so profiles/rosters show working agents as never active.
import { touchLastActive } from './auth';
import Pod from '../models/Pod';
import AgentCredential from '../models/AgentCredential';
import { isSpawnCredential } from '../services/spawnCredentialService';

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

/**
 * ADR-026 / TASK-094: resolve the agent identity behind a per-spawn child
 * token.
 *
 * A child's bearer is written to the credential ledger only — never to
 * `User.agentRuntimeTokens` — so the embedded lookup below cannot see it and
 * the request would 401 with a perfectly valid credential. The row carries
 * `agentUserId`, so the seat can be resolved directly.
 *
 * The spawn-scope requirement is deliberate and is the whole reason this is
 * not "any row with an agentUserId": making the ledger an authority for
 * legacy-shaped rows would silently widen authentication for tokens that
 * today authenticate only through the embedded list. A child is a new kind of
 * row, and the widening is scoped to that kind.
 */
const resolveSpawnChildAgentUser = async (
  credential: { scopes?: string[]; agentUserId?: unknown } | null | undefined,
): Promise<IUser | null> => {
  if (!credential || !isSpawnCredential(credential) || !credential.agentUserId) return null;
  return User.findOne({ _id: credential.agentUserId, isBot: true });
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
    // TASK-094: the per-token budget is keyed on this (agentRateLimit.ts
    // reads `req.agentTokenHash`), and until now nothing set it, so every
    // authenticated agent route was silently bucketed under the header
    // fallback. Set it before any lookup so a token with no credential row
    // is still keyed as itself.
    req.agentTokenHash = tokenHash;

    // ADR-026 Phase 0: the credential collection is consulted FIRST. A
    // credential-backed token enforces status + expiry + issuer lineage —
    // a child whose parent daemon credential is revoked is dead, even
    // though the bearer string itself is intact. Legacy embedded tokens
    // (no credential row) fall through to the original path unchanged.
    // Look up the hash without a kind filter. A daemon credential accidentally
    // copied into the legacy embedded list must veto that fallback rather than
    // becoming an agent merely because its ledger row was filtered out.
    const credential = await AgentCredential.findOne({ tokenHash });
    if (credential) {
      if (credential.kind !== 'runtime') {
        return res.status(401).json({ message: 'Invalid agent credential' });
      }
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

    // TASK-094: expose the row so routes can key on the credential (the mint
    // route needs the caller's row) rather than hashing the bearer again.
    req.agentCredential = credential || null;

    const embeddedAgentUser = await User.findOne({
      'agentRuntimeTokens.tokenHash': tokenHash,
      isBot: true,
    });
    const agentUser = embeddedAgentUser
      || (await resolveSpawnChildAgentUser(credential)) as typeof embeddedAgentUser;

    if (agentUser) {
      const tokenRecord = agentUser.agentRuntimeTokens.find((t) => t.tokenHash === tokenHash);
      if (tokenRecord?.expiresAt && tokenRecord.expiresAt < new Date()) {
        return res.status(401).json({ message: 'Session token expired' });
      }
      // Pre-update value: a token with no lastUsedAt is authenticating for
      // the very first time — the #909 verified-listening moment. Observed
      // once per token; drives the connect-agent starter task below (#916).
      //
      // TASK-094: `Boolean(tokenRecord)` is load-bearing for spawn children.
      // A child is written to the ledger only, so it has no embedded record;
      // without this the starter task would fire once per spawn instead of
      // once per seat.
      const isFirstTokenUse = Boolean(tokenRecord) && !tokenRecord?.lastUsedAt;

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
    //
    // THE DOWNSTREAM CONTRACT IS WIDER THAN `_id`, AND BOTH `User.findOne`
    // CALLS IN THIS FILE MUST STAY UNPROJECTED. `username` is load-bearing
    // since #1127 (`tasksApi` labels a claim holder with it), and `isBot` /
    // `botMetadata` are read by the lease-rescue sweep. Adding a `.select()`
    // here for performance would silently empty those terms — and no test
    // would go red, because the suites construct their own `req.agentUser`
    // rather than calling this middleware. That is precisely the failure
    // #1127 fixed, one middleware edit away from returning.
    //
    // Note the trap next door: the `.select('_id')` thirty-seven lines above
    // belongs to the interleaved DM-pod `Pod.find`, not to the `User.findOne`.
    // Grepping for a projection by line proximity finds the wrong query here.
    // Guarded by `__tests__/unit/middleware/agentUserShapeContract.test.js`;
    // reviewer-checklist rule 18 is why that guard reads source rather than
    // running the middleware.
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
