/** An installation created before instance ids were stored belongs to the
 * default instance. Share this predicate between runtime auth and the roster
 * so the same pod set is used for both grant checks. */
export const installationIdentityFilter = (agentName: string, instanceId: string) => ({
  agentName,
  ...(instanceId === 'default'
    ? { $or: [{ instanceId: 'default' }, { instanceId: null }] }
    : { instanceId }),
});
