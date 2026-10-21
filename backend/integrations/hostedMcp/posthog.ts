/**
 * PostHog hosted MCP, native tools mode. The nine named pins are selected from
 * connector-ops's consenting 2026-10-21 tools/list capture. The single `exec`
 * gateway and third-party gateway routes are excluded.
 *
 * The capture was project-limited but granted 153 broad OAuth scopes. The
 * smaller scope set below is a candidate inferred from corresponding PostHog
 * API operations; a scoped consent and call probe must verify it before merge.
 */
import type { HostedMcpEntry, HostedMcpPinnedTool } from '../../services/hostedMcpEntryService';
import captured from './posthog-pins.json';

const capturedByName = new Map(captured.tools.map((tool) => [tool.name, tool]));

const pinnedTool = (
  name: string,
  description: string,
  toolClass: 'read' | 'write',
): HostedMcpPinnedTool => {
  const measured = capturedByName.get(name);
  if (!measured) throw new Error(`PostHog pin is absent from the consenting capture: ${name}`);
  return {
    name,
    upstreamName: name,
    description,
    class: toolClass,
    inputSchema: measured.inputSchema,
    annotations: {
      readOnlyHint: measured.annotations.readOnlyHint,
      destructiveHint: measured.annotations.destructiveHint,
    },
  };
};

export const POSTHOG_ENTRY: HostedMcpEntry = {
  id: 'posthog',
  title: 'PostHog',
  description: 'Insights, dashboards and feature flags in your PostHog project.',
  resource: 'https://mcp.posthog.com/mcp?mode=tools',
  // PRM advertises bare /mcp as the RFC 8707 audience; the query selects tools mode only.
  audience: 'https://mcp.posthog.com/mcp',
  issuer: 'https://oauth.posthog.com',
  client: 'cimd',
  scopes: [
    'dashboard:read', 'dashboard:write', 'feature_flag:read',
    'feature_flag:write', 'insight:read', 'query:read',
  ],
  revoke: {
    page: 'https://app.posthog.com/settings/user-connected-apps',
    endpoint: 'https://oauth.posthog.com/oauth/revoke/',
  },
  tools: [
    pinnedTool('insights-list', 'List saved insights in the connected PostHog project.', 'read'),
    pinnedTool('insight-get', 'Read a saved insight definition by ID.', 'read'),
    pinnedTool('insight-query', 'Run a saved insight and read its results.', 'read'),
    pinnedTool('dashboards-get-all', 'List dashboards in the connected PostHog project.', 'read'),
    pinnedTool('dashboard-get', 'Read a dashboard and its tiles by ID.', 'read'),
    pinnedTool('feature-flag-get-all', 'List feature flag definitions in the connected project.', 'read'),
    pinnedTool('feature-flag-get-definition-by-key', 'Read a feature flag definition by key.', 'read'),
    pinnedTool('dashboard-create', 'Create a dashboard in the connected project.', 'write'),
    pinnedTool('create-feature-flag', 'Create a feature flag in the connected project.', 'write'),
  ],
};
