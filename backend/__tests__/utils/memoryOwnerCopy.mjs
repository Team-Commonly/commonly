/** Test fixture for the owner editor API; attach uses install-time handoff. */
export const copyOwnerMemory = async (client, {
  sourceAgentName, sourceInstanceId = 'default', targetAgentName, targetInstanceId = 'default',
}) => {
  const endpoint = (name, instance) => `/api/agent-memory/${encodeURIComponent(name)}/${encodeURIComponent(instance)}/editable`;
  const source = await client.get(endpoint(sourceAgentName, sourceInstanceId));
  const content = source?.sections?.long_term?.content;
  if (typeof content !== 'string') throw new Error('Hosted memory response is missing long_term content');
  if (!content) return { copied: false, reason: 'source-empty' };
  const targetPath = endpoint(targetAgentName, targetInstanceId);
  const target = await client.get(targetPath);
  const prior = target?.sections?.long_term;
  if (typeof prior?.content !== 'string') throw new Error('Local memory response is missing long_term content');
  if (prior.visibility !== 'private') throw new Error('Local long-term memory must be private before copying hosted memory');
  if (prior.content === content) return { copied: false, reason: 'already-copied' };
  if (prior.content) throw new Error('Local agent already has different memory; choose a new local name');
  // A concurrent first write wins rather than being overwritten by this copy.
  await client.patch(`${targetPath}/long_term`, {
    copyFrom: { agentName: sourceAgentName, instanceId: sourceInstanceId },
    expectedUpdatedAt: prior.updatedAt ?? null,
  });
  return { copied: true };
};
