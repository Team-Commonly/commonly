/**
 * Server-owned handoff cards for a hosted agent that needs the person's local
 * workspace. The card contains the CLI attach flow, never a runtime token.
 *
 * Keep this command builder in the service boundary: the model supplies only
 * the adapter, operating system, and an optional display name. Everything that
 * reaches a shell-looking code block is validated and composed here.
 */

export type ByoHandoffAdapter = 'claude' | 'codex' | 'opencode' | 'dsh';
export type ByoHandoffOs = 'mac' | 'linux' | 'windows';

export const BYO_HANDOFF_ADAPTERS: readonly ByoHandoffAdapter[] = [
  'claude', 'codex', 'opencode', 'dsh',
];
export const BYO_HANDOFF_OSES: readonly ByoHandoffOs[] = ['mac', 'linux', 'windows'];

const CLI_INSTALL = 'npm i -g @commonlyai/cli@latest';
const DSH_INSTALL = `${CLI_INSTALL} @deepseek-ai/dsh@0.2.1-rc.2`;
const OPENCODE_INSTALL = `${CLI_INSTALL} opencode-ai`;

const isAdapter = (value: unknown): value is ByoHandoffAdapter => (
  typeof value === 'string' && (BYO_HANDOFF_ADAPTERS as readonly string[]).includes(value)
);
const isOs = (value: unknown): value is ByoHandoffOs => (
  typeof value === 'string' && (BYO_HANDOFF_OSES as readonly string[]).includes(value)
);

const safeName = (value: unknown): string => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);

const safePodId = (value: unknown): string => String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');

const environmentPath = (os: ByoHandoffOs): string => {
  if (os === 'windows') return 'C:\\Users\\you\\agents\\environment.json';
  if (os === 'linux') return '/home/you/agents/environment.json';
  return '/Users/you/agents/environment.json';
};

const installCommand = (adapter: ByoHandoffAdapter): string => {
  if (adapter === 'dsh') return DSH_INSTALL;
  if (adapter === 'opencode') return OPENCODE_INSTALL;
  return CLI_INSTALL;
};

/**
 * The bytes copied by the in-pod card. Keep the login, attach, and run lines
 * together: attaching alone creates a seat but does not make it answer a pod.
 */
export const buildByoHandoffCommand = ({
  adapter,
  os,
  podId,
  agentName,
}: {
  adapter: ByoHandoffAdapter;
  os: ByoHandoffOs;
  podId: string;
  agentName: string;
}): string => {
  const attach = `commonly agent attach ${adapter} --pod ${podId} --name ${agentName}`;
  const withEnvironment = adapter === 'opencode' || adapter === 'dsh'
    ? `${attach} --env ${environmentPath(os)}`
    : attach;
  return [installCommand(adapter), 'commonly login', withEnvironment, `commonly agent run ${agentName}`].join('\n');
};

export interface ByoHandoffPayload {
  kind: 'byo-handoff';
  adapter: ByoHandoffAdapter;
  agentName: string;
  podId: string;
  os: ByoHandoffOs;
  commands: Partial<Record<ByoHandoffOs, string>>;
  supportedOs: ByoHandoffOs[];
}

export const buildByoHandoffPayload = ({
  adapter,
  os,
  podId,
  agentName,
}: {
  adapter: unknown;
  os: unknown;
  podId: unknown;
  agentName: unknown;
}): ByoHandoffPayload | { error: string } => {
  if (!isAdapter(adapter)) return { error: 'adapter must be claude, codex, opencode, or dsh' };
  if (!isOs(os)) return { error: 'os must be mac, linux, or windows' };
  const normalizedPodId = safePodId(podId);
  const normalizedName = safeName(agentName);
  if (!normalizedPodId) return { error: 'pod id is required' };
  if (!/^[a-z0-9-]{2,40}$/.test(normalizedName)) {
    return { error: 'agent name must contain 2-40 letters, digits, or dashes' };
  }

  const supportedOs: ByoHandoffOs[] = adapter === 'opencode' || adapter === 'dsh'
    ? ['mac']
    : [...BYO_HANDOFF_OSES];
  const selectedOs = supportedOs.includes(os) ? os : supportedOs[0];
  const commands: Partial<Record<ByoHandoffOs, string>> = {};
  for (const supported of supportedOs) {
    commands[supported] = buildByoHandoffCommand({
      adapter, os: supported, podId: normalizedPodId, agentName: normalizedName,
    });
  }
  return {
    kind: 'byo-handoff',
    adapter,
    agentName: normalizedName,
    podId: normalizedPodId,
    os: selectedOs,
    commands,
    supportedOs,
  };
};

export const defaultByoHandoffName = (username: unknown, adapter: ByoHandoffAdapter): string => {
  const base = safeName(username) || 'my';
  return `${base}-${adapter}`.slice(0, 40).replace(/-+$/g, '') || `my-${adapter}`;
};
