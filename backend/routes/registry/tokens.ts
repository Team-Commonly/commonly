import { isAccountDeleting } from '../../services/accountDeletionState';
// Token issuance + scope helpers — extracted from registry.js (GH#112)
const AgentIdentityService = require('../../services/agentIdentityService');
const { hash, randomSecret } = require('../../utils/secret');

const AGENT_USER_TOKEN_SCOPES = new Set([
  'agent:events:read',
  'agent:events:ack',
  'agent:context:read',
  'agent:messages:read',
  'agent:messages:write',
]);

const normalizeScopes = (scopes: any) => {
  if (!Array.isArray(scopes)) return [];
  return Array.from(new Set(scopes.filter((scope) => AGENT_USER_TOKEN_SCOPES.has(scope))));
};

const AUTO_GRANTED_INTEGRATION_SCOPES = [
  'integration:read',
  'integration:messages:read',
];

const sanitizeStringList = (value: any) => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean)));
};

const normalizeToolPolicy = (policy: any) => {
  if (!policy || typeof policy !== 'object') return null;
  return {
    allowed: sanitizeStringList(policy.allowed),
    blocked: sanitizeStringList(policy.blocked),
    requireApproval: sanitizeStringList(policy.requireApproval),
  };
};

const normalizeContextPolicy = (policy: any) => {
  if (!policy || typeof policy !== 'object') return null;
  const next = { ...policy };
  if (next.maxTokens !== undefined) next.maxTokens = Number(next.maxTokens);
  if (next.compactionThreshold !== undefined) next.compactionThreshold = Number(next.compactionThreshold);
  if (next.summaryHours !== undefined) next.summaryHours = Number(next.summaryHours);
  return next;
};

type RuntimeTokenOwner = {
  agentUser: any;
  agentName: string;
  instanceId?: string;
  installation?: any;
};

const normalizeRuntimeIdentity = (agentName: any, instanceId: any) => ({
  agentName: String(agentName || '').trim().toLowerCase(),
  instanceId: String(instanceId || 'default').trim().toLowerCase() || 'default',
});

// AgentInstallation.instanceId predates the normalized intake path and may
// still be stored with mixed casing. Keep identity normalization for callers,
// but match legacy rows case-insensitively during a rotation.
const RUNTIME_INSTALLATION_COLLATION = { locale: 'en', strength: 2 };

/** Revoke selected runtime ledger rows, optionally guarded by a freshness filter. */
export const revokeRuntimeCredentials = async (
  hashes: string[],
  extraFilter: Record<string, unknown> = {},
) => {
  if (!hashes.length) return { modifiedCount: 0 };
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentCredential = require('../../models/AgentCredential');
  return AgentCredential.updateMany(
    { tokenHash: { $in: hashes }, kind: 'runtime', status: 'active', ...extraFilter },
    { $set: { status: 'revoked', revokedAt: new Date() } },
  );
};

/**
 * Revoke ONE runtime token everywhere it can authenticate: the credential
 * ledger, every User row and every installation that holds a copy.
 *
 * By hash, because the hash is the one value every copy shares. Issuing
 * pushes the same record onto the agent's User row and onto the installation
 * it was issued through, and each store gives its copy its own subdocument
 * _id; a revoke that matched by that id removed one copy and left the others,
 * and runtime auth accepts a token from any of them (P0, QA 2026-10-15).
 * Not scoped by identity either: resolving which agent a token belongs to is
 * where a mismatch would leave a copy behind, and a hash names one token.
 * The caller decides who may revoke; this only makes the revoke total.
 */
export const revokeRuntimeTokenEverywhere = async (tokenHash: string): Promise<void> => {
  if (!tokenHash) return;
  await revokeRuntimeCredentials([tokenHash]);
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../../models/User');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../../models/AgentRegistry');
  await User.updateMany(
    { 'agentRuntimeTokens.tokenHash': tokenHash },
    { $pull: { agentRuntimeTokens: { tokenHash } } },
  );
  // Every installation, whatever its status: an uninstalled row can be
  // reinstalled, and a copy left on it would come back to life with it.
  await AgentInstallation.updateMany(
    { 'runtimeTokens.tokenHash': tokenHash },
    { $pull: { runtimeTokens: { tokenHash } } },
  );
};

/**
 * Return every legacy hash for an agent identity, across the portable User
 * row and every installation copy. The two stores are both authentication
 * paths, so a rotation that sees only one is incomplete.
 */
