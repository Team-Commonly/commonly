/**
 * GitHub's remote MCP server. The six input schemas are pinned from
 * github/github-mcp-server at 796afb74711ddc856fe587debc49373e21c8d0f7
 * (the upstream tool snapshots), not from a live account. A consenting
 * account's first tools/list remains the drift check before this is offered.
 *
 * The credential is a separate, public GitHub App with read-only repository
 * permissions. GitHub App user tokens use the app's permissions rather than
 * OAuth scopes; offline_access asks GitHub for a refresh token only.
 */
import type { HostedMcpEntry, HostedMcpPinnedTool } from '../../services/hostedMcpEntryService';
import pin from './githubMcpSchemas.json';

const descriptions: Record<string, string> = {
  get_me: 'Read the account profile for this GitHub connection.',
  list_issues: 'List issues in a GitHub repository.',
  issue_read: 'Read an issue and its comments or related issues.',
  list_pull_requests: 'List pull requests in a GitHub repository.',
  pull_request_read: 'Read a pull request, its files, reviews or comments.',
  get_file_contents: 'Read a file or directory in a GitHub repository.',
};

const tools: HostedMcpPinnedTool[] = pin.tools.map((tool) => ({
  name: tool.name,
  upstreamName: tool.name,
  description: descriptions[tool.name],
  class: 'read',
  inputSchema: tool.inputSchema,
  annotations: { readOnlyHint: true },
}));

export const GITHUB_MCP_ENTRY: HostedMcpEntry = {
  id: 'github-mcp',
  title: 'GitHub',
  description: 'Read files, issues and pull requests in repositories this GitHub App can access.',
  resource: 'https://api.githubcopilot.com/mcp/',
  issuer: 'https://github.com/login/oauth',
  client: 'pre-registered',
  // GitHub's AS metadata omits auth methods. Its GitHub App token guide names
  // client_id and client_secret as POST parameters, so pin that method instead
  // of applying RFC 8414's Basic default. Confirm on the first live consent.
  tokenEndpointAuthMethod: 'client_secret_post',
  scopes: ['offline_access'],
  revoke: { page: 'https://github.com/settings/applications' },
  tools,
};
