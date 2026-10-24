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
 * Agent-DM installations are conversation projections, not ownership. They
 * do not satisfy either clause. The negative clause stops a shared identity (two humans each
 * installed it) from being bound to, or minted by, one person. Once #609 gives
 * per-owner identities it becomes redundant rather than wrong, so it stays.
 *
 * Moved here from routes/agentBinding.ts on 2026-10-14, so the daemon routes
 * and the token routes share one rule. Setting a push webhook URL (install and
 * agent-config routes) applies it too, admins exempt.
 */

export type OwnershipFailure = 'owner_installation_missing' | 'another_installer' | 'unknown_installer';

export type OwnershipCheck =
  | { owned: true }
  | { owned: false; failure: OwnershipFailure };

const RUNTIME_INSTALLATION_COLLATION = { locale: 'en', strength: 2 };

type RuntimeInstallation = { installedBy?: unknown; podId?: unknown };

const ownershipInstallations = async (agentName: string, instanceId: string): Promise<RuntimeInstallation[]> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { AgentInstallation } = require('../models/AgentRegistry');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Pod = require('../models/Pod');
  const installations: RuntimeInstallation[] = await AgentInstallation.find({
    agentName, instanceId, status: 'active',
  }).collation(RUNTIME_INSTALLATION_COLLATION).select('installedBy podId').lean();
  const dmPods = await Pod.find({
    _id: { $in: installations.map((installation) => installation.podId).filter(Boolean) }, type: 'agent-dm',
  }).select('_id').lean();
  const dmPodIds = new Set(dmPods.map((pod: { _id: unknown }) => String(pod._id)));
  return installations.filter((installation) => !dmPodIds.has(String(installation.podId)));
};

/** Explain a genuine second installer to the first installer in Settings. */
export const describeRuntimeIdentityBlockers = async (
  ownerUserId: unknown,
  agentName: string,
  instanceId: string,
): Promise<string[]> => {
  const others = (await ownershipInstallations(agentName, instanceId))
    .filter((installation) => String(installation.installedBy) !== String(ownerUserId));
  if (!others.length) return [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Pod = require('../models/Pod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../models/User');
  const [pods, users] = await Promise.all([
    Pod.find({ _id: { $in: others.map((installation) => installation.podId).filter(Boolean) } }).select('name').lean(),
    User.find({ _id: { $in: others.map((installation) => installation.installedBy).filter(Boolean) } })
      .select('username displayName').lean(),
  ]);
  const podNames = new Map(pods.map((pod: { _id: unknown; name: string }) => [String(pod._id), pod.name]));
  const userNames = new Map(users.map((user: { _id: unknown; username: string; displayName?: string }) => [
    String(user._id), user.displayName || user.username,
  ]));
  return others.map((installation) => `${podNames.get(String(installation.podId)) || 'unknown pod'} (${userNames.get(String(installation.installedBy)) || 'unknown installer'})`);
};

/** The negative clause: does an active installation by anyone else exist? */
const otherInstallerFailure = async (
  ownerUserId: unknown,
  agentName: string,
  instanceId: string,
): Promise<OwnershipFailure | null> => {
  const others = (await ownershipInstallations(agentName, instanceId))
    .find((installation) => String(installation.installedBy) !== String(ownerUserId));
  if (!others) return null;
  // MongoDB $ne also matches a missing field. Keep that legacy state safely
  // non-adoptable, but report it separately so an owner can repair it.
  if (!others.installedBy) return 'unknown_installer';
  return 'another_installer';
};

export const ownsRuntimeIdentity = async (
  ownerUserId: unknown,
  agentName: string,
  instanceId: string,
): Promise<OwnershipCheck> => {
  const installations = await ownershipInstallations(agentName, instanceId);
  const mine = installations
    .find((installation) => installation.installedBy && String(installation.installedBy) === String(ownerUserId));
  if (!mine) return { owned: false, failure: 'owner_installation_missing' };
  const other = installations.find((installation) => String(installation.installedBy) !== String(ownerUserId));
  const failure = other ? (other.installedBy ? 'another_installer' : 'unknown_installer') : null;
  return failure ? { owned: false, failure } : { owned: true };
};

/**
 * The same rule at install time, when the owner's installation is about to be
 * created and so cannot exist yet: only the negative clause is checked.
 * Holding it means the install leaves the owner as the identity's sole
 * installer, which is what `ownsRuntimeIdentity` asks afterwards.
 */
export const willSolelyInstallRuntimeIdentity = async (
  ownerUserId: unknown,
  agentName: string,
  instanceId: string,
): Promise<OwnershipCheck> => {
  const failure = await otherInstallerFailure(ownerUserId, agentName, instanceId);
  return failure ? { owned: false, failure } : { owned: true };
};

/** User-facing refusal for the token routes. */
export const runtimeCredentialRefusal: Record<OwnershipFailure, string> = {
  owner_installation_missing: 'Only the user who installed this agent can issue or revoke its runtime tokens.',
  another_installer: 'This agent is also installed by another user, so no single user can hold its runtime tokens.',
  unknown_installer:
    'An installation of this agent has no recorded installer; an admin must repair it before tokens can be issued.',
};

/**
 * User-facing refusal for setting a push webhook (`config.runtime.webhookUrl`).
 * The webhook is a credential in the same sense as a token: what it returns
 * with `outcome: 'posted'` is posted AS the agent identity.
 */
export const webhookUrlRefusal: Record<OwnershipFailure, string> = {
  owner_installation_missing: 'Only the user who installed this agent can set its webhook URL.',
  another_installer: 'This agent is also installed by another user, so no single user can set its webhook URL. '
    + 'Install it under a different name to use your own webhook.',
  unknown_installer:
    'An installation of this agent has no recorded installer; an admin must repair it before a webhook URL can be set.',
};