const getRuntimeTokenHashesForAgent = async ({
  agentUser,
  agentName,
  instanceId,
  installation = null,
}: RuntimeTokenOwner): Promise<string[]> => {
  const identity = normalizeRuntimeIdentity(agentName, instanceId);
  const userTokens = Array.isArray(agentUser?.agentRuntimeTokens) ? agentUser.agentRuntimeTokens : [];
  const localInstallationTokens = Array.isArray(installation?.runtimeTokens)
    ? installation.runtimeTokens
    : [];
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../../models/AgentRegistry');
  const installations = await AgentInstallation.find({
    agentName: identity.agentName,
    instanceId: identity.instanceId,
  }).collation(RUNTIME_INSTALLATION_COLLATION).select('runtimeTokens').lean();
  const persistedInstallationTokens = (installations || []).flatMap((row: any) => row.runtimeTokens || []);
  return Array.from(new Set([
    ...userTokens,
    ...localInstallationTokens,
    ...persistedInstallationTokens,
  ].map((token: any) => token?.tokenHash).filter(Boolean)));
};

/**
 * Revoke runtime credentials and clear both legacy token stores for one
 * identity. Call this immediately before minting a replacement token.
 */
const revokeRuntimeTokensForAgent = async (owner: RuntimeTokenOwner): Promise<string[]> => {
  const identity = normalizeRuntimeIdentity(owner.agentName, owner.instanceId);
  const hashes = await getRuntimeTokenHashesForAgent(owner);

  if (hashes.length) {
    await revokeRuntimeCredentials(hashes);
  }

  // Spawn children live only in the credential ledger, not in either embedded
  // token array. Revoke them with the identity's parent tokens as well.
  if (owner.agentUser?._id) {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentCredential = require('../../models/AgentCredential');
    await AgentCredential.updateMany(
      { agentUserId: owner.agentUser._id, kind: 'runtime', status: 'active' },
      { $set: { status: 'revoked', revokedAt: new Date() } },
    );
  }

  if (Array.isArray(owner.agentUser?.agentRuntimeTokens) && owner.agentUser.agentRuntimeTokens.length) {
    owner.agentUser.agentRuntimeTokens = [];
    await owner.agentUser.save();
  }

  // Clear every installation, not only the row that happened to receive the
  // request. Runtime auth accepts any active installation copy for the same
  // identity, so leaving a sibling row would leave the old bearer alive.
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../../models/AgentRegistry');
  await AgentInstallation.updateMany(
    { agentName: identity.agentName, instanceId: identity.instanceId },
    { $set: { runtimeTokens: [] } },
  ).collation(RUNTIME_INSTALLATION_COLLATION);

  // A route may hold a hydrated installation that is not represented by the
  // mocked query above (or has a pending in-memory mutation). Keep that
  // object aligned too; a fresh issue call appends to it immediately after.
  if (owner.installation && Array.isArray(owner.installation.runtimeTokens)
      && owner.installation.runtimeTokens.length) {
    owner.installation.runtimeTokens = [];
    if (typeof owner.installation.save === 'function') await owner.installation.save();
  }

  return hashes;
};

/** A portable identity keeps its User and memory, but no bearer after its last uninstall. */
export const revokeRuntimeTokensAfterLastUninstall = async (agentName: string, instanceId: string): Promise<void> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../../models/AgentRegistry');
  const resolvedType = AgentIdentityService.resolveAgentType(agentName);
  const names = Array.from(new Set([agentName.toLowerCase(), resolvedType]));
  const activeCount = await AgentInstallation.countDocuments({
    agentName: { $in: names }, instanceId, status: 'active',
  }).collation(RUNTIME_INSTALLATION_COLLATION);
  if (activeCount) return;

  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../../models/User');
  const username = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
  const agentUser = await User.findOne({ username, isBot: true });
  for (const name of names) {
    await revokeRuntimeTokensForAgent({ agentUser, agentName: name, instanceId });
  }
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const agentWebSocketService = require('../../services/agentWebSocketService');
  names.forEach((name) => agentWebSocketService.disconnectIdentity(name, instanceId));
};

/**
 * Issue a runtime token for an agent.
 * Tokens are stored on the User model (shared across all pod installations).
 * This ensures the same agent identity uses the same token regardless of which pod.
 *
 * @param {Object} agentUser - The agent's User document
 * @param {string} label - Token label
 * @param {Object} installation - Optional installation to also store token on (for backward compat)
 * @returns {Object} - { token, label, existing, createdAt }
 */
