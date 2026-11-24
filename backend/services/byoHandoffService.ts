/**
 * Server-owned handoff cards for a hosted agent that needs the person's local
 * workspace. The card contains the CLI attach flow, never a runtime token.
 *
 * Keep this command builder in the service boundary: the model supplies only
 * the adapter, operating system, and an optional display name. Everything that
 * reaches a shell-looking code block is validated and composed here.
 */
import { CLI_NPX_COMMAND } from './cliNpxCommand';

export type ByoHandoffAdapter = 'claude' | 'codex' | 'opencode' | 'dsh';
type ByoHandoffOs = 'mac' | 'linux' | 'windows';

const BYO_HANDOFF_ADAPTERS: readonly ByoHandoffAdapter[] = [
  'claude', 'codex', 'opencode', 'dsh',
];
const BYO_HANDOFF_OSES: readonly ByoHandoffOs[] = ['mac', 'linux', 'windows'];
// Adapters whose Windows setup is the Bring your own page, not the card's lines.
export const CONNECT_PAGE_ON_WINDOWS: ReadonlySet<ByoHandoffAdapter> = new Set<ByoHandoffAdapter>(['claude', 'codex']);

// Commonly's own lines run the CLI through npx, so nothing of Commonly's is
// installed globally (F582: `npm i -g` stops with EACCES on a stock-Node Mac).
// A harness is installed from its own docs, as the Bring your own page leaves
// Claude Code, Codex and OpenCode to theirs. dsh keeps its line: the adapter is
// smoke-tested against this one pinned version (cli/src/lib/adapters/dsh.js).
const DSH_INSTALL = 'npm i -g @deepseek-ai/dsh@0.2.1-rc.2';

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

// The instance this server answers on. A bare `commonly login` falls back to
// the CLI's built-in production default, so a card posted by a dev or
// self-hosted server would register the person's computer against commonly.me.
// Only a plain http(s) origin is composed into the shell line.
const PLAIN_ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
const publicApiOrigin = (): string => {
  try {
    const { origin } = new URL(process.env.PUBLIC_API_URL || process.env.BACKEND_URL || '');
    return PLAIN_ORIGIN.test(origin) ? origin : '';
  } catch {
    return '';
  }
};

const environmentPath = (os: ByoHandoffOs): string => {
  if (os === 'windows') return 'C:\\Users\\you\\agents\\environment.json';
  if (os === 'linux') return '/home/you/agents/environment.json';
  return '/Users/you/agents/environment.json';
};

const installLines = (adapter: ByoHandoffAdapter): string[] => (adapter === 'dsh' ? [DSH_INSTALL] : []);

/**
 * The bytes copied by the in-pod card. Keep the login, attach, and run lines
 * together: attaching alone creates a seat but does not make it answer a pod.
 */
export const buildByoHandoffCommand = ({
  adapter,
  os,
  podId,
  agentName,
  memoryFrom,
  memoryInstance = 'default',
  apiOrigin = '',
}: {
  adapter: ByoHandoffAdapter;
  os: ByoHandoffOs;
  podId: string;
  agentName: string;
  memoryFrom?: string;
  memoryInstance?: string;
  apiOrigin?: string;
}): string => {
  const memoryFlags = memoryFrom ? ` --memory-from ${memoryFrom} --memory-instance ${memoryInstance}` : '';
  const attach = `${CLI_NPX_COMMAND} agent attach ${adapter} --pod ${podId} --name ${agentName}${memoryFlags}`;
  const withEnvironment = adapter === 'opencode' || adapter === 'dsh'
    ? `${attach} --env ${environmentPath(os)}`
    : attach;
  const login = apiOrigin ? `${CLI_NPX_COMMAND} login --instance ${apiOrigin}` : `${CLI_NPX_COMMAND} login`;
  return [...installLines(adapter), login, withEnvironment, `${CLI_NPX_COMMAND} agent run ${agentName}`].join('\n');
};

interface ByoHandoffPayload {
  kind: 'byo-handoff';
  adapter: ByoHandoffAdapter;
  agentName: string;
  podId: string;
  os: ByoHandoffOs;
  commands: Partial<Record<ByoHandoffOs, string>>;
  supportedOs: ByoHandoffOs[];
  memoryFrom?: string;
  memoryInstance?: string;
}

export const buildByoHandoffPayload = ({
  adapter,
  os,
  podId,
  agentName,
  memoryFrom,
  memoryInstance = 'default',
  apiOrigin = publicApiOrigin(),
}: {
  adapter: unknown;
  os: unknown;
  podId: unknown;
  agentName: unknown;
  memoryFrom?: string;
  memoryInstance?: string;
  apiOrigin?: string;
}): ByoHandoffPayload | { error: string } => {
  if (!isAdapter(adapter)) return { error: 'adapter must be claude, codex, opencode, or dsh' };
  if (!isOs(os)) return { error: 'os must be mac, linux, or windows' };
  if (memoryFrom !== undefined && (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(memoryFrom)
    || !/^[a-z0-9][a-z0-9_-]*$/.test(memoryInstance))) {
    return { error: 'invalid source memory identity' };
  }
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
    // Claude Code and Codex on native Windows connect from the Bring your own
    // page, which the card links to: a bare `npm`/`commonly` in PowerShell is the
    // .ps1 shim Windows 11's default policy refuses (F342), and `agent attach`
    // refuses a sandboxed seat on Windows by design. The tab stays, with no lines.
    if (supported === 'windows' && CONNECT_PAGE_ON_WINDOWS.has(adapter)) continue;
    commands[supported] = buildByoHandoffCommand({
      adapter, os: supported, podId: normalizedPodId, agentName: normalizedName,
      memoryFrom, memoryInstance, apiOrigin,
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
    // The card's Windows link carries these to the Bring your own page, whose
    // install copies the memory the other tabs' `--memory-from` would.
    ...(memoryFrom !== undefined ? { memoryFrom, memoryInstance } : {}),
  };
};

export const defaultByoHandoffName = (username: unknown, adapter: ByoHandoffAdapter): string => {
  const base = safeName(username) || 'my';
  return `${base}-${adapter}`.slice(0, 40).replace(/-+$/g, '') || `my-${adapter}`;
};

/** Suggestions do not reserve names; attach must still enforce ownership. */
export const availableByoHandoffName = async (
  base: string,
  isTaken: (name: string) => Promise<boolean>,
): Promise<string> => {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    // Check the global registry, including other owners and uninstalled names.
    // Reusing an owned name can still collide with that agent's existing memory.
    // eslint-disable-next-line no-await-in-loop
    if (!await isTaken(candidate)) return candidate;
  }
  throw new Error('No free local agent name found. Supply a different name.');
};
