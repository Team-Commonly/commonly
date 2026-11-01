/**
 * Atlassian (Jira + Confluence) hosted MCP entry (TASK-239). Tool schemas are
 * pinned from connector-ops's consenting 2026-10-19 tools/list capture under
 * exactly the read, search, and write scopes below.
 *
 * Six reads and five named writers are pinned. Each writer acts on one Jira
 * issue or Confluence item, or creates one Jira issue. Broad discover and
 * execute* dispatchers stay excluded because their operation reach changes
 * independently of the pin. createConfluenceContent is excluded because its
 * free-form contentType can enable external synced folders without schema
 * drift. Each named write parks for member approval. Jira comment edits are
 * irreversible because Jira keeps no history of the previous comment body.
 * CamelCase vendor names use snake_case local names.
 *
 * Atlassian does not offer openid, so reconnect subject continuity is not
 * available. offline_access yields a refresh token; prompt=consent re-issues
 * it.
 *
 * Revoke is page-only (TASK-339). Atlassian answers our CIMD client's RFC 7009
 * revoke at /oauth/revoke with 401, so a removal that waited on it could never
 * finish. The 200s the two tool captures saw (10-09, 10-19) came from a DCR
 * client they registered for themselves, not from the client this entry uses.
 * Both of those authorizations were still listed on the person's Atlassian
 * apps page on 11-01, so a 200 from that endpoint does not remove the app
 * either. Removal ends on our side and hands the person the page.
 */
import type { HostedMcpEntry, HostedMcpPinnedTool } from '../../services/hostedMcpEntryService';
import { hostedMcpApiBase } from '../../services/hostedMcpIntakeService';

/** The vendor annotations for the captured named reads and writes. */
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

const writeTool = (
  name: string,
  upstreamName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  irreversible = false,
): HostedMcpPinnedTool => ({
  name, upstreamName, description, class: 'write', inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false },
  ...(irreversible ? { irreversible: true } : {}),
});