// issuer (ADR-026 Phase 0): { ownerUserId, parentId?, machineId? } — when
// present, the mint dual-writes an AgentCredential row alongside the legacy
// embedded record, giving the token per-record status, lineage, and
// revocability. Callers that do not pass it keep minting legacy-only tokens
// (additive migration; auth falls back for those).
/**
 * An agent Commonly runs in-process (runtimeType `native`, or `hosted` on the
 * native engine; services/hostedEngine.ts) holds no runtime token. A token
 * would let something outside the backend act as it: post as it, read its
 * events, and take connector results through the grant routes without the
 * in-process narrowing that gates outsider-writable text (TASK-224, §12).
 * Every mint path refuses here rather than each route remembering to
 * (#2224).
 */
class InProcessAgentTokenRefused extends Error {
  code = 'in_process_agent_no_token';

  status = 409;

  constructor() {
    super('Commonly runs this agent, so it has no runtime token. To run an agent yourself, connect your own agent instead.');
  }
}

// Any spelling: a type saved before the config-write guard (#2229) normalized
// it must not turn this refusal off. On the stored config, so an unfinished
// migration is refused too.
const { IN_PROCESS_RUNTIME_FILTER: IN_PROCESS_RUNTIME } = require('../../services/hostedEngine');

const runsInProcess = async (agentUser: any, installation: any): Promise<boolean> => {
  const pairs: { agentName: string; instanceId: string }[] = [];
  if (installation?.agentName) {
    pairs.push({ agentName: String(installation.agentName).toLowerCase(), instanceId: String(installation.instanceId || 'default') });
  }
  const meta = agentUser?.botMetadata || {};
  const name = String(meta.agentName || agentUser?.username || '').toLowerCase();
  if (name) pairs.push({ agentName: name, instanceId: String(meta.instanceId || 'default') });
  if (!pairs.length) return false;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../../models/AgentRegistry');
  return Boolean(await AgentInstallation.exists({
    status: 'active',
    $and: [{ $or: pairs }, IN_PROCESS_RUNTIME],
  }));
};

const issueRuntimeTokenForAgent = async (agentUser: any, label: any, installation: any = null, issuer: any = null) => {
  const ownerId = issuer?.ownerUserId || installation?.installedBy;
  const refuseDeletingOwner = async (tokenHash?: string, mintedHere = false) => {
    if (!ownerId || !await isAccountDeleting(ownerId)) return;
    if (tokenHash) {
      // A shared identity can already hold another owner's token. A refusal
      // must only revoke the credential this deleting owner actually owns.
      // A new hash belongs to this request even on legacy reprovision paths
      // that do not create an issuer-backed ledger row.
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const AgentCredential = require('../../models/AgentCredential');
      if (mintedHere || await AgentCredential.exists({ tokenHash, ownerUserId: ownerId })) {
        await revokeRuntimeTokenEverywhere(tokenHash);
      }
    }
    const error = Object.assign(new Error('This account is being deleted; runtime credentials cannot be issued.'), {
      code: 'account_deleting', status: 409,
    });
    throw error;
  };
  await refuseDeletingOwner();
  if (await runsInProcess(agentUser, installation)) throw new InProcessAgentTokenRefused();
  // Check if agent already has a runtime token (reuse existing)
  const existingToken = agentUser.agentRuntimeTokens?.[0] || installation?.runtimeTokens?.[0];
  if (existingToken) {
    // Backfill a credential row for the pre-substrate token so the existing
    // fleet becomes listable and cascade-revocable (#1312: without
    // this the collection stays near-empty while coverage looks fine).
    // Provenance is unknown, so no parent lineage is claimed.
    if (issuer?.ownerUserId) {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const AgentCredential = require('../../models/AgentCredential');
      await AgentCredential.updateOne(
        { tokenHash: existingToken.tokenHash },
        {
          $setOnInsert: {
            kind: 'runtime',
            ownerUserId: issuer.ownerUserId,
            agentUserId: agentUser._id,
            label: existingToken.label || 'Runtime token',
            status: 'active',
          },
        },
        { upsert: true },
      ).catch((err: Error) => console.warn('Credential backfill failed:', err.message));
    }
    await refuseDeletingOwner(existingToken.tokenHash);
    return {
      existing: true,
      label: existingToken.label,
      createdAt: existingToken.createdAt,
      // Can't return raw token for existing - it's hashed
      message: 'Agent already has a runtime token. Use existing token or revoke to generate new.',
    };
  }

  // Generate new token
  const rawToken = `cm_agent_${randomSecret(32)}`;
  const tokenRecord = {
    tokenHash: hash(rawToken),
    label: label || 'Runtime token',
    createdAt: new Date(),
  };

  // Credential row FIRST, then the embedded record (#1312:
  // warn-and-continue after issuing would hand out a working token with no
  // row — invisible to listing, unreachable by cascade, lineage-free. If
  // the ledger write fails, the mint fails; no token exists without a row
  // when an issuer is known).
  if (issuer?.ownerUserId) {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentCredential = require('../../models/AgentCredential');
    await AgentCredential.create({
      tokenHash: tokenRecord.tokenHash,
      kind: 'runtime',
      ownerUserId: issuer.ownerUserId,
      agentUserId: agentUser._id,
      parentId: issuer.parentId || null,
      machineId: issuer.machineId || null,
      label: tokenRecord.label,
    });
  }

  // Store on User model (primary - shared across pods)
  agentUser.agentRuntimeTokens = agentUser.agentRuntimeTokens || [];
  agentUser.agentRuntimeTokens.push(tokenRecord);
  await agentUser.save();

  // Also store on installation for backward compatibility
  if (installation) {
    installation.runtimeTokens = installation.runtimeTokens || [];
    installation.runtimeTokens.push(tokenRecord);
    await installation.save();
  }

  // The check above runs before the token exists. A migration can mark the
  // identity in-process while this mint is still saving, and its revoke may
  // run before the save lands. Re-check now the token is
  // stored: if the identity went in-process meanwhile, take the token back
  // and refuse. A save that landed before the migration's revoke is caught
  // by that revoke, so no ordering leaves a live token.
  if (await runsInProcess(agentUser, installation)) {
    await revokeRuntimeTokenEverywhere(tokenRecord.tokenHash);
    throw new InProcessAgentTokenRefused();
  }

  await refuseDeletingOwner(tokenRecord.tokenHash, true);
  return {
    token: rawToken,
    label: label || 'Runtime token',
    existing: false,
    createdAt: tokenRecord.createdAt,
  };
};

