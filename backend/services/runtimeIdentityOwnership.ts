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
 * SOLE-INSTALLER rule (ruling on #1315, first applied to daemon
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

/**
 * One runtime per agent identity: it runs in process or it holds a token. The
 * issuers (routes/registry/tokens.ts) refuse an identity with an in-process
 * installation. The routes that write an in-process installation ask this
 * instead: before the write, and again after it, taking the row back. Every
 * installation counts, whatever its status: a key on a stopped row is still a
 * key. Reads the runtime tokens on the bot user and on its installations, and
 * the bot's user token.
 */
export const identityHoldsRuntimeToken = async (agentName: string, instanceId: string): Promise<boolean> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { AgentInstallation } = require('../models/AgentRegistry');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../models/User');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const AgentIdentityService = require('./agentIdentityService');
  const username = AgentIdentityService.buildAgentUsername(
    AgentIdentityService.resolveAgentType(agentName), instanceId,
  );
  const botHolds = await User.exists({
    username,
    isBot: true,
    $or: [{ 'agentRuntimeTokens.0': { $exists: true } }, { apiTokenHash: { $type: 'string' } }],
  });
  if (botHolds) return true;
  const sibling = await AgentInstallation.findOne({ agentName, instanceId, 'runtimeTokens.0': { $exists: true } })
    .collation(RUNTIME_INSTALLATION_COLLATION).select('_id').lean();
  return Boolean(sibling);
};

/** The refusal body for an in-process write on an identity that holds a token. */
export const RUNTIME_TOKEN_HELD = {
  code: 'runtime_token_held',
  error: 'This agent already holds a token, so it can\'t run on Commonly as well. '
    + 'Revoke the token first, or use a different name.',
} as const;

/**
 * Nothing active and something uninstalled: the install paths revoke what such
 * an identity left behind (revokeRuntimeTokensAfterLastUninstall), and no token
 * route can reach it first, because each one needs an active row.
 */
export const identityIsDormant = async (agentName: string, instanceId: string): Promise<boolean> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { AgentInstallation } = require('../models/AgentRegistry');
  const statusRow = (status: string) => AgentInstallation.exists(
    { agentName, instanceId, status }, { collation: RUNTIME_INSTALLATION_COLLATION },
  );
  return Boolean(await statusRow('uninstalled')) && !(await statusRow('active'));
};

const RESTORED_FIELDS = ['status', 'version', 'displayName', 'scopes', 'config', 'githubIssueWrite'];

/**
 * Undo an installation write, as the issuer takes a token back after its own
 * re-check. `previous` is the row as it stood before the write, null if there
 * was none.
 */
export const takeBackInstallation = async (
  key: { agentName: unknown; podId: unknown; instanceId: unknown },
  previous: Record<string, unknown> | null,
): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { AgentInstallation } = require('../models/AgentRegistry');
  const row = {
    agentName: { $eq: key.agentName }, podId: { $eq: key.podId }, instanceId: { $eq: key.instanceId },
  };
  if (!previous) {
    await AgentInstallation.deleteOne(row);
    return;
  }
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  RESTORED_FIELDS.forEach((field) => {
    if (previous[field] === undefined) $unset[field] = 1;
    else $set[field] = previous[field];
  });
  await AgentInstallation.updateOne(row, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
};

/** Explain a genuine second installer to the first installer in Settings. */
export type RuntimeIdentityBlocker = { podName: string; installerName: string };
export const describeRuntimeIdentityBlockers = async (
  ownerUserId: unknown,
  agentName: string,
  instanceId: string,
): Promise<RuntimeIdentityBlocker[]> => {
  const others = (await ownershipInstallations(agentName, instanceId))
    .filter((installation) => String(installation.installedBy) !== String(ownerUserId));
  if (!others.length) return [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Pod = require('../models/Pod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../models/User');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const DMService = require('./dmService');
  const pods = await Pod.find({ _id: { $in: others.map((installation) => installation.podId).filter(Boolean) } });
  const visiblePods = (await Promise.all(pods.map(async (pod: { _id: unknown; name: string }) => (
    await DMService.canViewPod(ownerUserId, pod) ? pod : null
  )))).filter((pod: { _id: unknown; name: string } | null): pod is { _id: unknown; name: string } => pod !== null);
  const podNames = new Map<string, string>(visiblePods.map((pod) => [String(pod._id), pod.name]));
  const visibleOthers = others.filter((installation) => podNames.has(String(installation.podId)));
  const users = await User.find({ _id: { $in: visibleOthers.map((installation) => installation.installedBy).filter(Boolean) } })
    .select('username displayName').lean();
  const userNames = new Map<string, string>(users.map((user: { _id: unknown; username: string; displayName?: string }) => [
    String(user._id), user.displayName || user.username,
  ]));
  return visibleOthers.map((installation) => ({
    podName: podNames.get(String(installation.podId))!,
    installerName: userNames.get(String(installation.installedBy)) || 'unknown installer',
  }));
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
