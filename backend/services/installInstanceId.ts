// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { IDENTITY_COLLATION, installationIdentityFilter } = require('./agentInstallationIdentity');

/**
 * Derive instanceId from displayName for consistent agent identity across pods.
 * This ensures the same agent (e.g., "Cuz") gets the same instanceId regardless
 * of which pod it's installed in, allowing shared runtime tokens and memory.
 */
export const deriveInstanceId = (displayName: unknown, agentName: string): string => {
  if (!displayName) return 'default';
  const slug = String(displayName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    // After the collapse, at most one dash sits at each end.
    .replace(/^-/, '')
    .replace(/-$/, '');
  if (!slug || slug === agentName.toLowerCase()) {
    return 'default';
  }
  return slug;
};

/** Whether anything already holds this identity: an installation row in any
 * status, or the agent's bot user (which outlives its rows). */
const identityInUse = async (agentName: string, instanceId: string): Promise<boolean> => {
  const row = await AgentInstallation.findOne(installationIdentityFilter(agentName, instanceId))
    .select('_id')
    .collation(IDENTITY_COLLATION)
    .lean();
  if (row) return true;
  // Loaded here, not at the top: the identity service's graph reaches back
  // into the registry models this module is loaded beside.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const AgentIdentityService = require('./agentIdentityService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../models/User');
  const username = AgentIdentityService.buildAgentUsername(AgentIdentityService.resolveAgentType(agentName), instanceId);
  return Boolean(await User.findOne({ username, isBot: true }).select('_id').lean());
};

/**
 * The instance an install that names none gets. A display name that only
 * repeats the end of the agent's own name ("CTO" for `acme-cto`) names
 * no second instance, so a fresh install takes 'default' instead of doubling
 * the name into `acme-cto-cto`.
 *
 * Only a fresh one. If anything already holds the slug identity (a row in any
 * status, or its bot user), the slug stays, so a re-install finds the agent and
 * memory it made (ADR-005 detach and reattach).
 */
export const resolveUnnamedInstanceId = async (displayName: unknown, agentName: string): Promise<string> => {
  const derived = deriveInstanceId(displayName, agentName);
  const name = agentName.toLowerCase();
  if (derived === 'default' || !name.endsWith(`-${derived}`)) return derived;
  // Never 'is default held?': after the first install that is this agent's own
  // default, and asking would split it on every later install. A default held
  // by someone else is refused by the route's own ownership guards.
  return (await identityInUse(name, derived)) ? derived : 'default';
};

module.exports = { deriveInstanceId, resolveUnnamedInstanceId };
