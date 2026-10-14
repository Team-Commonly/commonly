/**
 * Who may hold a credential for an agent identity.
 *
 * A runtime token belongs to an agent identity (agentName, instanceId), and
 * runtime auth authorizes that token in EVERY pod where the identity has an
 * active installation, whoever installed it (agentRuntimeAuth). So holding the
 * credential for an identity installed by several users means acting in all of
 * their pods. Minting one, or force-rotating it, must therefore require owning
 * the identity outright.
 *
 * SOLE-INSTALLER rule (Vera's ruling on #1315, first applied to daemon
 * adoption). Two clauses, both must hold:
 *   - an active installation of the identity installedBy the owner exists;
 *   - no active installation of it exists installedBy anyone else.
 * The negative clause is what stops a shared identity (two humans each
 * installed it) from being bound to, or minted by, one person. Once #609 gives
 * per-owner identities it becomes redundant rather than wrong, so it stays.
 *
 * Moved here from routes/agentBinding.ts on 2026-10-14, so the daemon routes
 * and the token routes share one rule.
 */

export type OwnershipFailure = 'owner_installation_missing' | 'another_installer' | 'unknown_installer';

export type OwnershipCheck =
  | { owned: true }
  | { owned: false; failure: OwnershipFailure };

const RUNTIME_INSTALLATION_COLLATION = { locale: 'en', strength: 2 };

export const ownsRuntimeIdentity = async (
  ownerUserId: unknown,
  agentName: string,
  instanceId: string,
): Promise<OwnershipCheck> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { AgentInstallation } = require('../models/AgentRegistry');
  const mine = await AgentInstallation.findOne({
    agentName, instanceId, installedBy: ownerUserId, status: 'active',
  }).collation(RUNTIME_INSTALLATION_COLLATION).select('_id').lean();
  if (!mine) return { owned: false, failure: 'owner_installation_missing' };
  const others = await AgentInstallation.findOne({
    agentName, instanceId, status: 'active', installedBy: { $ne: ownerUserId },
  }).collation(RUNTIME_INSTALLATION_COLLATION).select('installedBy').lean();
  if (!others) return { owned: true };
  // MongoDB $ne also matches a missing field. Keep that legacy state safely
  // non-adoptable, but report it separately so an owner can repair it.
  if (!others.installedBy) return { owned: false, failure: 'unknown_installer' };
  return { owned: false, failure: 'another_installer' };
};

/** User-facing refusal for the token routes. */
export const runtimeCredentialRefusal: Record<OwnershipFailure, string> = {
  owner_installation_missing: 'Only the user who installed this agent can issue or revoke its runtime tokens.',
  another_installer: 'This agent is also installed by another user, so no single user can hold its runtime tokens.',
  unknown_installer:
    'An installation of this agent has no recorded installer; an admin must repair it before tokens can be issued.',
};
