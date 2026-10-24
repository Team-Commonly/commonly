/** Instance policy for which hosted entries the Tools catalogue may offer. */
export const hiddenHostedMcpEntryIds = (env: NodeJS.ProcessEnv = process.env): Set<string> => {
  const raw = env.HOSTED_MCP_HIDDEN_ENTRIES;
  if (!raw) return new Set();
  const ids: unknown = JSON.parse(raw);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.trim() === id && id.length > 0)) {
    throw new Error('HOSTED_MCP_HIDDEN_ENTRIES must be a JSON array of entry IDs');
  }
  return new Set(ids);
};

/** Exceptions use authenticated User IDs, never client-supplied names or query fields.
 * A malformed setting grants no exceptions, including otherwise valid entries.
 */
const allowedHiddenEntryUsers = (env: NodeJS.ProcessEnv): Record<string, string[]> => {
  const raw = env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST;
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value);
    if (!entries.every(([entry, users]) => (
      /^[a-z0-9][a-z0-9-]*$/.test(entry)
      && Array.isArray(users)
      && users.every((id: unknown) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))
    ))) return {};
    return value as Record<string, string[]>;
  } catch {
    return {};
  }
};

export const isHostedMcpEntryHidden = (
  entryId: string,
  env: NodeJS.ProcessEnv = process.env,
  userId?: string,
): boolean => {
  if (!hiddenHostedMcpEntryIds(env).has(entryId)) return false;
  if (typeof userId !== 'string' || !/^[a-f0-9]{24}$/.test(userId)) return true;
  const allowlist = allowedHiddenEntryUsers(env);
  return !Object.prototype.hasOwnProperty.call(allowlist, entryId)
    || !allowlist[entryId].includes(userId);
};
