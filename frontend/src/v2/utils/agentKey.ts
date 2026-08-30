/**
 * The ONE key for "which pod member is this agent" across chat author clicks
 * and the inspector's member map/detail view.
 *
 * COMPOSITE, because instanceId alone is not an identity: every BYO fleet
 * seat carries instanceId 'default', so the previous `instanceId || agentName`
 * collapsed nine agents onto the key 'default' — the member map's last writer
 * won, and clicking ANY agent's byline or member row rendered the same seat's
 * profile (Sam, 2026-08-26: "clicking any agent's profile goes to fable").
 *
 * Producers (V2PodChat author map) and consumers (V2PodInspector member map)
 * MUST both import this — the collision existed precisely because each side
 * derived its own key.
 */
export const agentKeyFor = (
  agent: { agentName?: string; name?: string; instanceId?: string },
): string => {
  const name = agent.agentName || agent.name || '';
  return `${name}:${agent.instanceId || 'default'}`;
};
