/**
 * Atlassian (Jira + Confluence) — a hosted-MCP catalogue entry (TASK-185).
 *
 * Pinned from a real `tools/list` taken on a consenting account at
 * 2026-10-09T11:44:46.145Z against `https://mcp.atlassian.com/v2/mcp` (Atlassian Rovo MCP v2), with
 * the token at exactly the scopes below. The measurement and the raw capture are
 * connector-ops's; the `inputSchema` of every pinned tool is transcribed from it
 * unchanged, because drift compares the pin with the live list.
 *
 * Read tools only, and the credential itself carries no `write:*` scope: the
 * token was granted exactly the read and search scopes requested. The server
 * still LISTS two writers under that token (`executeWrite`,
 * `executeDestructive`), so the pin is what keeps them out, with the vendor's
 * scope check as the second fence.
 *
 * Pin set per Wren 76760: a read is pinned only if it is named, product-scoped
 * and carries no credential or foreign payload. So `executeRead` (a by-name
 * dispatcher over ~316 read operations across every Atlassian product) and
 * `discover` (its catalogue) are excluded even though both are annotated
 * read-only: pinning them would make a "Jira and Confluence, read" grant mean
 * far more than its label.
 *
 * Atlassian's tool names are camelCase, which the namespace cannot carry, so each
 * pin has a snake_case `name` and keeps the vendor's name as `upstreamName`
 * (the name drift compares and calls use).
 *
 * The authorization server does not offer `openid`, so the token response has
 * no ID token and the row carries no `providerSubject`: a reconnect with a
 * different Atlassian account is not detected by subject for this entry.
 * `offline_access` is what returns the refresh token (measured: 8 h access
 * token plus refresh), and `prompt=consent` makes a reconnect re-issue one.
 *
 * Revocation is real at this vendor: the capture revoked both the refresh and
 * the access token at the endpoint below (HTTP 200 each). Whether a call after a
 * revoke actually fails is the live walk's to measure (C9).
 */
import type { HostedMcpEntry, HostedMcpPinnedTool } from '../../services/hostedMcpEntryService';

/** The vendor's annotations as the pin records them; all six pinned reads arrived with this set. */
const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false };

/** One read tool under a snake_case name, calling the vendor's camelCase tool. */
const readTool = (
  name: string,
  upstreamName: string,
  description: string,
  inputSchema: Record<string, unknown>,
): HostedMcpPinnedTool => ({
  name,
  upstreamName,
  description,
  class: 'read',
  inputSchema,
  annotations: { ...READ_ANNOTATIONS },
});

