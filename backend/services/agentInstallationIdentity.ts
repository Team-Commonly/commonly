/** An installation created before instance ids were stored belongs to the
 * default instance. Share this predicate between runtime auth and the roster
 * so the same pod set is used for both grant checks. */
export const installationIdentityFilter = (agentName: string, instanceId: string) => ({
  agentName,
  ...(instanceId === 'default'
    ? { $or: [{ instanceId: 'default' }, { instanceId: null }] }
    : { instanceId }),
});

/** instanceId predates the normalized intake path, so a stored one can be
 * mixed-case. Pair this with installationIdentityFilter on a normalized id. */
export const IDENTITY_COLLATION = { locale: 'en', strength: 2 };

/** The description the self-serve paths write for an agent nobody described.
 * It predates the agent's first connection, so it says nothing about the agent. */
export const PLACEHOLDER_AGENT_DESCRIPTION = 'A connected agent.';
