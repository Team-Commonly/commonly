/**
 * The first-party tool Installables (tools plan §2, ADR-001 amendment §1).
 *
 * A tool Installable is a builtin package with one `McpServer` component that
 * points at Commonly's own grant broker. Its `enabledTools` are projected from
 * the broker's definitions at seed time, so the allow-list the page offers is
 * exactly the set the broker enforces — there is no second list to drift.
 *
 * The page never renders a control the server does not enforce, so the mint
 * reads the seeded row (the catalogue the page saw) rather than this constant.
 */
import type { ToolDefinition } from '../toolBrokerService';
import { RoomGrantError } from '../roomGrantService';
import { HOSTED_MCP_ENTRIES, findHostedMcpEntry } from '../../integrations/hostedMcp/entries';
import { hostedMcpToolName, type HostedMcpEntry } from '../hostedMcpEntryService';

// Resolved on first use, not at import: the broker module loads
// githubAppService (jsonwebtoken), and routes/grants.ts must stay loadable
// without GitHub crypto so the read routes' suite mounts it unmocked.
const toolDefinitions = (): ToolDefinition[] => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { getToolDefinitions } = require('../toolBrokerService');
  return getToolDefinitions();
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Installable = require('../../models/Installable');

/** The MCP server name `routes/mcpGrants.ts` announces; one URL per grant. */
export const GRANT_BROKER_ID = 'commonly-grant-broker';
export const GRANT_BROKER_URL = '${COMMONLY_API_URL}/api/mcp/grants/${COMMONLY_GRANT_ID}';

export type ToolReadiness = { available: true } | { available: false; reason: 'not_configured' };

export interface ProjectedTool {
  name: string;
  description: string;
  requiredWriteMode: 'read' | 'write-with-confirm' | 'write';
  /** A per-tool constant (plan §2): the card and the page list tools, not calls. */
  irreversible: boolean;
}

interface McpComponentLike {
  name?: string;
  type?: string;
  enabledTools?: string[];
}

interface ToolInstallableMeta {
  connectionType: 'github-app';
  readiness: () => ToolReadiness;
}

/**
 * Readiness per tool Installable. GitHub needs the App credentials only; the
 * legacy `GITHUB_APP_INSTALLATION_ID_COMMONLY` that `isConfigured()` also
 * requires is the deployment's default repo, and the broker never falls back
 * to it — it executes as the Connection row's own installation.
 */
export const TOOL_INSTALLABLES: Record<string, ToolInstallableMeta> = {
  github: {
    connectionType: 'github-app',
    readiness: () => (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY
      ? { available: true }
      : { available: false, reason: 'not_configured' }),
  },
};

const githubToolNames = (): string[] => toolDefinitions()
  .filter((definition) => definition.connectionType === 'github-app')
  .map((definition) => definition.name);

export const buildGithubToolInstallable = () => ({
  installableId: 'github',
  name: 'GitHub',
  description: 'Issues and pull requests in this instance\'s own GitHub repository. Connecting your own GitHub is coming.',
  version: '1.0.0',
  kind: 'app',
  source: 'builtin',
  // A grant targets a room or a seat in it; nothing is installed per user.
  scope: 'pod',
  status: 'active',
  requires: [],
  components: [
    {
      name: GRANT_BROKER_ID,
      type: 'mcp-server',
      description: 'Commonly-hosted MCP server, one URL per grant. The agent authenticates with its own runtime token and never holds the credential.',
      transport: 'http',
      source: { spec: 'builtin:github' },
      url: GRANT_BROKER_URL,
      enabledTools: githubToolNames(),
    },
  ],
});

export const mcpComponentOf = (installable: { components?: McpComponentLike[] } | null | undefined): McpComponentLike | null => (
  (installable?.components || []).find((component) => component?.type === 'mcp-server') || null
);

/** The tools a component exposes, in the shape the page draws. Absent `enabledTools` means all; empty means none. */
export const projectTools = (component: McpComponentLike | null): ProjectedTool[] => {
  if (!component) return [];
  const enabled = Array.isArray(component.enabledTools) ? new Set(component.enabledTools) : null;
  return toolDefinitions()
    .filter((definition) => !enabled || enabled.has(definition.name))
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      requiredWriteMode: definition.requiredWriteMode,
      irreversible: Boolean(definition.irreversible),
    }));
};

export interface ResolvedBroker {
  installableId: string;
  brokerId: string;
  enabledTools: string[];
}

/**
 * The broker a grant on this connection names, read from the source that owns
 * the tool list for its type. `brokerId` is never a client input (ADR-001: it
 * names the proxy that holds the material, and since #1662 that proxy is
 * Commonly's own).
 *
 * A `github-app` connection reads the seeded catalogue row, because the
 * allow-list the page offered and the list the broker enforces must be one
 * list. A `hosted-mcp` connection reads its catalogue ENTRY instead: the entry
 * is the only source for what a grant on that row may name (scope §3), and
 * because there is one entry per vendor rather than one Installable per type,
 * keying this lookup on the connection TYPE would let a grant on one vendor's
 * row name another vendor's tool (scope §7). `entries` is a parameter so that
 * lookup is testable against a fixture catalogue while `HOSTED_MCP_ENTRIES` is
 * still empty.
 */
export const resolveBrokerFor = async (
  connection: { type?: unknown; config?: { entryId?: unknown } | null },
  entries: HostedMcpEntry[] = HOSTED_MCP_ENTRIES,
): Promise<ResolvedBroker> => {
  const connectionType = String(connection?.type || '').trim();
  if (connectionType === 'hosted-mcp') {
    const entryId = String(connection?.config?.entryId || '').trim();
    const entry = findHostedMcpEntry(entries, entryId);
    if (!entry) {
      throw new RoomGrantError(
        'broker_unavailable',
        `no hosted-mcp catalogue entry named ${entryId || '(none)'}`,
        503,
      );
    }
    return {
      installableId: entry.id,
      // One proxy serves every grant, whichever type and entry it came from:
      // `grantBrokerProjectionService` selects a seat's grants by this one id,
      // so a per-entry value here would make the grant invisible to the seat.
      brokerId: GRANT_BROKER_ID,
      enabledTools: entry.tools.map((tool) => hostedMcpToolName(entry, tool)),
    };
  }
  const installableId = Object.keys(TOOL_INSTALLABLES)
    .find((id) => TOOL_INSTALLABLES[id].connectionType === connectionType);
  const row = installableId
    ? await Installable.findOne({ installableId, source: 'builtin', status: 'active' }).lean()
    : null;
  const component = mcpComponentOf(row);
  if (!installableId || !component?.name) {
    throw new RoomGrantError('broker_unavailable', `no tool Installable is seeded for ${connectionType}`, 503);
  }
  return {
    installableId,
    brokerId: String(component.name),
    enabledTools: projectTools(component).map((tool) => tool.name),
  };
};