export const ATLASSIAN_ENTRY: HostedMcpEntry = {
  id: 'atlassian',
  title: 'Atlassian',
  description: 'Jira issues and Confluence pages in your Atlassian site.',
  resource: 'https://mcp.atlassian.com/v2/mcp',
  issuer: 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3',
  // The authorization server advertises `client_id_metadata_document_supported:
  // true` and S256, so nothing is registered and no secret is stored.
  client: 'cimd',
  authorizationParams: { prompt: 'consent' },
  scopes: [
    'read:me',
    'read:account',
    'offline_access',
    'read:jira:agent-interface',
    'search:jira:agent-interface',
    'read:confluence:agent-interface',
    'search:confluence:agent-interface',
  ],
  revoke: {
    page: 'https://id.atlassian.com/manage-profile/apps',
    endpoint: 'https://auth.atlassian.com/oauth/revoke',
  },
  tools: [
    readTool(
      'get_accessible_atlassian_resources',
      'getAccessibleAtlassianResources',
      'List the Atlassian sites (cloud ids) this connection can read.',
      {
        type: 'object',
        properties: {},
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    ),
    readTool(
      'atlassian_user_info',
      'atlassianUserInfo',
      'Read the account id and profile of the connected Atlassian user.',
      {
        type: 'object',
        properties: {},
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    ),
    readTool(
      'get_confluence_content',
      'getConfluenceContent',
      'Read one Confluence page or blog post by id or URL.',
      {
        type: 'object',
        properties: {
          cloudId: {
            type: 'string',
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          content_id: {
            type: 'string',
            minLength: 1,
            description: 'Required when content_url is omitted. Numeric Confluence content ID, or a\nConfluence tiny link key (the encoded part\nfrom /wiki/x/ URLs, e.g. 4_sXAQ). Recognized Confluence content URLs are also\naccepted and converted to the content ID, but prefer content_url for URLs.\nOne of content_id or content_url is required.\n',
          },
          content_url: {
            type: 'string',
            minLength: 1,
            description: 'Required when content_id is omitted. Full URL of the Confluence content.\nSupported: pages/live docs\n(/pages/{id}), blog URLs (/blog/{id}), whiteboards\n(/whiteboard/{id}), databases (/database/{id}), folders (/folder/{id}),\nand TinyUrl (/wiki/x/{key}). Prefer this for URLs copied from Confluence.\nOne of content_id or content_url is required.\n',
          },
          detail: {
            type: 'string',
            enum: [
              'summary',
              'ai_summary',
              'outline',
              'full',
            ],
            description: 'Response shape for document-style reads. summary = title + excerpt + counts\n(default, cheap). ai_summary = the generated AI summary when available, otherwise\nnull; it does not fall back to the standard excerpt. outline = heading tree (cheap,\nfor navigation). full = body in the requested format (use when intending to edit).\nNon-document content such as whiteboards, databases, folders, and embeds does not support detail;\ncontent_format is a separate representation selector for\nformats such as whiteboard svg/png, database csv, or embed url.\n',
          },
          content_format: {
            type: 'string',
            enum: [
              'html',
              'markdown',
              'url',
              'svg',
              'png',
              'csv',
            ],
            description: 'Body format. Doc types: html (default) or markdown. Document HTML can contain\nsupported macro wrappers instead of content displayed in Confluence web. When\nvisible macro content is required, use resolveConfluenceContentMacros with the\nreturned numeric content ID and all=true; use discover if its full contract is\nneeded. Whiteboards support only svg and png: use svg to inspect content or\nprepare edits, or png for a screenshot. Never use html or markdown for a\nwhiteboard. PNG is read-only and returns a short-lived presigned URL in\nbody.value, not the image content. Databases: csv.\nURL-backed content such as embeds: url.\n',
          },
          draft: {
            type: 'boolean',
            description: 'If true, read the draft version instead of current. Only supported for\npages and blog posts.\n',
          },
        },
        required: [
          'cloudId',
        ],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    ),
    readTool(
      'search_confluence',
      'searchConfluence',
      'Search Confluence content with CQL.',
      {
        type: 'object',
        properties: {
          cloudId: {
            type: 'string',
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          cql: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            description: 'CQL query string (max 4096 chars). Examples:\n`type = page AND space = "DEV"`,\n`title ~ "onboarding" AND lastmodified > "2025-01-01"`,\n`creator = currentUser() AND type IN (page, blogpost) ORDER BY lastmodified DESC`.\n',
          },
          cqlcontext: {
            type: 'string',
            description: 'JSON-encoded execution context, e.g. {"spaceKey":"DEV"}. Restricts the search to the supplied scope.',
          },
          expand: {
            type: 'string',
            description: 'Comma-separated list of content properties to expand on each result.\nCommon values: `space`, `version`, `body.view`, `metadata.labels`,\n`ancestors`. Use sparingly to avoid large responses.\n',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Max number of results to return per page (1-100). Defaults to 25.',
          },
          cursor: {
            type: 'string',
            description: 'Opaque pagination cursor returned by a previous call. Omit to start from the first page.',
          },
        },
        required: [
          'cloudId',
          'cql',
        ],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    ),
    readTool(
      'get_jira_issue',
      'getJiraIssue',
      'Read one Jira or Jira Service Management issue by key or id.',
      {
        type: 'object',
        properties: {
          cloudId: {
            type: 'string',
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          issueIdOrKey: {
            type: 'string',
            description: 'Issue key (PROJ-123), numeric ID, or a Jira issue URL',
          },
          fields: {
            type: 'array',
            items: {},
            description: "Custom Jira field IDs to fetch (e.g. [\"customfield_10010\", \"customfield_10020\"]). Overrides the view's fetch strategy. For custom fields in normal use, prefer view: \"evidence\", which fetches and maps them automatically. Use [\"*all\"] to fetch every field (expensive — prefer view: \"full\" instead).\n",
          },
          includeEditableFields: {
            type: 'boolean',
            description: 'When true, also return compact metadata for fields the authenticated user can edit on this issue, including type, allowed values, and operations. Omit unless preparing an edit: this makes an extra Jira REST call.\n',
          },
          fieldsByKeys: {
            type: 'boolean',
            description: 'When true, each entry in `fields` is interpreted as a Jira field key (e.g. "summary", "description") instead of a field id. Matches the Jira REST `fieldsByKeys` query parameter. Ignored when `fields` is omitted (default field list uses ids).\n',
          },
          expand: {
            type: 'string',
            description: 'Additional Jira expand tokens (comma-separated), e.g. "renderedFields,changelog". Merged with any expand the server adds for custom-field mapping (e.g. "names"); duplicate tokens removed. Note "changelog" here returns only the newest page, sorted newest-first, and it accepts startAt/maxResults then ignores them — so it cannot be paged and reports a longer history as complete. Use listJiraIssueChangelogs to read all of it (oldest-first); do not mix their orderings.\n',
          },
          properties: {
            type: 'array',
            items: {},
            description: 'Issue entity property keys to return (Jira `properties` query param, repeated per key). Omit unless you rely on app-specific issue properties.\n',
          },
          failFast: {
            type: 'boolean',
            description: "When true, forwards Jira's `failFast` query flag for this GET. Omit for Jira default behavior.\n",
          },
          responseContentFormat: {
            type: 'string',
            enum: [
              'markdown',
              'html',
            ],
            description: 'Format for rich-text bodies — description and environment, plus any comment bodies the view returns. Defaults to markdown. Set html to receive HTML, which is lossless, so you can pass it straight back to editJiraIssue/addOrEditJiraIssueComment with contentFormat: html. Bodies holding anything markdown cannot represent — inline media, panels, expands, layouts, statuses, @mentions, dates, emoji — are returned as HTML automatically, because markdown would drop those nodes or turn them into literal text on write-back. An explicit markdown request is overridden for those bodies, with a warning saying so; appliedContentFormat in the response reports the format you actually got.\n',
          },
          actionSource: {
            type: 'string',
            enum: [
              'jira_mcp_card',
              'model_tool_call',
            ],
            description: 'Optional invocation attribution. Jira MCP cards set jira_mcp_card; omit for model/tool-loop calls.',
          },
          view: {
            type: 'string',
            enum: [
              'compact',
              'evidence',
              'full',
            ],
            description: 'Output view preset. Default: "compact". Options: "compact", "evidence", "full". compact = minimal fields for scanning; evidence = decision-relevant detail; full = complete response.',
          },
        },
        required: [
          'cloudId',
          'issueIdOrKey',
        ],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    ),
    readTool(
      'search_jira_issues_using_jql',
      'searchJiraIssuesUsingJql',
      'Search Jira issues with JQL.',
      {
        type: 'object',
        properties: {
          cloudId: {
            type: 'string',
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          jql: {
            type: 'string',
            description: "JQL query string e.g. \"project = PROJ AND status = 'In Progress'\". If the tool returns a repairHint, follow it and retry.\n",
          },
          searchResultMode: {
            type: 'string',
            enum: [
              'issues',
              'count',
              'all',
            ],
            description: 'Default "issues". Never count for normal search or if nextPageToken used. If total for same query is known, reuse it. Use "count" only when no trusted count exists and either the user asks or a downstream step needs it. Use "all" only if both count and issues required.\n',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum results to return (default 50, max 100)',
          },
          fields: {
            type: 'array',
            items: {},
            description: 'Fields per issue (e.g. ["summary", "status", "customfield_10010"]). customfield_* IDs are site-specific — discover the correct id for story points etc. on this Cloud site. Honoured exactly when supplied. Values map to issues[].fields.customFields (human labels), not raw customfield_* keys. The default "compact" view omits custom fields; use view: "evidence" for velocity/sprint JQL (fetches and maps all custom fields) or pass explicit customfield_* IDs.\n',
          },
          nextPageToken: {
            type: 'string',
            description: 'Pagination token from a previous response to fetch the next page',
          },
          responseContentFormat: {
            type: 'string',
            enum: [
              'markdown',
              'html',
            ],
            description: 'Format for rich-text bodies (description, environment, comments) when the view returns them. Defaults to markdown; html is lossless for a later editJiraIssue. Issues holding anything markdown cannot represent (media, panels, expands, statuses, @mentions) are returned as HTML automatically, decided per issue. An explicit markdown request is overridden for those bodies, with a warning saying so; appliedContentFormat in the response reports the format you actually got.\n',
          },
          actionSource: {
            type: 'string',
            enum: [
              'jira_mcp_card',
              'model_tool_call',
            ],
            description: 'Optional invocation attribution. Jira MCP cards set jira_mcp_card; omit for model/tool-loop calls.',
          },
          view: {
            type: 'string',
            enum: [
              'compact',
              'evidence',
              'full',
            ],
            description: 'Output view preset. Default: "compact". Options: "compact", "evidence", "full". compact = minimal fields for scanning; evidence = decision-relevant detail; full = complete response.',
          },
        },
        required: [
          'cloudId',
          'jql',
        ],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
    ),
  ],
};
