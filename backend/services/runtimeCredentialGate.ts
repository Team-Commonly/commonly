import AgentCredential from '../models/AgentCredential';
import { isAccountDeleting } from './accountDeletionState';
import { machineHasLiveAuthorization } from './machineService';

type LedgerCredential = {
  kind?: string;
  status?: string;
  ownerUserId?: unknown;
  expiresAt?: Date | null;
  parentId?: unknown;
  machineId?: string | null;
};

type EmbeddedTokenHolder = {
  agentRuntimeTokens?: Array<{ tokenHash?: string; expiresAt?: Date | null }>;
};

/**
 * Why a credential-ledger row may not authenticate a `cm_agent_` bearer, or
 * null when it may. Every transport that accepts a runtime bearer (the HTTP
 * middleware and the agent WebSocket) calls this one copy, so the transports
 * apply the same rules and cannot drift apart.
 */
export const runtimeCredentialRefusalReason = async (
  credential: LedgerCredential,
): Promise<string | null> => {
  if (credential.kind !== 'runtime') return 'Invalid agent credential';
  if (credential.status !== 'active') return 'Token revoked';
  if (await isAccountDeleting(credential.ownerUserId)) return 'Credential owner is being deleted';
  if (credential.expiresAt && credential.expiresAt < new Date()) return 'Session token expired';
  if (credential.parentId) {
    const parent = await AgentCredential.findById(credential.parentId).select('status').lean();
    if (!parent || parent.status !== 'active') return 'Issuing credential revoked';
  }
  if (credential.machineId && !await machineHasLiveAuthorization(
    credential.machineId, credential.ownerUserId as string,
  )) {
    return 'Machine access revoked';
  }
  return null;
};

/** An entry in `User.agentRuntimeTokens` can carry its own expiry. */
export const embeddedRuntimeTokenExpired = (agentUser: EmbeddedTokenHolder, tokenHash: string): boolean => {
  const record = (agentUser.agentRuntimeTokens || []).find((t) => t.tokenHash === tokenHash);
  return Boolean(record?.expiresAt && record.expiresAt < new Date());
};