export const ATLASSIAN_ENTRY: HostedMcpEntry = {
  id: 'atlassian',
  title: 'Atlassian',
  description: 'Jira issues and Confluence content in your Atlassian site.',
  connectNotice: `Before connecting, ask your Atlassian admin to allow ${hostedMcpApiBase()}/** in MCP server domains.`,
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
    'write:jira:agent-interface',
    'search:jira:agent-interface',
    'read:confluence:agent-interface',
    'write:confluence:agent-interface',
    'search:confluence:agent-interface',
  ],
  revoke: { page: 'https://id.atlassian.com/manage-profile/apps' },
  tools: [
    readTool(
      "get_accessible_atlassian_resources",
      "getAccessibleAtlassianResources",
      "List the Atlassian sites (cloud ids) this connection can read.",
      {
        type: "object",
        properties: {},
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    readTool(
      "atlassian_user_info",
      "atlassianUserInfo",
      "Read the account id and profile of the connected Atlassian user.",
      {
        type: "object",
        properties: {},
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    readTool(
      "get_confluence_content",
      "getConfluenceContent",
      "Read one Confluence page, blog post, live doc, comment, whiteboard, embed, database or folder by id or URL.",
      {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          content_id: {
            type: "string",
            minLength: 1,
            description: "Required when content_url is omitted. Numeric Confluence content ID, or a\nConfluence tiny link key (the encoded part\nfrom /wiki/x/ URLs, e.g. 4_sXAQ). Recognized Confluence content URLs are also\naccepted and converted to the content ID, but prefer content_url for URLs.\nOne of content_id or content_url is required.\n",
          },
          content_url: {
            type: "string",
            minLength: 1,
            description: "Required when content_id is omitted. Full URL of the Confluence content.\nSupported: pages/live docs\n(/pages/{id}), blog URLs (/blog/{id}), whiteboards\n(/whiteboard/{id}), databases (/database/{id}), folders (/folder/{id}),\nembeds (/embed/{id}), and TinyUrl (/wiki/x/{key}). Prefer this for URLs copied from Confluence.\nOne of content_id or content_url is required.\n",
          },
          detail: {
            type: "string",
            enum: [
              "summary",
              "ai_summary",
              "outline",
              "full",
            ],
            description: "Response shape for document-style reads. summary = title + excerpt + counts\n(default, cheap). ai_summary = the generated AI summary when available, otherwise\nnull; it does not fall back to the standard excerpt. outline = heading tree (cheap,\nfor navigation). full = body in the requested format (use when intending to edit).\nNon-document content such as whiteboards, databases, folders, and embeds does not support detail;\ncontent_format is a separate representation selector for\nformats such as whiteboard svg/png, database csv, or embed url.\n",
          },
          content_format: {
            type: "string",
            enum: [
              "html",
              "markdown",
              "url",
              "svg",
              "png",
              "csv",
            ],
            description: "Body format. Doc types: html (default) or markdown. Document HTML can contain\nsupported macro wrappers instead of content displayed in Confluence web. When\nvisible macro content is required, use resolveConfluenceContentMacros with the\nreturned numeric content ID and all=true; use discover if its full contract is\nneeded. Whiteboards support only svg and png: use svg to inspect content or\nprepare edits, or png for a screenshot. Never use html or markdown for a\nwhiteboard. PNG is read-only and returns a short-lived presigned URL in\nbody.value, not the image content. Databases: csv.\nURL-backed content such as embeds: url. For an embed or Smart Link, including a\nSmart Folder child, explicitly request content_format=url and omit detail to read\nthe destination URL in body.value. Then follow retrievalGuidance to read the target.\nOmitting content_format preserves the existing envelope-only embed read.\n",
          },
          draft: {
            type: "boolean",
            description: "If true, read the draft version instead of current. Only supported for\npages and blog posts.\n",
          },
        },
        required: [
          "cloudId",
        ],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    readTool(
      "search_confluence",
      "searchConfluence",
      "Search Confluence content with CQL.",
      {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          cql: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
            description: "CQL query string (max 4096 chars). Examples:\n`type = page AND space = \"DEV\"`,\n`title ~ \"onboarding\" AND lastmodified > \"2025-01-01\"`,\n`creator = currentUser() AND type IN (page, blogpost) ORDER BY lastmodified DESC`.\n",
          },
          cqlcontext: {
            type: "string",
            description: "JSON-encoded execution context, e.g. {\"spaceKey\":\"DEV\"}. Restricts the search to the supplied scope.",
          },
          expand: {
            type: "string",
            description: "Comma-separated list of content properties to expand on each result.\nCommon values: `space`, `version`, `body.view`, `metadata.labels`,\n`ancestors`. Use sparingly to avoid large responses.\n",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Max number of results to return per page (1-100). Defaults to 25.",
          },
          cursor: {
            type: "string",
            description: "Opaque pagination cursor returned by a previous call. Omit to start from the first page.",
          },
        },
        required: [
          "cloudId",
          "cql",
        ],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    readTool(
      "get_jira_issue",
      "getJiraIssue",
      "Read one Jira or Jira Service Management issue by key or id.",
      {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          issueIdOrKey: {
            type: "string",
            description: "Issue key (PROJ-123), numeric ID, or a Jira issue URL",
          },
          fields: {
            type: "array",
            items: {},
            description: "Custom Jira field IDs to fetch (e.g. [\"customfield_10010\", \"customfield_10020\"]). Overrides the view's fetch strategy. For custom fields in normal use, prefer view: \"evidence\", which fetches and maps them automatically. Use [\"*all\"] to fetch every field (expensive — prefer view: \"full\" instead).\n",
          },
          includeEditableFields: {
            type: "boolean",
            description: "When true, also return compact metadata for fields the authenticated user can edit on this issue, including type, allowed values, and operations. Omit unless preparing an edit: this makes an extra Jira REST call.\n",
          },
          fieldsByKeys: {
            type: "boolean",
            description: "When true, each entry in `fields` is interpreted as a Jira field key (e.g. \"summary\", \"description\") instead of a field id. Matches the Jira REST `fieldsByKeys` query parameter. Ignored when `fields` is omitted (default field list uses ids).\n",
          },
          expand: {
            type: "string",
            description: "Additional Jira expand tokens (comma-separated), e.g. \"renderedFields,changelog\". Merged with any expand the server adds for custom-field mapping (e.g. \"names\"); duplicate tokens removed. Note \"changelog\" here returns only the newest page, sorted newest-first, and it accepts startAt/maxResults then ignores them — so it cannot be paged and reports a longer history as complete. Use listJiraIssueChangelogs to read all of it (oldest-first); do not mix their orderings.\n",
          },
          properties: {
            type: "array",
            items: {},
            description: "Issue entity property keys to return (Jira `properties` query param, repeated per key). Omit unless you rely on app-specific issue properties.\n",
          },
          failFast: {
            type: "boolean",
            description: "When true, forwards Jira's `failFast` query flag for this GET. Omit for Jira default behavior.\n",
          },
          responseContentFormat: {
            type: "string",
            enum: [
              "markdown",
              "html",
            ],
            description: "Format for rich-text bodies — description and environment, plus any comment bodies the view returns. Defaults to markdown. Set html to receive HTML, which is lossless, so you can pass it straight back to editJiraIssue/addOrEditJiraIssueComment with contentFormat: html. Bodies holding anything markdown cannot represent — inline media, panels, expands, layouts, statuses, @mentions, dates, emoji — are returned as HTML automatically, because markdown would drop those nodes or turn them into literal text on write-back. An explicit markdown request is overridden for those bodies, with a warning saying so; appliedContentFormat in the response reports the format you actually got.\n",
          },
          actionSource: {
            type: "string",
            enum: [
              "jira_mcp_card",
              "model_tool_call",
            ],
            description: "Optional invocation attribution. Jira MCP cards set jira_mcp_card; omit for model/tool-loop calls.",
          },
          view: {
            type: "string",
            enum: [
              "compact",
              "evidence",
              "full",
            ],
            description: "Output view preset. Default: \"compact\". Options: \"compact\", \"evidence\", \"full\". compact = minimal fields for scanning; evidence = decision-relevant detail; full = complete response.",
          },
        },
        required: [
          "cloudId",
          "issueIdOrKey",
        ],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    readTool(
      "search_jira_issues_using_jql",
      "searchJiraIssuesUsingJql",
      "Search Jira issues with JQL.",
      {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          jql: {
            type: "string",
            description: "JQL query string e.g. \"project = PROJ AND status = 'In Progress'\". If the tool returns a repairHint, follow it and retry.\n",
          },
          searchResultMode: {
            type: "string",
            enum: [
              "issues",
              "count",
              "all",
            ],
            description: "Default \"issues\". Never count for normal search or if nextPageToken used. If total for same query is known, reuse it. Use \"count\" only when no trusted count exists and either the user asks or a downstream step needs it. Use \"all\" only if both count and issues required.\n",
          },
          maxResults: {
            type: "number",
            description: "Maximum results to return (default 50, max 100)",
          },
          fields: {
            type: "array",
            items: {},
            description: "Fields per issue (e.g. [\"summary\", \"status\", \"customfield_10010\"]). customfield_* IDs are site-specific — discover the correct id for story points etc. on this Cloud site. Honoured exactly when supplied. Values map to issues[].fields.customFields (human labels), not raw customfield_* keys. The default \"compact\" view omits custom fields; use view: \"evidence\" for velocity/sprint JQL (fetches and maps all custom fields) or pass explicit customfield_* IDs.\n",
          },
          nextPageToken: {
            type: "string",
            description: "Pagination token from a previous response to fetch the next page",
          },
          responseContentFormat: {
            type: "string",
            enum: [
              "markdown",
              "html",
            ],
            description: "Format for rich-text bodies (description, environment, comments) when the view returns them. Defaults to markdown; html is lossless for a later editJiraIssue. Issues holding anything markdown cannot represent (media, panels, expands, statuses, @mentions) are returned as HTML automatically, decided per issue. An explicit markdown request is overridden for those bodies, with a warning saying so; appliedContentFormat in the response reports the format you actually got.\n",
          },
          actionSource: {
            type: "string",
            enum: [
              "jira_mcp_card",
              "model_tool_call",
            ],
            description: "Optional invocation attribution. Jira MCP cards set jira_mcp_card; omit for model/tool-loop calls.",
          },
          view: {
            type: "string",
            enum: [
              "compact",
              "evidence",
              "full",
            ],
            description: "Output view preset. Default: \"compact\". Options: \"compact\", \"evidence\", \"full\". compact = minimal fields for scanning; evidence = decision-relevant detail; full = complete response.",
          },
        },
        required: [
          "cloudId",
          "jql",
        ],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    writeTool(
      "update_confluence_content",
      "updateConfluenceContent",
      "Update a Confluence page, live doc, blog post, whiteboard or database by id or URL; ownerId can hand a page to another account.",
      {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          contentId: {
            type: "string",
            description: "Numeric Confluence content ID. One of contentId or contentUrl is required.\n",
          },
          contentUrl: {
            type: "string",
            description: "Full URL of the Confluence content. One of contentId or contentUrl is required.\nClear Confluence URLs for pages/live docs (/pages/{id}), blogs\n(/blog/{id}), whiteboards (/whiteboard/{id}), databases\n(/database/{id}), and folders (/folder/{id}) are normalized to their\nnumeric content ID before the update is sent, so URLs copied from the\nproduct should work directly.\n",
          },
          snapshotToken: {
            type: "string",
            description: "Opaque token from a prior getConfluenceContent response. Required for doc-type\nupdates that mutate page/blog/live_doc content or contentWidth. Not used for whiteboard svg or\ndatabase csv object updates.\n",
          },
          title: {
            type: "string",
            description: "New title for the content. 1-255 characters. Omit to keep existing title.",
          },
          body: {
            type: "object",
            additionalProperties: {},
            description: "Before composing this body, follow the space-instruction decision rule in the tool\ndescription. Reuse known instruction state and do not repeat the space lookup per write.\nBody update object with format and value. Doc types accept format html or\nmarkdown. Markdown is for simple text; when richer structure would improve the\ndocument, re-read it as HTML and preserve existing rich content in the HTML update.\nWhiteboards accept format svg and should include\ncontext.content with the current SVG when applying a patch. Databases\naccept format csv and should include context.content with the current\nCSV when applying an edit envelope. Put the raw patch/envelope directly in\nvalue; do not wrap it in an extra JSON object or {\"content\": \"...\"}\nwrapper. For whiteboards, value is a patch, not a full SVG replacement.\nFor databases, value is an edit envelope, not a create payload. Mutually\nexclusive with edits.\n",
          },
          edits: {
            type: "array",
            items: {},
            description: "Granular edit operations. Array of tool-call objects, each with name\n(replaceNode, insertNodeAfter, insertNodeBefore, deleteNode, removeNodes,\nmoveNode, appendNodeToEnd, setAttrs), localId, value, and arguments.\nMutually exclusive with body.\n",
          },
          dryRun: {
            type: "boolean",
            description: "If true, validate and preview the result without persisting. For edits,\nreturns the resulting HTML. For body replacement, echoes the input.\n",
          },
          draft: {
            type: "boolean",
            description: "If true, update the draft version instead of current. Only supported\nfor page and blogpost doc edits.\n",
          },
          versionMessage: {
            type: "string",
            description: "Optional version comment/message for the content update.",
          },
          minorEdit: {
            type: "boolean",
            description: "Whether to mark the new content version as a minor edit.",
          },
          ownerId: {
            type: "string",
            description: "Atlassian account ID of the new owner to transfer page ownership to. Optional.\nThis is an account ID (e.g. 5b10ac8d82e05b22cc7d4ef5), never an email/username\nor a content ID. The new owner must already have edit permission.\n",
          },
          contentWidth: {
            type: "string",
            enum: [
              "narrow",
              "wide",
              "max",
            ],
            description: "Optional page width for doc types only: page, live_doc, and blogpost.\nAccepted values are narrow, wide, and max. The default width is narrow.\nOmit to keep the existing content width unchanged.\nA width-only update is valid and requires snapshotToken, but does not\nrequire title, body, or edits.\nNon-doc content types do not support this field.\n",
          },
        },
        required: [
          "cloudId",
        ],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    writeTool(
      "create_jira_issue",
      "createJiraIssue",
      "Create an issue in a Jira project.",
      {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          projectKey: {
            type: "string",
            description: "Project key (e.g. PROJ).",
          },
          summary: {
            type: "string",
            description: "Issue summary / title.",
          },
          issueType: {
            type: "string",
            description: "Issue type name (e.g. Bug, Task, Story, Epic). Use listJiraProjectIssueTypesMetadata to list valid types for this project if unsure.\n",
          },
          description: {
            type: "string",
            description: "Issue description in markdown, or HTML with contentFormat html. Converted to Jira ADF automatically.",
          },
          contentFormat: {
            type: "string",
            enum: [
              "markdown",
              "html",
            ],
            description: "Body format for description. Defaults to markdown; html adds panels, tables and status lozenges. For HTML body shapes, first get the format guide via the generic operation runner (execute) as name=getContentFormatGuide, inputs={toolName: \"createJiraIssue\"}. Inline media needs an existing issue: create first, then embed with editJiraIssue. When the HTML content-format feature is disabled the call is rejected rather than downgraded, because markdown would store the HTML tags as literal text.\n",
          },
          priority: {
            type: "string",
            description: "Priority name (e.g. High, Medium, Low, Highest, Lowest).",
          },
          assignee: {
            type: "string",
            description: "Account ID of the assignee. Resolve a name with listJiraIssueAssignableUsers, which returns only users who can be assigned in this project; lookupJiraAccountId resolves any user and does not check that.",
          },
          labels: {
            type: "array",
            items: {},
            description: "List of label strings (e.g. [\"bug\", \"needs-triage\"]).",
          },
          parent: {
            type: "string",
            description: "Parent issue key for sub-tasks or child issues (e.g. PROJ-10).",
          },
          additional_fields: {
            type: "object",
            additionalProperties: {},
            description: "Additional Jira fields. Keys can be human-readable field names or raw customfield_* IDs. Values can be human-readable (resolved automatically) or already-correct Jira shapes. Examples:\n  {\"Story Points\": 8}                          ← number field by name\n  {\"Team\": \"Backend\"}                          ← option/select by name\n  {\"Reviewers\": [\"alice@acme.com\", \"bob@acme.com\"]}  ← multi-user by accountId\n  {\"Component Area\": \"Platform / Auth\"}        ← cascading select as \"Parent / Child\"\n  {\"customfield_10010\": 8}                     ← raw ID (no resolution needed, fastest)\n  {\"components\": [{\"name\": \"Backend\"}]}        ← system array field (raw shape)\n  {\"fixVersions\": [{\"name\": \"v2.0\"}]}          ← system array field (raw shape)\nOn error, the response includes allowedValues and a repairHint for self-correction.\n",
          },
          assignToSprint: {
            type: "string",
            description: "Optional sprint assignment after the issue is created. Accepts a numeric sprint ID, an exact sprint name, or \"active\" to resolve an active sprint. Numeric sprint IDs assign directly and do not need board lookup. When omitted, createJiraIssue behaves exactly as before and does not make sprint calls.\n",
          },
        },
        required: [
          "cloudId",
          "projectKey",
          "summary",
          "issueType",
        ],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    writeTool(
      "edit_jira_issue",
      "editJiraIssue",
      "Edit a Jira issue by key or id.",
      {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          issueIdOrKey: {
            type: "string",
            description: "Issue key (e.g. PROJ-123).",
          },
          fields: {
            type: "object",
            additionalProperties: {},
            description: "Jira fields payload to set, keyed by field name or customfield_* ID. To clear a field, pass explicit null (e.g. {\"resolution\": null}). Rich-text fields (description/environment) default to markdown; set contentFormat: html to author them in HTML. Editing a body that already contains inline media must use contentFormat: html — markdown drops it. For HTML body shapes (inline media, panels, tables), first get the format guide via the generic operation runner (execute) as name=getContentFormatGuide, inputs={toolName: \"editJiraIssue\"}.\n",
          },
          additional_fields: {
            type: "object",
            additionalProperties: {},
            description: "Additional Jira fields. Keys can be human-readable field names or raw customfield_* IDs. Values can be human-readable (resolved automatically) or already-correct Jira shapes. Examples:\n  {\"Story Points\": 8}                          ← number field by name\n  {\"Team\": \"Backend\"}                          ← option/select by name\n  {\"Reviewers\": [\"alice@acme.com\", \"bob@acme.com\"]}  ← multi-user by accountId\n  {\"Component Area\": \"Platform / Auth\"}        ← cascading select as \"Parent / Child\"\n  {\"customfield_10010\": 8}                     ← raw ID (no resolution needed, fastest)\n  {\"components\": [{\"name\": \"Backend\"}]}        ← system array field (raw shape)\n  {\"fixVersions\": [{\"name\": \"v2.0\"}]}          ← system array field (raw shape)\nOn error, the response includes allowedValues and a repairHint for self-correction.\n",
          },
          inlineFileId: {
            type: "array",
            items: {},
            description: "Media file ID(s) from uploadAttachmentToJiraIssue to append inline to the description, e.g. [\"id1\",\"id2\"]. Requires contentFormat: html and a matching inlineFileCollection (paired by index). Appends at the end, keeping existing content; for exact placement, author the media node in the HTML description instead. A file already embedded in the body is rejected (would duplicate).\n",
          },
          inlineFileCollection: {
            type: "array",
            items: {},
            description: "Media collection(s) from the upload step, paired to inlineFileId by index (a single value applies to all). Required whenever inlineFileId is set.\n",
          },
          inlineFileName: {
            type: "array",
            items: {},
            description: "Optional file name(s) (from the upload step's fileName), paired to inlineFileId by index. Only selects the render shape: images render as a block image, other files as an inline chip. Omit to default to the image shape.\n",
          },
          contentFormat: {
            type: "string",
            enum: [
              "markdown",
              "html",
            ],
            description: "Body format for rich-text fields (description/environment). Defaults to markdown. html preserves inline media across a read-modify-write; a body fetched as HTML can be written straight back (Jira resolves media collection/filename server-side and omits them on read — not data loss). Requires the HTML content-format feature; when it is disabled the call is rejected rather than downgraded, because markdown would store the HTML tags as literal text and drop the media.\n",
          },
          responseContentFormat: {
            type: "string",
            enum: [
              "markdown",
              "html",
            ],
            description: "Output format for rich-text fields in the returned issue. Defaults to markdown. Bodies markdown cannot represent (media, panels, expands, statuses, @mentions) are always returned as HTML, so a follow-up edit does not destroy them. An explicit markdown request is overridden for those bodies, with a warning saying so; appliedContentFormat in the response reports the format you actually got.\n",
          },
          rankBeforeIssue: {
            type: "string",
            description: "Optional. Rank this issue immediately before the given issue key or ID (LexoRank relative anchor). Mutually exclusive with rankAfterIssue. When omitted, editJiraIssue does not make ranking calls.\n",
          },
          rankAfterIssue: {
            type: "string",
            description: "Optional. Rank this issue immediately after the given issue key or ID (LexoRank relative anchor). Mutually exclusive with rankBeforeIssue. When omitted, editJiraIssue does not make ranking calls.\n",
          },
          rankCustomFieldId: {
            type: "integer",
            minimum: 1,
            description: "Optional. Numeric Rank field id for this rank call (e.g. 10020). Pass only when the user explicitly provides a Rank field id, or asks to reorder on a specific board's Rank field. For a named board, call getJiraBoardConfig first and use ranking.rankCustomFieldId. Do not invent or guess this id. Omit for ordinary reorders so Jira uses its default Rank field. Ignored unless rankBeforeIssue or rankAfterIssue is also set.\n",
          },
          actionSource: {
            type: "string",
            enum: [
              "jira_mcp_card",
              "model_tool_call",
            ],
            description: "Optional invocation attribution. Jira MCP cards set jira_mcp_card; omit for model/tool-loop calls.",
          },
        },
        required: [
          "cloudId",
          "issueIdOrKey",
        ],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    writeTool(
      "transition_jira_issue",
      "transitionJiraIssue",
      "Move a Jira issue through a workflow transition.",
      {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          issueIdOrKey: {
            type: "string",
            description: "Issue key like PROJ-123",
          },
          transitionId: {
            type: "string",
            description: "Transition ID (get from listJiraIssueTransitions). Provide either transitionId or transitionName.",
          },
          transitionName: {
            type: "string",
            description: "Name of the transition itself, not the target status — the two often differ, so \"Done\" does not match a transition named \"Review->Done\". Provide either transitionId or transitionName.",
          },
          fields: {
            type: "object",
            additionalProperties: {},
            description: "Optional Jira field values to apply during the workflow transition.",
          },
          update: {
            type: "object",
            additionalProperties: {},
            description: "Optional Jira field update operations to apply during the workflow transition. A comment passed here may be dropped without error — the transition reports success and no comment is created. Use addOrEditJiraIssueComment instead.",
          },
          historyMetadata: {
            type: "object",
            additionalProperties: {},
            description: "Optional issue history metadata to attach to the workflow transition.",
          },
          sprintId: {
            type: "integer",
            minimum: 1,
            description: "Assign the issue into this sprint. Mutually exclusive with assignToBacklog.",
          },
          assignToBacklog: {
            type: "boolean",
            description: "Set true to assign the issue to the backlog, mutually exclusive with sprintId. Optionally use boardId to target a specific board's backlog.",
          },
          boardId: {
            type: "integer",
            minimum: 1,
            description: "Only used when assignToBacklog is true: targets this specific board's backlog (board IDs from listJiraBoards). Ignored otherwise.",
          },
          actionSource: {
            type: "string",
            enum: [
              "jira_mcp_card",
              "model_tool_call",
            ],
            description: "Optional invocation attribution. Jira MCP cards set jira_mcp_card; omit for model/tool-loop calls.",
          },
        },
        required: [
          "cloudId",
          "issueIdOrKey",
        ],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    ),
    writeTool(
      "add_or_edit_jira_issue_comment",
      "addOrEditJiraIssueComment",
      "Add or edit a Jira issue comment. On a Jira Service Management request, it is customer-visible unless jsmCommentType is internalNote; group or role restrictions do not make it internal. Editing replaces the whole comment body, and Jira keeps no earlier version.",
      {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Site UUID or Jira/Confluence URL for this operation's Atlassian site. cloudId is never silently auto-resolved or reused for you — call getAccessibleAtlassianResources ONCE per session, cache the returned cloudId, and pass it explicitly on this and every subsequent call, since most operations need it. `execute` and its read/write/destructive variants strictly require it for cloudId-scoped operations and fail without it. Not needed for cloudId-less operations (e.g. Bitbucket), which ignore this field.",
          },
          issueIdOrKey: {
            type: "string",
            description: "Issue key (e.g. PROJ-123) or a Jira issue URL",
          },
          commentBody: {
            type: "string",
            description: "Comment text. Markdown by default; set contentFormat: html to pass HTML instead. Required unless adding a new comment purely to embed a file via inlineFileId. Editing replaces the whole comment body: pass the full intended text (fetch the current comment first to preserve it), or \"\" for media only. Editing a body that already contains inline media must use contentFormat: html — markdown drops it. For HTML body shapes (inline media, panels, tables), first get the format guide via the generic operation runner (execute) as name=getContentFormatGuide, inputs={toolName: \"addOrEditJiraIssueComment\"}.\n",
          },
          contentFormat: {
            type: "string",
            enum: [
              "markdown",
              "html",
            ],
            description: "Body format for commentBody. Defaults to markdown. html preserves inline media across a read-modify-write; a body fetched as HTML can be written straight back (Jira resolves media collection/filename server-side and omits them on read — not data loss). Requires the HTML content-format feature; when it is disabled the call is rejected rather than downgraded, because markdown would store the HTML tags as literal text and drop the media.\n",
          },
          commentVisibility: {
            type: "object",
            additionalProperties: {},
            description: "Restrict comment visibility to a Jira group or role. Shape: `{\"type\":\"group\"|\"role\",\"value\":\"<name>\"}`.\nRole and group names are site-specific, so do not reuse a name from another site.\nOn JSM this does not make a comment internal — a restricted comment stays customer-visible\n(`jsdPublic: true`). Use `jsmCommentType: \"internalNote\"` for that.\n",
          },
          jsmCommentType: {
            type: "string",
            enum: [
              "internalNote",
              "publicComment",
            ],
            description: "JSM comment type. Use internalNote for an internal note or publicComment for a customer-visible comment. Applies when adding or editing a JSM comment. Omit for existing Jira behavior.\n",
          },
          commentId: {
            type: "string",
            description: "ID of an existing comment to edit. When omitted, a new comment is added.",
          },
          inlineFileId: {
            type: "array",
            items: {},
            description: "Media file ID(s) from uploadAttachmentToJiraIssue to append inline to the comment, e.g. [\"id1\",\"id2\"]. Requires contentFormat: html and a matching inlineFileCollection (paired by index). Appends at the end; for exact placement, author the media node in the HTML commentBody instead. A file already embedded in the body is rejected (would duplicate).\n",
          },
          inlineFileCollection: {
            type: "array",
            items: {},
            description: "Media collection(s) from the upload step, paired to inlineFileId by index (a single value applies to all). Required whenever inlineFileId is set.\n",
          },
          inlineFileName: {
            type: "array",
            items: {},
            description: "Optional file name(s) (from the upload step's fileName), paired to inlineFileId by index. Only selects the render shape: images render as a block image, other files as an inline chip. Omit to default to the image shape.\n",
          },
          responseContentFormat: {
            type: "string",
            enum: [
              "markdown",
              "html",
            ],
            description: "Format of the echoed comment body. Defaults to the format written, so an html write reads back as html. Bodies markdown cannot represent (media, panels, statuses, @mentions) are always echoed as HTML so a follow-up edit does not destroy them. An explicit markdown request is overridden for those bodies, with a warning saying so; appliedContentFormat in the response reports the format you actually got.\n",
          },
        },
        required: [
          "cloudId",
          "issueIdOrKey",
        ],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      true,
    ),
  ],
};
