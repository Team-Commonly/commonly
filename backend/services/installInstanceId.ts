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

/**
 * F653: the instances of this agent the caller already holds, so the answer can
 * name them. Two sources: rows the caller installed (any status, since an
 * uninstalled one keeps its User and memory) and bot Users they own.
 *
 * `installedBy` is not ownership. A mention writes a row naming whoever typed
 * it (`config.autoJoinSource`), and a DM's row names a guest, so neither is
 * read. Every candidate from either source is then dropped when anyone else
 * owns that identity: an owner-naming row of another user (hasForeignOwner) or
 * a bot User owned by someone else. Following the hint must never bind the
 * caller's pod to another person's agent and its memory.
 * An id equal to the agent name is never named: the add-to-pod path can store
 * one, but /install binds it as 'default'.
 * 'default' sorts first: it is the one a person most often meant.
 */
export const callerInstanceIds = async (agentName: string, userId: unknown, exclude: string): Promise<string[]> => {
  const name = agentName.toLowerCase();
  const caller = String(userId);
  // Loaded here for the same reason as in identityInUse above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const AgentIdentityService = require('./agentIdentityService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../models/User');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Pod = require('../models/Pod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { hasForeignOwner } = require('./agentPodAddition');
  const agentType = AgentIdentityService.resolveAgentType(name);
  const normalize = (id: unknown) => (id ? String(id).toLowerCase() : 'default');

  const [rows, owned] = await Promise.all([
    AgentInstallation.find({ agentName: name, installedBy: userId })
      .select('instanceId podId config.autoJoinSource').lean(),
    User.find({ isBot: true, 'botMetadata.agentName': agentType, 'botMetadata.ownerUserId': caller })
      .select('botMetadata.instanceId').lean(),
  ]);
  type Row = { instanceId?: unknown; podId?: unknown; config?: { autoJoinSource?: unknown } | null };
  const ownerRows = (rows as Row[]).filter((row) => !row.config?.autoJoinSource);
  const dmPods = ownerRows.length
    ? await Pod.find({
      _id: { $in: ownerRows.map((row) => row.podId) },
      type: { $in: [...AgentIdentityService.DM_POD_TYPES_GUARD] },
    }).select('_id').lean()
    : [];
  const inDm = new Set(dmPods.map((pod: { _id: unknown }) => String(pod._id)));

  const candidates = new Set<string>();
  for (const row of ownerRows) if (!inDm.has(String(row.podId))) candidates.add(normalize(row.instanceId));
  for (const bot of owned as Array<{ botMetadata?: { instanceId?: string } }>) {
    candidates.add(normalize(bot.botMetadata?.instanceId));
  }
  candidates.delete(exclude);
  // /install rewrites an explicit instanceId equal to the agent name to
  // 'default', so naming that id would send the caller to a different agent.
  candidates.delete(name);

  const kept: string[] = [];
  for (const instanceId of candidates) {
    // A person holds few instances of one agent, so one read each is fine.
    // eslint-disable-next-line no-await-in-loop
    if (await hasForeignOwner(name, instanceId, userId)) continue;
    // eslint-disable-next-line no-await-in-loop
    const bot = await User.findOne({
      username: AgentIdentityService.buildAgentUsername(agentType, instanceId), isBot: true,
    }).select('botMetadata.ownerUserId').lean() as { botMetadata?: { ownerUserId?: unknown } } | null;
    if (bot?.botMetadata?.ownerUserId && String(bot.botMetadata.ownerUserId) !== caller) continue;
    kept.push(instanceId);
  }
  return kept.sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
};

/** F653: the install made an identity nobody held. Said on a 2xx, never a refusal. */
export const newAgentIdentityWarning = (instanceId: string, existing: string[]) => ({
  code: 'new_agent_identity',
  instanceId,
  ...(existing.length ? { existingInstanceIds: existing } : {}),
  message: `This install created a new agent identity, instance '${instanceId}', with its own memory and no history.`
    + (existing.length
      ? ` You already have this agent as ${existing.map((id) => `'${id}'`).join(', ')}; `
        + `pass instanceId '${existing[0]}' to install the agent you already have.`
      : ''),
});

/**
 * F653: the identity lookup failed, so whether this install made a new agent
 * is unknown. Said anyway (a degraded check over-delivers), under its own code
 * so nothing reads it as the certain notice, and with no reuse hint, since the
 * caller's instances went unchecked too.
 */
export const uncheckedAgentIdentityWarning = (instanceId: string) => ({
  code: 'agent_identity_unchecked',
  instanceId,
  message: `Could not confirm whether instance '${instanceId}' is an agent identity you already had. `
    + 'If it is new, it has its own memory and no history; pass an explicit instanceId to choose the agent you mean.',
});

module.exports = {
  deriveInstanceId,
  resolveUnnamedInstanceId,
  identityInUse,
  callerInstanceIds,
  newAgentIdentityWarning,
  uncheckedAgentIdentityWarning,
};
