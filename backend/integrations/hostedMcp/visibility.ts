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

export const isHostedMcpEntryHidden = (entryId: string, env: NodeJS.ProcessEnv = process.env): boolean => (
  hiddenHostedMcpEntryIds(env).has(entryId)
);