/**
 * Legacy function for backward compatibility.
 * @deprecated Use issueRuntimeTokenForAgent instead
 */
const issueRuntimeTokenForInstallation = async (installation: any, label: any) => {
  if (await runsInProcess(null, installation)) throw new InProcessAgentTokenRefused();
  const rawToken = `cm_agent_${randomSecret(32)}`;
  installation.runtimeTokens = installation.runtimeTokens || [];
  installation.runtimeTokens.push({
    tokenHash: hash(rawToken),
    label: label || 'Runtime token',
    createdAt: new Date(),
  });
  await installation.save();
  if (await runsInProcess(null, installation)) {
    await revokeRuntimeTokenEverywhere(hash(rawToken));
    throw new InProcessAgentTokenRefused();
  }
  return { token: rawToken, label: label || 'Runtime token' };
};

const issueUserTokenForInstallation = async ({
  agentName,
  instanceId,
  displayName,
  podId,
  scopes,
  force = false,
}: {
  agentName: any;
  instanceId: any;
  displayName: any;
  podId: any;
  scopes: any;
  force?: boolean;
}) => {
  const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName.toLowerCase(), {
    instanceId,
    displayName,
  });
  await AgentIdentityService.ensureAgentInPod(agentUser, podId);
  const normalizedScopes = normalizeScopes(scopes);

  // Preserve existing token unless force-rotation is requested
  if (agentUser.apiToken && !force) {
    agentUser.apiTokenScopes = normalizedScopes;
    await agentUser.save();
    return {
      token: agentUser.apiToken,
      scopes: normalizedScopes,
      createdAt: agentUser.apiTokenCreatedAt,
      existing: true,
    };
  }

  const token = agentUser.generateApiToken();
  agentUser.apiTokenScopes = normalizedScopes;
  await agentUser.save();
  return { token, scopes: normalizedScopes, createdAt: agentUser.apiTokenCreatedAt, existing: false };
};

module.exports = {
  AGENT_USER_TOKEN_SCOPES,
  normalizeScopes,
  AUTO_GRANTED_INTEGRATION_SCOPES,
  sanitizeStringList,
  normalizeToolPolicy,
  normalizeContextPolicy,
  getRuntimeTokenHashesForAgent,
  revokeRuntimeCredentials,
  revokeRuntimeTokenEverywhere,
  revokeRuntimeTokensForAgent,
  revokeRuntimeTokensAfterLastUninstall,
  issueRuntimeTokenForAgent,
  InProcessAgentTokenRefused,
  runsInProcess,
  issueRuntimeTokenForInstallation,
  issueUserTokenForInstallation,
};

export {};
