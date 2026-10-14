/**
 * A self-serve agent gets an identity of its own.
 *
 * "Bring your own runtime", "Run it here", "On my computer" and Scout's
 * connect card all create a seat under a name the person chooses. Agent
 * identity is keyed on (agentName, instanceId), so choosing the name of a
 * built-in or published agent would bind that agent's identity, which every
 * installer shares, instead of creating a new one. The seat would post under
 * that agent's name and profile. Found 2026-10-14, when a connect card named a
 * seat "claude-code" and bound the official Claude Code identity.
 *
 * Reserved: names the platform defines as agent types (agentIdentityService),
 * and names whose registry row is official (`registry: 'commonly-official'`,
 * which covers the first-party apps such as Scout). Community-published agents
 * are multi-installer by design and stay installable; a per-owner identity for
 * them is #609's follow-up. A self-serve name someone else already holds is the
 * #609 guard's refusal.
 */

export interface ReservedNameRefusal {
  code: 'agent_name_reserved';
  error: string;
}

const suggestion = (name: string): string => {
  const base = name.replace(/-code$/, '').replace(/^@[^/]+\//, '');
  return `your-name-${base}`;
};

export const reservedAgentNameRefusal = async (agentName: unknown): Promise<ReservedNameRefusal | null> => {
  const name = String(agentName || '').trim().toLowerCase();
  if (!name) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const AgentIdentityService = require('./agentIdentityService');
  let reserved = Boolean(AgentIdentityService.getAgentTypeConfig(name));
  if (!reserved) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { AgentRegistry } = require('../models/AgentRegistry');
    const row = await AgentRegistry.getByName(name);
    reserved = Boolean(row) && row.registry === 'commonly-official';
  }
  if (!reserved) return null;
  return {
    code: 'agent_name_reserved',
    error: `"${name}" is the name of a built-in agent. Choose a name of your own for this agent, `
      + `such as "${suggestion(name)}".`,
  };
};
