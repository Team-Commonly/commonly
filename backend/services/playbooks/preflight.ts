import { PlaybookDefinition, PlaybookError, validatePlaybook } from './definition';

export interface PlaybookMember {
  userId: string;
  handle: string;
  kind: 'agent' | 'person';
  runtime?: 'native' | 'byo';
  agentName?: string;
  instanceId?: string;
}
export interface PlaybookCapability {
  name: string;
  mode: 'read' | 'write' | 'write-with-confirm';
  audience: string[];
}
export interface PlaybookContext {
  members: PlaybookMember[];
  /** Only live grants whose tools are still pinned by the server entry. */
  tools: PlaybookCapability[];
  grantPodRefusal: string | null;
}

/** Re-evaluate from current server records at turn-on and every run start. */
export const preflightPlaybook = (
  input: unknown,
  bindings: Record<string, unknown>,
  context: PlaybookContext,
): { book: PlaybookDefinition; members: Map<string, PlaybookMember> } => {
  const book = validatePlaybook(input);
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)
    || Object.keys(bindings).some((role) => !book.roles.some((entry) => entry.key === role))) {
    throw new PlaybookError('invalid_bindings', 'Bind exactly the declared roles');
  }
  const members = new Map<string, PlaybookMember>();
  for (const role of book.roles) {
    const id = bindings[role.key];
    const member = typeof id === 'string' ? context.members.find((entry) => entry.userId === id) : undefined;
    if (!member) throw new PlaybookError('role_not_member', `Bind ${role.key} to a current pod member`);
    if (member.kind !== role.kind) throw new PlaybookError('role_kind', `${role.key} requires a ${role.kind}`);
    if (member.kind === 'agent' && (!member.runtime || !member.agentName)) {
      throw new PlaybookError('agent_not_installed', `${role.key} needs an active agent installation`);
    }
    members.set(role.key, member);
  }
  for (const step of book.steps) {
    const member = members.get(step.role)!;
    if (step.delivers === 'pr' && member.runtime === 'native') {
      throw new PlaybookError('native_write', `${step.title} needs a BYO agent to open a pull request`);
    }
    if (step.reads?.length && context.grantPodRefusal) {
      throw new PlaybookError(context.grantPodRefusal, 'Use a private, invite-only, unbridged pod with native agents for connector reads');
    }
    for (const name of step.reads || []) {
      const granted = context.tools.filter((tool) => tool.name === name && tool.audience.includes(member.userId));
      if (!granted.length) throw new PlaybookError('tool_not_granted', `${step.title}: ${name} is not granted and pinned for this actor`);
      if (!granted.some((tool) => tool.mode === 'read')) {
        throw new PlaybookError('write_not_supported', `${step.title}: ${name} is a write; use a person write-gap step`);
      }
    }
  }
  return { book, members };
};
