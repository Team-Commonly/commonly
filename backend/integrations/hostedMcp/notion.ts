/**
 * Notion hosted MCP entry (TASK-240). Schemas and annotations are pinned from
 * connector-ops's consenting 2026-10-19 tools/list capture.
 *
 * The 24-tool pin follows Wren's PR-thread ruling: Notion workspace tools only.
 * Agent-session, skill-transfer, attachment, connected-source search, and
 * tool-access catalogue calls are excluded. create-pages and update-page can
 * still mark a page as a skill via is_skill, with member approval.
 * Destructive writes, moves, and update-view keep the irreversible floor;
 * update-view can clear shared filters and sorts without a view-specific undo.
 * The 22 tools added since the 10-01 capture remain excluded: eight Calendar
 * tools reach connected accounts outside Notion; get/update-enabled-skills
 * lead into skill transfer or change instructions available to other agents;
 * memory-search, get-file-download-urls, delete/restore-pages and databases,
 * comment mutations and reactions, get-groups, list-page-backlinks, and
 * get-self are not needed for this entry. A new tool joins only by ruling.
 */
import type { HostedMcpEntry, HostedMcpPinnedTool } from '../../services/hostedMcpEntryService';

const pin = (
  upstreamName: string,
  description: string,
  toolClass: 'read' | 'write',
  inputSchema: Record<string, unknown>,
  annotations: { readOnlyHint: boolean; destructiveHint: boolean },
  irreversible = false,
): HostedMcpPinnedTool => ({
  name: upstreamName.replace(/-/g, '_'),
  upstreamName,
  description,
  class: toolClass,
  inputSchema,
  annotations,
  ...(irreversible ? { irreversible: true } : {}),
});

export const NOTION_ENTRY: HostedMcpEntry = {
  id: 'notion',
  title: 'Notion',
  description: 'Pages, comments and databases in your Notion workspace.',
  resource: 'https://mcp.notion.com/mcp',
  issuer: 'https://mcp.notion.com',
  client: 'cimd',
  scopes: ['default'],
  revoke: {
    page: 'https://www.notion.so/settings',
    endpoint: 'https://mcp.notion.com/token',
  },
  tools: [
    pin(
      "notion-search",
      "Search pages and databases in the connected Notion workspace.",
      'read',
      {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Short, specific keywords for Notion content search. For user search, enter a name or email address. Provide a non-empty query unless intentionally browsing with filters or a non-relevance sort.",
          },
          query_type: {
            description: "Specify type of the query as either \"internal\" or \"user\". Always include this input if performing \"user\" search.",
            type: "string",
            enum: [
              "internal",
              "user",
            ],
          },
          data_source_url: {
            description: "Optionally restrict keyword search to a data source URL returned in a <data-source> tag.",
            type: "string",
          },
          page_url: {
            description: "Optionally restrict keyword search to a page and its descendants. Accepts a Notion page URL or ID.",
            type: "string",
          },
          teamspace_id: {
            description: "Optionally, provide the ID of a teamspace to restrict search results to. This will perform a search over content within the specified teamspace only. Accepts the teamspace ID (UUIDv4) with or without dashes.",
            type: "string",
          },
          filters: {
            description: "Optional exact filters for Notion workspace search. Omit unless required by the request. Keep filter fields nested here; do not send them at the top level. Some filters require Business access.",
            type: "object",
            properties: {
              created_date_range: {
                description: "Optional filter to only produce search results created within the specified date range.",
                type: "object",
                properties: {
                  start_date: {
                    description: "The start date of the date range as an ISO 8601 date string, if any.",
                    type: "string",
                    format: "date",
                    pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                  },
                  end_date: {
                    description: "The end date of the date range as an ISO 8601 date string, if any.",
                    type: "string",
                    format: "date",
                    pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                  },
                },
                additionalProperties: false,
              },
              created_by_user_ids: {
                description: "Optional filter to only produce search results created by the Notion users that have the specified user IDs. Use \"me\" for the connected user.",
                maxItems: 100,
                type: "array",
                items: {
                  type: "string",
                },
              },
              edited_by_user_ids: {
                description: "Optional filter to only produce search results edited by the Notion users that have the specified user IDs. Use \"me\" for the connected user. Available on the Business plan.",
                maxItems: 100,
                type: "array",
                items: {
                  type: "string",
                },
              },
              last_edited_date_range: {
                description: "Optional filter to only produce search results last edited within the specified date range. Available on the Business plan.",
                type: "object",
                properties: {
                  start_date: {
                    description: "The start date of the date range as an ISO 8601 date string, if any.",
                    type: "string",
                    format: "date",
                    pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                  },
                  end_date: {
                    description: "The end date of the date range as an ISO 8601 date string, if any.",
                    type: "string",
                    format: "date",
                    pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                  },
                },
                additionalProperties: false,
              },
              teamspace_ids: {
                description: "Optional filter to only produce search results inside one of the specified teamspaces. Selecting more than one teamspace is available on the Business plan; use teamspace_id for one teamspace on other plans.",
                maxItems: 100,
                type: "array",
                items: {
                  type: "string",
                },
              },
              title_only: {
                description: "When true, match the query only against page and database titles instead of page content. Available on the Business plan.",
                type: "boolean",
              },
              content_status: {
                description: "Which pages to include by status. Omit for the default live pages. Supplying this field, even with the default value, requires Business access.",
                type: "string",
                enum: [
                  "all_with_archived",
                  "all_without_archived",
                  "verified_only",
                  "archived_only",
                ],
              },
            },
            additionalProperties: {},
          },
          sort: {
            description: "Result ordering for Notion workspace search. Omit for the default \"relevance\" ordering. \"last_edited\" and \"created\" require Business access.",
            type: "string",
            enum: [
              "relevance",
              "last_edited",
              "created",
            ],
          },
          page_size: {
            description: "Maximum number of results to return (default 10). Lower values reduce response size.",
            type: "integer",
            minimum: 1,
            maximum: 50,
          },
          max_highlight_length: {
            description: "Maximum character length for result highlights (default 200). Set to 0 to omit highlights entirely.",
            type: "integer",
            minimum: 0,
            maximum: 500,
          },
        },
        required: [
          "query",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-fetch",
      "Read one Notion page, database, data source or saved view, or the connected user's memory with id: memory. include_file_urls can return short-lived signed URLs for files on that record.",
      'read',
      {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID or URL of the Notion page, database, or data source to fetch. Supports notion.so URLs, Notion Sites URLs (*.notion.site), raw UUIDs, and data source URLs (collection://...). Pass \"memory\" to fetch the connected user's About page and memory database in this workspace without creating them. Pass a notion://docs/* URI to read that documentation resource. Also accepts an explicit saved view URL (view://...) from a database response. If a database block ID returns a validation error, use the collection:// URL from that error. Example: <example>notion://docs/enhanced-markdown-spec</example>.",
          },
          include_transcript: {
            description: "Whether to include meeting note transcripts. Defaults to false. When true, full transcripts are included; when false, a placeholder with the meeting note URL is shown instead.",
            type: "boolean",
          },
          include_discussions: {
            description: "Whether to include discussion/comment indicators in the page output. When true, adds a <page-discussions> summary with discussion count, preview snippets, and discussion:// URLs. Use with the get_comments tool to retrieve full discussion content. Defaults to false.",
            type: "boolean",
          },
          include_file_urls: {
            description: "Whether to return signed download URLs for uploaded files. Defaults to false. When false, page Markdown cites uploaded files by stable notion-file-block:// references and the response has no references map; call get_file_download_urls with the references when you need those files' contents. When true, the response's references map gives the signed URL for each reference.",
            type: "boolean",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-create-pages",
      "Create pages in the connected Notion workspace, including top-level teamspace pages. parent: memory saves a memory that the member's connected agents can read in later sessions.",
      'write',
      {
        type: "object",
        properties: {
          pages: {
            description: "The pages to create.",
            maxItems: 100,
            type: "array",
            items: {
              type: "object",
              properties: {
                properties: {
                  description: "The properties of the new page, which is a JSON map of property names to SQLite values.\nFor pages in a database, use the SQLite schema definition shown in <database>.\nFor pages outside of a database, the only allowed property is \"title\", which is the title of the page and is automatically shown at the top of the page as a large heading.\n**IMPORTANT**: Some property types require specific formats:\n- Date properties: Split into \"date:{property}:start\", \"date:{property}:end\" (optional), and \"date:{property}:is_datetime\" (0 or 1)\n- Place properties: Split into \"place:{property}:name\", \"place:{property}:address\", \"place:{property}:latitude\", \"place:{property}:longitude\", and \"place:{property}:google_place_id\" (optional)\n- Number properties: Use JavaScript numbers (not strings)\n- Checkbox properties: Use \"__YES__\" for checked, \"__NO__\" for unchecked\n- Relation properties: Use an array of related page URLs or page IDs, e.g. [\"https://www.notion.so/26ab1f9f4c5f80b18d3bd10a6b1d2f4e\", \"26ab1f9f-4c5f-80b1-8d3b-d10a6b1d2f4e\"]\n- Person properties: Use an array of user IDs, user or agent URLs, or group references copied from fetch output (\"space_permission_group-<UUID>\"). Bare group UUIDs are also supported.\n- Files properties: Use a JSON array of file IDs, Notion Folder URLs, and/or <folder> tags copied from fetch output. Folders are stored as native Folder references, not ordinary links.\n\n\n**Special property naming**: Properties named \"id\" or \"url\" (case insensitive) must be prefixed with \"userDefined:\" (e.g., \"userDefined:URL\", \"userDefined:id\")",
                  type: "object",
                  propertyNames: {
                    type: "string",
                  },
                  additionalProperties: {
                    anyOf: [
                      {
                        type: "string",
                      },
                      {
                        type: "number",
                      },
                      {
                        maxItems: 100,
                        type: "array",
                        items: {
                          type: "string",
                        },
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                },
                content: {
                  description: "The content of the new page, using Notion Markdown. For people and dates, use user and date mentions rather than plain text; notion://docs/enhanced-markdown-spec gives the syntax.",
                  type: "string",
                },
                template_id: {
                  description: "The ID of a template to apply to this page. When specified, do not provide 'content' as the template will provide it. Properties can still be set alongside the template. Get template IDs from the <templates> section in the fetch tool results. Template application is asynchronous: the page starts blank and content appears shortly after.",
                  type: "string",
                },
                icon: {
                  description: "An emoji character (e.g. \"🚀\"), a custom emoji by name (e.g. \":rocket_ship:\"), a Notion icon identifier as returned by fetch (e.g. \"icons/pizza_blue\"), or an external image URL. Use \"none\" to explicitly set no icon. Omit to leave unchanged. Keep the title free of a duplicate leading emoji because the icon renders separately.",
                  type: "string",
                },
                cover: {
                  description: "An external image URL for the page cover. Use \"none\" to explicitly set no cover. Omit to leave unchanged.",
                  type: "string",
                },
                is_skill: {
                  description: "Set to true only when the user asks for reusable instructions or a repeatable workflow. Do not mark ordinary reference pages, one-time documents, or drafts as skills. Before creating a skill, read the MCP resource `notion://docs/skills` through your MCP client's resource-reading interface. If your client does not support reading MCP resources, call the Notion \"fetch\" tool with this URI instead. Do NOT pass this URI to any other URL-fetching tool. False has the same effect as omitting the field.",
                  type: "boolean",
                },
                preserve_internal_links: {
                  description: "Preserve internal Markdown links instead of converting them to native mentions.",
                  type: "boolean",
                },
              },
              additionalProperties: false,
            },
          },
          creation_mode: {
            description: "If the user explicitly names a private or shared destination, omit \"creation_mode\" and use that parent. Otherwise, use \"draft\" when the user clearly wants a durable page but has not named a destination. Prefer this explicit draft mode over omitting the parent. Draft mode is server-enforced: it creates a private workspace-level page and cannot be combined with \"parent\". Create it without first asking where it should live. After creation, tell the user it is private and offer to move it once they name a destination.",
            type: "string",
            enum: [
              "draft",
            ],
          },
          parent: {
            description: "All pages in one call share this parent. Pass \"memory\" to save a personal memory; see notion://docs/memory. Otherwise use a page (page_id), database page (database_id), data source (data_source_id), or teamspace root (teamspace_id, from get_teams). Teamspace roots require a user-backed connection and permission to add top-level pages. A database_id cannot be used when the database has more than one data source; fetch it and use the right collection:// URL as data_source_id. If omitted, pages are private at the workspace level. When no destination is named, prefer explicit \"creation_mode\": \"draft\" over omitting the parent.",
            anyOf: [
              {
                type: "string",
                enum: [
                  "memory",
                ],
                description: "Always `memory`",
              },
              {
                type: "object",
                properties: {
                  page_id: {
                    type: "string",
                    description: "The ID of the parent page (with or without dashes), for example, 195de9221179449fab8075a27c979105",
                  },
                  type: {
                    description: "Always `page_id`",
                    type: "string",
                    enum: [
                      "page_id",
                    ],
                  },
                },
                required: [
                  "page_id",
                ],
                additionalProperties: {},
              },
              {
                type: "object",
                properties: {
                  database_id: {
                    type: "string",
                    description: "The ID of the parent database (with or without dashes), for example, 195de9221179449fab8075a27c979105",
                  },
                  type: {
                    description: "Always `database_id`",
                    type: "string",
                    enum: [
                      "database_id",
                    ],
                  },
                },
                required: [
                  "database_id",
                ],
                additionalProperties: {},
              },
              {
                type: "object",
                properties: {
                  data_source_id: {
                    type: "string",
                    description: "The ID of the parent data source (collection), with or without dashes. For example, f336d0bc-b841-465b-8045-024475c079dd",
                  },
                  type: {
                    description: "Always `data_source_id`",
                    type: "string",
                    enum: [
                      "data_source_id",
                    ],
                  },
                },
                required: [
                  "data_source_id",
                ],
                additionalProperties: {},
              },
              {
                type: "object",
                properties: {
                  teamspace_id: {
                    type: "string",
                    description: "The ID of the teamspace in which to create top-level pages (with or without dashes).",
                  },
                },
                required: [
                  "teamspace_id",
                ],
                additionalProperties: false,
              },
            ],
          },
          allow_async: {
            description: "Default to true for page creation. Set to false only when the next step needs the created pages immediately, or when async execution rejects the request as too large. When this create operation is accepted for background execution, it returns an async_task result. Use get_async_task to wait for a succeeded status before taking a dependent action on the pages. For pages created with template_id, a succeeded status does not mean template content is ready; fetch and retry until it is ready before changing or relying on that content. If omitted or false, the tool keeps the existing synchronous result shape.",
            type: "boolean",
          },
        },
        required: [
          "pages",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: false },
      false,
    ),
    pin(
      "notion-update-page",
      "Update or archive a Notion page.",
      'write',
      {
        type: "object",
        properties: {
          page_id: {
            type: "string",
            description: "The ID of the page to update, with or without dashes.",
          },
          command: {
            type: "string",
            enum: [
              "update_properties",
              "update_content",
              "replace_content",
              "insert_content",
              "apply_template",
              "update_verification",
            ],
            description: "The update command to execute.",
          },
          properties: {
            description: "Required for \"update_properties\" command. A JSON object that updates the page's properties.\nFor pages in a database, fetch the page or its data source first and use the exact property names and SQLite schema definition shown in <database>.\nFor pages outside of a database, the only allowed property is \"title\", which is the title of the page in inline markdown format.\nFor a Files property, an uploaded file can be provided as {\"type\":\"file_upload\",\"file_upload\":{\"id\":\"<file-upload-id>\"}} inside the property's array.\nUse null to remove a property's value.\n**IMPORTANT**: Some property types require specific formats:\n- Date properties: Split into \"date:{property}:start\", \"date:{property}:end\" (optional), and \"date:{property}:is_datetime\" (0 or 1)\n- Place properties: Split into \"place:{property}:name\", \"place:{property}:address\", \"place:{property}:latitude\", \"place:{property}:longitude\", and \"place:{property}:google_place_id\" (optional)\n- Number properties: Use JavaScript numbers (not strings)\n- Checkbox properties: Use \"__YES__\" for checked, \"__NO__\" for unchecked\n- Relation properties: Use an array of related page URLs or page IDs, e.g. [\"https://www.notion.so/26ab1f9f4c5f80b18d3bd10a6b1d2f4e\", \"26ab1f9f-4c5f-80b1-8d3b-d10a6b1d2f4e\"]\n- Person properties: Use an array of user IDs, user or agent URLs, or group references copied from fetch output (\"space_permission_group-<UUID>\"). Bare group UUIDs are also supported.\n- Files properties: Use a JSON array of file IDs, Notion Folder URLs, and/or <folder> tags copied from fetch output. Folders are stored as native Folder references, not ordinary links.\n\n\n**Special property naming**: Properties named \"id\" or \"url\" (case insensitive) must be prefixed with \"userDefined:\" (e.g., \"userDefined:URL\", \"userDefined:id\")",
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "number",
                },
                {
                  maxItems: 100,
                  type: "array",
                  items: {
                    anyOf: [
                      {
                        type: "string",
                      },
                      {
                        type: "object",
                        properties: {
                          type: {
                            type: "string",
                            enum: [
                              "file_upload",
                            ],
                            description: "Always `file_upload`",
                          },
                          file_upload: {
                            type: "object",
                            properties: {
                              id: {
                                type: "string",
                                description: "ID of a file upload returned by create_file_upload or create_attachment.",
                              },
                            },
                            required: [
                              "id",
                            ],
                            additionalProperties: {},
                            description: "The uploaded file to attach to the Files property.",
                          },
                        },
                        required: [
                          "type",
                          "file_upload",
                        ],
                        additionalProperties: {},
                      },
                    ],
                  },
                },
                {
                  type: "null",
                },
              ],
            },
          },
          new_str: {
            description: "Required for \"replace_content\" command. The new content string to replace the entire page content with. Preserve child pages and databases with their exact fetched <page url=\"...\"> or <database url=\"...\"> tags. For people and dates, use user and date mentions rather than plain text; notion://docs/enhanced-markdown-spec gives the syntax.",
            type: "string",
          },
          content: {
            description: "Required for \"insert_content\" command. The markdown content to insert into the page. For people and dates, use user and date mentions rather than plain text; notion://docs/enhanced-markdown-spec gives the syntax.",
            type: "string",
          },
          content_updates: {
            description: "Required for \"update_content\" command. An array of search-and-replace operations, each with old_str (content to find) and new_str (replacement content). Operations that match are applied, and each one that matches nothing is reported in \"warnings\". The call fails only when no operation that changes content matches.",
            maxItems: 100,
            type: "array",
            items: {
              type: "object",
              properties: {
                old_str: {
                  type: "string",
                  minLength: 1,
                  description: "The existing content string to find and replace. Must exactly match the page content.",
                },
                new_str: {
                  type: "string",
                  description: "The new content string to replace old_str with. For people and dates, use user and date mentions rather than plain text; notion://docs/enhanced-markdown-spec gives the syntax.",
                },
                replace_all_matches: {
                  description: "If true, replaces all occurrences of old_str. If false (default), the operation fails if there are multiple matches.",
                  type: "boolean",
                },
              },
              required: [
                "old_str",
                "new_str",
              ],
              additionalProperties: {},
            },
          },
          position: {
            description: "Optional for \"insert_content\" command. Use {\"type\":\"start\"} to prepend content or {\"type\":\"end\"} to append content. Omit to append.",
            anyOf: [
              {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "start",
                    ],
                    description: "Insert the content at the start of the page.",
                  },
                },
                required: [
                  "type",
                ],
                additionalProperties: {},
              },
              {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "end",
                    ],
                    description: "Insert the content at the end of the page.",
                  },
                },
                required: [
                  "type",
                ],
                additionalProperties: {},
              },
            ],
          },
          allow_deleting_content: {
            description: "Optional for \"replace_content\" and \"update_content\" commands. Set to true to allow deletion of child pages and databases that are not referenced in the new content. If false or omitted, the operation will fail with an error listing the pages/databases that would be deleted. Show that list and ask the user for confirmation before retrying with true.",
            type: "boolean",
          },
          template_id: {
            description: "Required for \"apply_template\" command. The ID of a template to apply to this page; any page ID can be used as a template. Template content is appended to any existing page content asynchronously.",
            type: "string",
          },
          verification_status: {
            description: "Required for \"update_verification\" command. Set to \"verified\" to mark the page as verified, or \"unverified\" to remove verification. Requires a Business or Enterprise plan unless the page is in a wiki. When updating verification, the owner will be automatically set to the authenticated actor.",
            type: "string",
            enum: [
              "verified",
              "unverified",
            ],
          },
          verification_expiry_days: {
            description: "Optional for \"update_verification\" command when verification_status is \"verified\". Number of days until verification expires (e.g. 7, 30, 90). Omit for indefinite verification.",
            type: "integer",
            minimum: 1,
            maximum: 9007199254740991,
          },
          icon: {
            description: "An emoji character (e.g. \"🚀\"), a custom emoji by name (e.g. \":rocket_ship:\"), a Notion icon identifier as returned by fetch (e.g. \"icons/pizza_blue\"), or an external image URL. Use \"none\" to remove the icon. Omit to leave unchanged. Can be set alongside any command. Keep the title free of a duplicate leading emoji because the icon renders separately.",
            type: "string",
          },
          cover: {
            description: "An external image URL for the page cover. Use \"none\" to remove the cover. Omit to leave unchanged. Can be set alongside any command.",
            type: "string",
          },
          is_skill: {
            description: "Set to true to mark this page as a skill, or false to remove the skill designation. Can be set alongside any command. To change only skill status, use \"update_properties\" and omit \"properties\".",
            type: "boolean",
          },
          allow_async: {
            description: "Default to true for page updates. Set to false only when the next step needs the updated page immediately, or when async execution rejects the request as too large. When this update operation is accepted for background execution, it returns an async_task result. Use get_async_task to wait for a succeeded status before taking a dependent action on the page. For apply_template, a succeeded status does not mean template content is ready; fetch and retry until it is ready before changing or relying on that content. If omitted or false, the tool waits for a synchronous result when possible, but may still return a pollable async_task response if queued execution exceeds the synchronous wait deadline.",
            type: "boolean",
          },
        },
        required: [
          "page_id",
          "command",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: true },
      true,
    ),
    pin(
      "notion-move-pages",
      "Move Notion pages or databases to a new parent.",
      'write',
      {
        type: "object",
        properties: {
          page_or_database_ids: {
            description: "An array of up to 100 page or database IDs to move. IDs are v4 UUIDs and can be supplied with or without dashes (e.g. extracted from a <page> or <database> URL given by the \"search\" or \"fetch\" tool). Data Sources under Databases can't be moved individually.",
            minItems: 1,
            maxItems: 100,
            type: "array",
            items: {
              type: "string",
            },
          },
          new_parent: {
            description: "The new parent under which the pages will be moved. This can be a page, the workspace, a database, or a specific data source under a database when there are multiple. Moving pages to the workspace level adds them as private pages and should rarely be used.",
            anyOf: [
              {
                type: "object",
                properties: {
                  page_id: {
                    type: "string",
                    description: "The ID of the parent page (with or without dashes), for example, 195de9221179449fab8075a27c979105",
                  },
                  type: {
                    description: "Always `page_id`",
                    type: "string",
                    enum: [
                      "page_id",
                    ],
                  },
                },
                required: [
                  "page_id",
                ],
                additionalProperties: {},
              },
              {
                type: "object",
                properties: {
                  database_id: {
                    type: "string",
                    description: "The ID of the parent database (with or without dashes), for example, 195de9221179449fab8075a27c979105",
                  },
                  type: {
                    description: "Always `database_id`",
                    type: "string",
                    enum: [
                      "database_id",
                    ],
                  },
                },
                required: [
                  "database_id",
                ],
                additionalProperties: {},
              },
              {
                type: "object",
                properties: {
                  data_source_id: {
                    type: "string",
                    description: "The ID of the parent data source (collection), with or without dashes. For example, f336d0bc-b841-465b-8045-024475c079dd",
                  },
                  type: {
                    description: "Always `data_source_id`",
                    type: "string",
                    enum: [
                      "data_source_id",
                    ],
                  },
                },
                required: [
                  "data_source_id",
                ],
                additionalProperties: {},
              },
              {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "workspace",
                    ],
                    description: "The parent type.",
                  },
                },
                required: [
                  "type",
                ],
                additionalProperties: {},
              },
            ],
          },
        },
        required: [
          "page_or_database_ids",
          "new_parent",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: false },
      true,
    ),
    pin(
      "notion-duplicate-page",
      "Duplicate a Notion page.",
      'write',
      {
        type: "object",
        properties: {
          page_id: {
            type: "string",
            description: "The ID of the page to duplicate. This is a v4 UUID, with or without dashes, and can be parsed from a Notion page URL.",
          },
        },
        required: [
          "page_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: false },
      false,
    ),
    pin(
      "notion-create-database",
      "Create a Notion database.",
      'write',
      {
        type: "object",
        properties: {
          parent: {
            description: "The parent under which to create the new database. If omitted, the database will be created as a private page at the workspace level.",
            type: "object",
            properties: {
              page_id: {
                type: "string",
                description: "The ID of the parent page, with or without dashes.",
              },
              type: {
                description: "Always `page_id`",
                type: "string",
                enum: [
                  "page_id",
                ],
              },
            },
            required: [
              "page_id",
            ],
            additionalProperties: {},
          },
          title: {
            description: "The title of the new database.",
            type: "string",
          },
          description: {
            description: "The description of the new database.",
            type: "string",
          },
          schema: {
            description: "SQL DDL CREATE TABLE statement defining the database schema. Cannot be combined with database_type. Column names must be double-quoted and type options use single quotes.\n\nProperty type syntax:\n- Simple: TITLE, RICH_TEXT, DATE, PEOPLE, CHECKBOX, URL, EMAIL, PHONE_NUMBER, FILES\n- SELECT('opt':color, ...) / MULTI_SELECT('opt':color, ...)\n- STATUS('Backlog':gray:to_do, 'Building':blue:in_progress, 'Shipped':green:complete); groups are to_do, in_progress, complete\n- NUMBER [FORMAT 'dollar'] / FORMULA('expression')\n- RELATION('ds') for a one-way relation\n- RELATION('ds', DUAL) for a two-way relation\n- RELATION('ds', DUAL 'Children') with a synced property name\n- RELATION('ds', DUAL 'Children' 'children') with a synced name and synced_id (for self-relations)\n- ROLLUP('rel_prop', 'target_prop', 'function')\n- UNIQUE_ID [PREFIX 'X'] / CREATED_TIME / LAST_EDITED_TIME\n- Any column: COMMENT 'description text' Colors: default, gray, brown, orange, yellow, green, blue, purple, pink, red.\n\n\nExamples:\n- Minimal: <example>CREATE TABLE (\"Name\" TITLE)</example>\n- With options: <example>CREATE TABLE (\"Name\" TITLE, \"Budget\" NUMBER FORMAT 'dollar', \"Tags\" MULTI_SELECT('eng':blue, 'design':pink), \"Task ID\" UNIQUE_ID PREFIX 'PRJ')</example>\n- Self-relations are a two-step flow: create the database, then use its data source ID with update_data_source to add paired properties such as RELATION('ds', DUAL 'Children' 'children').",
            type: "string",
          },
          database_type: {
            description: "Create a canonical typed database with Notion's required properties and metadata. Supported types: tasks, projects, skills. Example: <example>tasks</example>. Use title \"Tasks\" when needed.",
            type: "string",
            enum: [
              "tasks",
              "projects",
              "skills",
            ],
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: false },
      false,
    ),
    pin(
      "notion-create-folder",
      "Create a Notion folder.",
      'write',
      {
        type: "object",
        properties: {
          parent: {
            description: "Where to create the Folder.",
            anyOf: [
              {
                type: "object",
                properties: {
                  page_id: {
                    type: "string",
                    description: "The ID of the page that will own the Folder.",
                  },
                },
                required: [
                  "page_id",
                ],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  folder_id: {
                    type: "string",
                    description: "The ID of the Folder that will contain the new Folder.",
                  },
                },
                required: [
                  "folder_id",
                ],
                additionalProperties: false,
              },
            ],
          },
          title: {
            type: "string",
            description: "The title of the new Folder.",
          },
        },
        required: [
          "parent",
          "title",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: false },
      false,
    ),
    pin(
      "notion-update-folder",
      "Update a Notion folder.",
      'write',
      {
        type: "object",
        properties: {
          folder_id: {
            type: "string",
            description: "The ID of the Folder to update.",
          },
          command: {
            type: "string",
            enum: [
              "add_files",
              "remove_files",
              "add_subfolder",
            ],
            description: "The Folder update to apply.",
          },
          file_upload_ids: {
            description: "Required for add_files. One or more file upload IDs returned by the file upload tools.",
            minItems: 1,
            maxItems: 100,
            type: "array",
            items: {
              type: "string",
            },
          },
          file_urls: {
            description: "Required for remove_files. The exact file URLs shown in the Folder's latest fetch output.",
            minItems: 1,
            maxItems: 100,
            type: "array",
            items: {
              type: "string",
            },
          },
          title: {
            description: "Required for add_subfolder. The new Folder's title.",
            type: "string",
          },
        },
        required: [
          "folder_id",
          "command",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      { readOnlyHint: false, destructiveHint: true },
      true,
    ),
    pin(
      "notion-update-data-source",
      "Update a Notion data source schema or layout.",
      'write',
      {
        type: "object",
        properties: {
          data_source_id: {
            type: "string",
            description: "The data source to update. Accepts a collection:// URI from <data-source> tags, a bare UUID, or a database ID (only if the database has a single data source).",
          },
          statements: {
            description: "Semicolon-separated SQL DDL statements to update the schema. Supports ADD COLUMN, DROP COLUMN, RENAME COLUMN, and ALTER COLUMN SET.\n\nProperty type syntax:\n- Simple: TITLE, RICH_TEXT, DATE, PEOPLE, CHECKBOX, URL, EMAIL, PHONE_NUMBER, FILES\n- SELECT('opt':color, ...) / MULTI_SELECT('opt':color, ...)\n- STATUS('Backlog':gray:to_do, 'Building':blue:in_progress, 'Shipped':green:complete); groups are to_do, in_progress, complete\n- NUMBER [FORMAT 'dollar'] / FORMULA('expression')\n- RELATION('ds') for a one-way relation\n- RELATION('ds', DUAL) for a two-way relation\n- RELATION('ds', DUAL 'Children') with a synced property name\n- RELATION('ds', DUAL 'Children' 'children') with a synced name and synced_id (for self-relations)\n- ROLLUP('rel_prop', 'target_prop', 'function')\n- UNIQUE_ID [PREFIX 'X'] / CREATED_TIME / LAST_EDITED_TIME\n- Any column: COMMENT 'description text' Colors: default, gray, brown, orange, yellow, green, blue, purple, pink, red.\n\n\nExamples:\n- <example>ADD COLUMN \"Priority\" SELECT('High':red, 'Medium':yellow, 'Low':green); ADD COLUMN \"Due Date\" DATE</example>\n- <example>RENAME COLUMN \"Status\" TO \"Project Status\"</example>\n- <example>DROP COLUMN \"Old Property\"</example>\n- For a self-relation, add both relation properties in one call with matching DUAL names and IDs, such as <example>ADD COLUMN \"Parent\" RELATION('ds', DUAL 'Children' 'children')</example>.",
            type: "string",
          },
          title: {
            description: "The new title of the data source.",
            type: "string",
          },
          description: {
            description: "The new description of the data source.",
            type: "string",
          },
          is_inline: {
            description: "Whether the database should display inline (true) or as full page (false). Only applicable for single-source databases.",
            type: "boolean",
          },
          in_trash: {
            description: "Move data source to trash. Cannot be undone without Notion UI.",
            type: "boolean",
          },
          page_layout: {
            description: "Replaces the data source's page layout. Refer to existing properties by name. See notion://docs/database-page-layouts. Example: <example>{\"main\":[{\"type\":\"title\",\"pinnedProperties\":[\"Status\",\"Owner\"]},{\"type\":\"editor\"},{\"type\":\"discussions\"}],\"sidebar\":[{\"type\":\"properties\"}]}</example>.",
            type: "object",
            properties: {
              main: {
                type: "array",
                items: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: [
                            "cover",
                            "editor",
                            "discussions",
                            "relations",
                            "backlinks",
                            "page_sections",
                            "bottom_controls",
                          ],
                          description: "The module type.",
                        },
                      },
                      required: [
                        "type",
                      ],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: [
                            "properties",
                          ],
                          description: "The module type.",
                        },
                        properties: {
                          description: "Properties in order. Unlisted properties follow in their current order and show. Don't list the title or properties placed elsewhere in the layout.",
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              property: {
                                type: "string",
                                description: "The property name.",
                              },
                              visibility: {
                                description: "Defaults to show. Changes how pages look, not who can see the value.",
                                type: "string",
                                enum: [
                                  "show",
                                  "hide_if_empty",
                                  "hide",
                                ],
                              },
                            },
                            required: [
                              "property",
                            ],
                            additionalProperties: false,
                          },
                        },
                      },
                      required: [
                        "type",
                      ],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: [
                            "properties",
                          ],
                          description: "The module type.",
                        },
                        sections: {
                          minItems: 1,
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              name: {
                                type: "string",
                                minLength: 1,
                                description: "The section name.",
                              },
                              properties: {
                                type: "array",
                                items: {
                                  type: "object",
                                  properties: {
                                    property: {
                                      type: "string",
                                      description: "The property name.",
                                    },
                                    visibility: {
                                      description: "Defaults to show. Changes how pages look, not who can see the value.",
                                      type: "string",
                                      enum: [
                                        "show",
                                        "hide_if_empty",
                                        "hide",
                                      ],
                                    },
                                  },
                                  required: [
                                    "property",
                                  ],
                                  additionalProperties: false,
                                },
                                description: "Properties in this section, in order. Don't list the title or properties placed elsewhere in the layout.",
                              },
                            },
                            required: [
                              "name",
                              "properties",
                            ],
                            additionalProperties: false,
                          },
                          description: "Named sections in order. Unlisted properties go in the last section and show.",
                        },
                      },
                      required: [
                        "type",
                        "sections",
                      ],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: [
                            "title",
                          ],
                          description: "The module type.",
                        },
                        pinnedProperties: {
                          description: "Property names to show under the title.",
                          type: "array",
                          items: {
                            type: "string",
                          },
                        },
                        propertyLabels: {
                          description: "Whether pinned properties show their names.",
                          type: "string",
                          enum: [
                            "show",
                            "hide",
                          ],
                        },
                      },
                      required: [
                        "type",
                      ],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: [
                            "property",
                          ],
                          description: "The module type.",
                        },
                        property: {
                          type: "string",
                          description: "The name of the property to show.",
                        },
                        config: {
                          description: "How the property looks.",
                          type: "object",
                          properties: {
                            style: {
                              type: "string",
                              enum: [
                                "compact",
                                "large",
                                "small",
                                "landscape",
                                "portrait",
                                "square",
                                "map",
                                "text",
                              ],
                              description: "Display style. Which styles apply depends on the property type.",
                            },
                          },
                          required: [
                            "style",
                          ],
                          additionalProperties: false,
                        },
                      },
                      required: [
                        "type",
                        "property",
                      ],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: [
                            "views",
                          ],
                          description: "The module type.",
                        },
                        relation: {
                          type: "string",
                          description: "The name of a two-way relation property whose related pages show as a view.",
                        },
                      },
                      required: [
                        "type",
                        "relation",
                      ],
                      additionalProperties: false,
                    },
                  ],
                },
                description: "Main area modules in order. Include a title, an editor (unless the layout has a tab), and discussions.",
              },
              sidebar: {
                description: "Sidebar modules in order. Only properties and property modules are allowed.",
                type: "array",
                items: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: [
                            "properties",
                          ],
                          description: "The module type.",
                        },
                        properties: {
                          description: "Properties in order. Unlisted properties follow in their current order and show. Don't list the title or properties placed elsewhere in the layout.",
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              property: {
                                type: "string",
                                description: "The property name.",
                              },
                              visibility: {
                                description: "Defaults to show. Changes how pages look, not who can see the value.",
                                type: "string",
                                enum: [
                                  "show",
                                  "hide_if_empty",
                                  "hide",
                                ],
                              },
                            },
                            required: [
                              "property",
                            ],
                            additionalProperties: false,
                          },
                        },
                      },
                      required: [
                        "type",
                      ],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: [
                            "properties",
                          ],
                          description: "The module type.",
                        },
                        sections: {
                          minItems: 1,
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              name: {
                                type: "string",
                                minLength: 1,
                                description: "The section name.",
                              },
                              properties: {
                                type: "array",
                                items: {
                                  type: "object",
                                  properties: {
                                    property: {
                                      type: "string",
                                      description: "The property name.",
                                    },
                                    visibility: {
                                      description: "Defaults to show. Changes how pages look, not who can see the value.",
                                      type: "string",
                                      enum: [
                                        "show",
                                        "hide_if_empty",
                                        "hide",
                                      ],
                                    },
                                  },
                                  required: [
                                    "property",
                                  ],
                                  additionalProperties: false,
                                },
                                description: "Properties in this section, in order. Don't list the title or properties placed elsewhere in the layout.",
                              },
                            },
                            required: [
                              "name",
                              "properties",
                            ],
                            additionalProperties: false,
                          },
                          description: "Named sections in order. Unlisted properties go in the last section and show.",
                        },
                      },
                      required: [
                        "type",
                        "sections",
                      ],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: [
                            "property",
                          ],
                          description: "The module type.",
                        },
                        property: {
                          type: "string",
                          description: "The name of the property to show.",
                        },
                        config: {
                          description: "How the property looks.",
                          type: "object",
                          properties: {
                            style: {
                              type: "string",
                              enum: [
                                "compact",
                                "large",
                                "small",
                                "landscape",
                                "portrait",
                                "square",
                                "map",
                                "text",
                              ],
                              description: "Display style. Which styles apply depends on the property type.",
                            },
                          },
                          required: [
                            "style",
                          ],
                          additionalProperties: false,
                        },
                      },
                      required: [
                        "type",
                        "property",
                      ],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              tab: {
                description: "Puts page content in a tab next to database views. Omit for a simple layout.",
                type: "object",
                properties: {
                  id: {
                    description: "The existing tab ID from fetch. Omit for a new tab. Starts with view_tab_.",
                    type: "string",
                  },
                  modules: {
                    type: "array",
                    items: {
                      anyOf: [
                        {
                          type: "object",
                          properties: {
                            type: {
                              type: "string",
                              enum: [
                                "editor",
                                "discussions",
                                "relations",
                              ],
                              description: "The module type.",
                            },
                          },
                          required: [
                            "type",
                          ],
                          additionalProperties: false,
                        },
                        {
                          type: "object",
                          properties: {
                            type: {
                              type: "string",
                              enum: [
                                "properties",
                              ],
                              description: "The module type.",
                            },
                            properties: {
                              description: "Properties in order. Unlisted properties follow in their current order and show. Don't list the title or properties placed elsewhere in the layout.",
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  property: {
                                    type: "string",
                                    description: "The property name.",
                                  },
                                  visibility: {
                                    description: "Defaults to show. Changes how pages look, not who can see the value.",
                                    type: "string",
                                    enum: [
                                      "show",
                                      "hide_if_empty",
                                      "hide",
                                    ],
                                  },
                                },
                                required: [
                                  "property",
                                ],
                                additionalProperties: false,
                              },
                            },
                          },
                          required: [
                            "type",
                          ],
                          additionalProperties: false,
                        },
                        {
                          type: "object",
                          properties: {
                            type: {
                              type: "string",
                              enum: [
                                "properties",
                              ],
                              description: "The module type.",
                            },
                            sections: {
                              minItems: 1,
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  name: {
                                    type: "string",
                                    minLength: 1,
                                    description: "The section name.",
                                  },
                                  properties: {
                                    type: "array",
                                    items: {
                                      type: "object",
                                      properties: {
                                        property: {
                                          type: "string",
                                          description: "The property name.",
                                        },
                                        visibility: {
                                          description: "Defaults to show. Changes how pages look, not who can see the value.",
                                          type: "string",
                                          enum: [
                                            "show",
                                            "hide_if_empty",
                                            "hide",
                                          ],
                                        },
                                      },
                                      required: [
                                        "property",
                                      ],
                                      additionalProperties: false,
                                    },
                                    description: "Properties in this section, in order. Don't list the title or properties placed elsewhere in the layout.",
                                  },
                                },
                                required: [
                                  "name",
                                  "properties",
                                ],
                                additionalProperties: false,
                              },
                              description: "Named sections in order. Unlisted properties go in the last section and show.",
                            },
                          },
                          required: [
                            "type",
                            "sections",
                          ],
                          additionalProperties: false,
                        },
                        {
                          type: "object",
                          properties: {
                            type: {
                              type: "string",
                              enum: [
                                "property",
                              ],
                              description: "The module type.",
                            },
                            property: {
                              type: "string",
                              description: "The name of the property to show.",
                            },
                            config: {
                              description: "How the property looks.",
                              type: "object",
                              properties: {
                                style: {
                                  type: "string",
                                  enum: [
                                    "compact",
                                    "large",
                                    "small",
                                    "landscape",
                                    "portrait",
                                    "square",
                                    "map",
                                    "text",
                                  ],
                                  description: "Display style. Which styles apply depends on the property type.",
                                },
                              },
                              required: [
                                "style",
                              ],
                              additionalProperties: false,
                            },
                          },
                          required: [
                            "type",
                            "property",
                          ],
                          additionalProperties: false,
                        },
                      ],
                    },
                    description: "Tab modules in order. Must include an editor. Only properties, property modules, discussions, relations, and the editor are allowed.",
                  },
                },
                required: [
                  "modules",
                ],
                additionalProperties: false,
              },
              format: {
                description: "Page display options.",
                type: "object",
                properties: {
                  propertyIcons: {
                    description: "Whether property icons show on the page.",
                    type: "string",
                    enum: [
                      "show",
                      "hide",
                    ],
                  },
                  pageFullWidth: {
                    description: "Whether pages open at full width.",
                    type: "boolean",
                  },
                },
                additionalProperties: false,
              },
            },
            required: [
              "main",
            ],
            additionalProperties: false,
          },
        },
        required: [
          "data_source_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: true },
      true,
    ),
    pin(
      "notion-create-comment",
      "Add a comment to Notion content.",
      'write',
      {
        type: "object",
        properties: {
          page_id: {
            type: "string",
            description: "The ID of the page to comment on (with or without dashes).",
          },
          reply_to_comment_id: {
            description: "The ID of the comment to reply to.",
            type: "string",
          },
          discussion_id: {
            description: "The ID or URL of an existing discussion to reply to (e.g., discussion://pageId/blockId/discussionId).",
            type: "string",
          },
          selection_with_ellipsis: {
            description: "Unique content snippet: ~10 characters from each end, joined by \"...\". A match within one block's text gets an inline comment on that text; otherwise, comment on the block where the match starts. No match returns an error.",
            type: "string",
          },
          rich_text: {
            description: "An array of rich text objects that represent the content of the comment. Provide exactly one of rich_text or markdown.",
            maxItems: 100,
            type: "array",
            items: {
              allOf: [
                {
                  type: "object",
                  properties: {
                    annotations: {
                      description: "All rich text objects contain an annotations object that sets the styling for the rich text.",
                      type: "object",
                      properties: {
                        bold: {
                          description: "Whether the text is formatted as bold.",
                          type: "boolean",
                        },
                        italic: {
                          description: "Whether the text is formatted as italic.",
                          type: "boolean",
                        },
                        strikethrough: {
                          description: "Whether the text is formatted with a strikethrough.",
                          type: "boolean",
                        },
                        underline: {
                          description: "Whether the text is formatted with an underline.",
                          type: "boolean",
                        },
                        code: {
                          description: "Whether the text is formatted as code.",
                          type: "boolean",
                        },
                        color: {
                          description: "The color of the text.",
                          type: "string",
                        },
                      },
                      additionalProperties: {},
                    },
                  },
                  additionalProperties: {},
                },
                {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        type: {
                          description: "Always `text`",
                          type: "string",
                          enum: [
                            "text",
                          ],
                        },
                        text: {
                          type: "object",
                          properties: {
                            content: {
                              type: "string",
                              maxLength: 2000,
                              description: "The actual text content of the text.",
                            },
                            link: {
                              description: "An object with information about any inline link in this text, if included.",
                              anyOf: [
                                {
                                  type: "object",
                                  properties: {
                                    url: {
                                      type: "string",
                                      description: "The URL of the link.",
                                    },
                                  },
                                  required: [
                                    "url",
                                  ],
                                  additionalProperties: {},
                                },
                                {
                                  type: "null",
                                },
                              ],
                            },
                          },
                          required: [
                            "content",
                          ],
                          additionalProperties: false,
                          description: "If a rich text object's type value is `text`, then the corresponding text field contains an object including the text content and any inline link.",
                        },
                      },
                      required: [
                        "text",
                      ],
                      additionalProperties: {},
                    },
                    {
                      type: "object",
                      properties: {
                        type: {
                          description: "Always `mention`",
                          type: "string",
                          enum: [
                            "mention",
                          ],
                        },
                        mention: {
                          anyOf: [
                            {
                              type: "object",
                              properties: {
                                type: {
                                  description: "Always `user`",
                                  type: "string",
                                  enum: [
                                    "user",
                                  ],
                                },
                                user: {
                                  type: "object",
                                  properties: {
                                    id: {
                                      type: "string",
                                      description: "The ID of the user.",
                                    },
                                    object: {
                                      description: "The user object type name.",
                                      type: "string",
                                      enum: [
                                        "user",
                                      ],
                                    },
                                  },
                                  required: [
                                    "id",
                                  ],
                                  additionalProperties: {},
                                  description: "Details of the user mention.",
                                },
                              },
                              required: [
                                "user",
                              ],
                              additionalProperties: {},
                            },
                            {
                              type: "object",
                              properties: {
                                type: {
                                  description: "Always `date`",
                                  type: "string",
                                  enum: [
                                    "date",
                                  ],
                                },
                                date: {
                                  type: "object",
                                  properties: {
                                    start: {
                                      type: "string",
                                      format: "date",
                                      pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                      description: "The start date of the date object.",
                                    },
                                    end: {
                                      description: "The end date of the date object, if any.",
                                      anyOf: [
                                        {
                                          type: "string",
                                          format: "date",
                                          pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                        },
                                        {
                                          type: "null",
                                        },
                                      ],
                                    },
                                    time_zone: {
                                      description: "The time zone of the date object, if any. E.g. America/Los_Angeles, Europe/London, etc.",
                                      anyOf: [
                                        {
                                          type: "string",
                                        },
                                        {
                                          type: "null",
                                        },
                                      ],
                                    },
                                  },
                                  required: [
                                    "start",
                                  ],
                                  additionalProperties: false,
                                  description: "Details of the date mention.",
                                },
                              },
                              required: [
                                "date",
                              ],
                              additionalProperties: {},
                            },
                            {
                              type: "object",
                              properties: {
                                type: {
                                  description: "Always `page`",
                                  type: "string",
                                  enum: [
                                    "page",
                                  ],
                                },
                                page: {
                                  type: "object",
                                  properties: {
                                    id: {
                                      type: "string",
                                      description: "The ID of the page in the mention.",
                                    },
                                  },
                                  required: [
                                    "id",
                                  ],
                                  additionalProperties: {},
                                  description: "Details of the page mention.",
                                },
                              },
                              required: [
                                "page",
                              ],
                              additionalProperties: {},
                            },
                            {
                              type: "object",
                              properties: {
                                type: {
                                  description: "Always `database`",
                                  type: "string",
                                  enum: [
                                    "database",
                                  ],
                                },
                                database: {
                                  type: "object",
                                  properties: {
                                    id: {
                                      type: "string",
                                      description: "The ID of the database in the mention.",
                                    },
                                  },
                                  required: [
                                    "id",
                                  ],
                                  additionalProperties: {},
                                  description: "Details of the database mention.",
                                },
                              },
                              required: [
                                "database",
                              ],
                              additionalProperties: {},
                            },
                            {
                              type: "object",
                              properties: {
                                type: {
                                  description: "Always `template_mention`",
                                  type: "string",
                                  enum: [
                                    "template_mention",
                                  ],
                                },
                                template_mention: {
                                  anyOf: [
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          description: "Always `template_mention_date`",
                                          type: "string",
                                          enum: [
                                            "template_mention_date",
                                          ],
                                        },
                                        template_mention_date: {
                                          type: "string",
                                          enum: [
                                            "today",
                                            "now",
                                          ],
                                          description: "The date of the template mention.",
                                        },
                                      },
                                      required: [
                                        "template_mention_date",
                                      ],
                                      additionalProperties: false,
                                    },
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          description: "Always `template_mention_user`",
                                          type: "string",
                                          enum: [
                                            "template_mention_user",
                                          ],
                                        },
                                        template_mention_user: {
                                          type: "string",
                                          enum: [
                                            "me",
                                          ],
                                          description: "The user of the template mention.",
                                        },
                                      },
                                      required: [
                                        "template_mention_user",
                                      ],
                                      additionalProperties: false,
                                    },
                                  ],
                                  description: "Details of the template mention.",
                                },
                              },
                              required: [
                                "template_mention",
                              ],
                              additionalProperties: {},
                            },
                            {
                              type: "object",
                              properties: {
                                type: {
                                  description: "Always `custom_emoji`",
                                  type: "string",
                                  enum: [
                                    "custom_emoji",
                                  ],
                                },
                                custom_emoji: {
                                  type: "object",
                                  properties: {
                                    id: {
                                      type: "string",
                                      description: "The ID of the custom emoji.",
                                    },
                                    name: {
                                      description: "The name of the custom emoji.",
                                      type: "string",
                                    },
                                    url: {
                                      description: "The URL of the custom emoji.",
                                      type: "string",
                                    },
                                  },
                                  required: [
                                    "id",
                                  ],
                                  additionalProperties: {},
                                  description: "Details of the custom emoji mention.",
                                },
                              },
                              required: [
                                "custom_emoji",
                              ],
                              additionalProperties: {},
                            },
                          ],
                          description: "Mention objects represent an inline mention of a database, date, link preview mention, page, template mention, or user. A mention is created in the Notion UI when a user types `@` followed by the name of the reference.",
                        },
                      },
                      required: [
                        "mention",
                      ],
                      additionalProperties: {},
                    },
                    {
                      type: "object",
                      properties: {
                        type: {
                          description: "Always `equation`",
                          type: "string",
                          enum: [
                            "equation",
                          ],
                        },
                        equation: {
                          type: "object",
                          properties: {
                            expression: {
                              type: "string",
                              description: "A KaTeX compatible string.",
                            },
                          },
                          required: [
                            "expression",
                          ],
                          additionalProperties: {},
                          description: "Notion supports inline LaTeX equations as rich text objects with a type value of `equation`.",
                        },
                      },
                      required: [
                        "equation",
                      ],
                      additionalProperties: {},
                    },
                  ],
                },
              ],
            },
          },
          markdown: {
            description: "The content of the comment as a Markdown string. Provide exactly one of markdown or rich_text. For exact syntax, read the MCP resource `notion://docs/enhanced-markdown-spec` through your MCP client's resource-reading interface, or call the Notion \"fetch\" tool with this URI if your client does not support reading MCP resources. Do NOT pass this URI to any other URL-fetching tool. Use only the Rich text types and Mentions syntax that comments support. Comments support inline formatting (bold, italic, strikethrough, underline, code, links), inline math using $`Equation`$, and user/page/database/date mention tags such as <mention-date start=\"YYYY-MM-DD\"/>. To attach a file created by create-file-upload or create-attachment, include its returned suggested_markdown on a separate line; up to three file attachments are supported. Do not use UI shortcuts like @today, @name, [[page]], or autocomplete-style emoji syntax; those are editor affordances, not markdown syntax. Mention tags must include a real url where required by the spec. Other block-level Markdown such as fenced code blocks, headings, lists, tables, and blockquotes is stored as plain comment text rather than rendered as blocks. Example: <example>Looks good.</example>.",
            type: "string",
          },
        },
        required: [
          "page_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: false },
      false,
    ),
    pin(
      "notion-get-comments",
      "Read comments on a Notion page.",
      'read',
      {
        type: "object",
        properties: {
          page_id: {
            type: "string",
            description: "Identifier for a Notion page.",
          },
          include_resolved: {
            description: "Include resolved discussions in the response. Defaults to false.",
            type: "boolean",
          },
          include_all_blocks: {
            description: "Include discussions on child blocks, not just page-level discussions. Defaults to false.",
            type: "boolean",
          },
          discussion_id: {
            description: "Fetch a specific discussion by ID or discussion URL (e.g., discussion://pageId/blockId/discussionId).",
            type: "string",
          },
        },
        required: [
          "page_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-get-async-task",
      "Read the status of a Notion task started by another tool.",
      'read',
      {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            minLength: 1,
            description: "The ID of the async task to retrieve, as returned in the async_task response of the tool that started it.",
          },
        },
        required: [
          "task_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-get-teams",
      "List teams in the connected Notion workspace.",
      'read',
      {
        type: "object",
        properties: {
          query: {
            description: "Optional search query to filter teams by name (case-insensitive).",
            type: "string",
            minLength: 1,
            maxLength: 100,
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-get-users",
      "List users in the connected Notion workspace.",
      'read',
      {
        type: "object",
        properties: {
          query: {
            description: "Optional search query to filter users by name or email (case-insensitive).",
            type: "string",
            minLength: 1,
            maxLength: 100,
          },
          start_cursor: {
            description: "Cursor for pagination. Use the next_cursor value from the previous response to get the next page.",
            type: "string",
            minLength: 1,
          },
          page_size: {
            description: "Number of users to return per page (1–100; default 100).",
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          user_id: {
            description: "Return only the user matching this ID. Pass \"self\" to fetch the current user.",
            type: "string",
            minLength: 1,
            maxLength: 100,
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-query-data-sources",
      "Query rows in a Notion data source.",
      'read',
      {
        type: "object",
        properties: {
          data: {
            description: "Mode parameter reference and examples.\n\nSQL mode:\n- Use single quotes for SQL string values, such as `\"Status\" = 'Done'`. Use double quotes for table and column names. In SQL, `''` is an empty string.\n- Prefer `?` placeholders for values. For text values, the `params` array uses JSON strings, so `[\"\"]` passes an empty string and `[\"__YES__\"]` passes a checked checkbox value. Do not add SQL quote marks around a bound value.\n- Checkbox SQL values: `'__YES__'` means checked; `'__NO__'` means unchecked.\n\n\nRows mode: Return up to 100 rows with faithful rich-text property values and optional structured filters and sorts.\n\nExample:\n<example>{\"mode\":\"rows\",\"data_source_url\":\"collection://f336d0bc-b841-465b-8045-024475c079dd\",\"filter\":{\"type\":\"group\",\"operator\":\"and\",\"filters\":[{\"type\":\"property\",\"property\":\"Status\",\"propertyType\":\"select\",\"operator\":\"enum_is\",\"value\":{\"type\":\"exact\",\"value\":\"In Progress\"}}]},\"limit\":20}</example>\n\nExamples:\n- Simple SQL: <example>{\"data_source_urls\":[\"collection://f336d0bc-b841-465b-8045-024475c079dd\"],\"query\":\"SELECT * FROM [collection://f336d0bc-b841-465b-8045-024475c079dd] LIMIT 10\"}</example>\n- SQL parameters: <example>{\"mode\":\"sql\",\"data_source_urls\":[\"collection://abc123\"],\"query\":\"SELECT * FROM [collection://abc123] WHERE Status = ? AND Priority = ?\",\"params\":[\"In Progress\",\"High\"]}</example>\n- Checkbox query: <example>{\"data_source_urls\":[\"collection://def456\"],\"query\":\"SELECT * FROM [collection://def456] WHERE Completed = ?\",\"params\":[\"__YES__\"]}</example>\n\nView mode: Execute a specific database view's query with its filters and sorts. Omit \"is_archived\" or set it to false for non-archived rows. Set \"is_archived\": true to apply the view inside the archived partition. When the response has \"has_more\": true, pass its \"next_cursor\" as \"start_cursor\" in a follow-up view-mode request with the same \"is_archived\" value.\n\nExample:\n<example>{\"mode\":\"view\",\"view_url\":\"https://www.notion.so/workspace/Tasks-DB-abc123?v=def456\",\"is_archived\":false}</example>",
            anyOf: [
              {
                type: "object",
                properties: {
                  data_source_urls: {
                    maxItems: 100,
                    type: "array",
                    items: {
                      type: "string",
                    },
                    description: "Notion data source URLs whose SQLite tables are available to the query; each data source is exposed as a table named by its URL. Obtain them from the fetch tool, in the format: collection://f336d0bc-b841-465b-8045-024475c079dd",
                  },
                  query: {
                    type: "string",
                    description: "Read-only SQLite query to execute against the data sources. Use a data source URL as the table name, e.g. SELECT * FROM \"collection://...\" WHERE .... Use only table and column names shown in the fetched `<sqlite-table>` definition; date properties use the expanded column names listed there, not the base name. Include every needed filter in WHERE (filters on views of the data source are not automatically applied). For time comparisons or ordering, normalize text timestamps with datetime(...) or date(...). SQL text values can omit rich-text mentions and formatting, and links can lose their destination. Use faithful rows mode or fetch the page before rewriting a rich-text property.",
                  },
                  mode: {
                    description: "Optional mode parameter. Defaults to 'sql' if not specified. SQL mode does not accept is_archived; that parameter belongs only to view mode.",
                    type: "string",
                    enum: [
                      "sql",
                    ],
                  },
                  params: {
                    description: "Positional parameters bound to `?` placeholders in the query. Prefer parameterized queries over string interpolation. Use \"__YES__\" for checked checkboxes and \"__NO__\" for unchecked checkboxes.",
                    maxItems: 100,
                    type: "array",
                    items: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "number",
                        },
                        {
                          type: "boolean",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                },
                required: [
                  "data_source_urls",
                  "query",
                ],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  mode: {
                    type: "string",
                    enum: [
                      "view",
                    ],
                    description: "Mode for executing a database view's existing query",
                  },
                  view_url: {
                    type: "string",
                    description: "URL of a specific database view to query. Example: https://www.notion.so/workspace/db-id?v=view-id",
                  },
                  start_cursor: {
                    description: "Cursor for pagination. Use the next_cursor value from the previous response to get the next page.",
                    type: "string",
                    minLength: 1,
                    maxLength: 200,
                  },
                  page_size: {
                    description: "Number of rows to return per page (default: 100, max: 100).",
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                  },
                  is_archived: {
                    description: "Optional archive selector. Omitted or false queries non-archived rows only; true queries archived rows only.",
                    type: "boolean",
                  },
                },
                required: [
                  "mode",
                  "view_url",
                ],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  mode: {
                    type: "string",
                    enum: [
                      "rows",
                    ],
                    description: "Return data source rows with rich-text mentions, links, formatting, dates, and equations preserved.",
                  },
                  data_source_url: {
                    type: "string",
                    description: "One Notion data source URL obtained from a fetch result.",
                  },
                  filter: {
                    description: "Structured filter using exact property names from the data source schema. Supports an outer Boolean group plus one nested group level.",
                    type: "object",
                    properties: {
                      type: {
                        type: "string",
                        enum: [
                          "group",
                        ],
                        description: "Selects the filter or filter-value variant.",
                      },
                      operator: {
                        type: "string",
                        enum: [
                          "and",
                          "or",
                        ],
                        description: "Comparison or Boolean operation applied by this filter.",
                      },
                      filters: {
                        maxItems: 100,
                        type: "array",
                        items: {
                          anyOf: [
                            {
                              anyOf: [
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "is_empty",
                                        "is_not_empty",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                  ],
                                  additionalProperties: false,
                                  description: "Checks whether a property has any value.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "title",
                                        "text",
                                        "url",
                                        "email",
                                        "phone_number",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "string_is",
                                        "string_is_not",
                                        "string_contains",
                                        "string_does_not_contain",
                                        "string_starts_with",
                                        "string_ends_with",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                    value: {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "exact",
                                          ],
                                          description: "Selects the filter or filter-value variant.",
                                        },
                                        value: {
                                          type: "string",
                                          description: "Literal or relative value used by the filter.",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "value",
                                      ],
                                      additionalProperties: false,
                                      description: "Literal or relative value used by the filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "Property filter for text-like properties.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "number",
                                        "auto_increment_id",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "number_equals",
                                        "number_does_not_equal",
                                        "number_greater_than",
                                        "number_less_than",
                                        "number_greater_than_or_equal_to",
                                        "number_less_than_or_equal_to",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                    value: {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "exact",
                                          ],
                                          description: "Selects the filter or filter-value variant.",
                                        },
                                        value: {
                                          type: "number",
                                          description: "Literal or relative value used by the filter.",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "value",
                                      ],
                                      additionalProperties: false,
                                      description: "Literal or relative value used by the filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "Property filter for number properties.",
                                },
                                {
                                  anyOf: [
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "property",
                                          ],
                                          description: "Selects the filter or filter-value variant.",
                                        },
                                        property: {
                                          type: "string",
                                          description: "Exact data source property name to filter.",
                                        },
                                        propertyType: {
                                          type: "string",
                                          enum: [
                                            "date",
                                            "created_time",
                                            "last_edited_time",
                                            "last_visited_time",
                                          ],
                                          description: "Notion property type used to select valid operators and value shapes.",
                                        },
                                        operator: {
                                          type: "string",
                                          enum: [
                                            "date_is",
                                            "date_is_before",
                                            "date_is_after",
                                            "date_is_on_or_before",
                                            "date_is_on_or_after",
                                          ],
                                          description: "Comparison or Boolean operation applied by this filter.",
                                        },
                                        value: {
                                          anyOf: [
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "exact",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "string",
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "relative",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "string",
                                                  enum: [
                                                    "today",
                                                    "tomorrow",
                                                    "yesterday",
                                                    "one_week_ago",
                                                    "one_week_from_now",
                                                    "one_month_ago",
                                                    "one_month_from_now",
                                                  ],
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                          ],
                                          description: "Literal or relative value used by the filter.",
                                        },
                                        use_end: {
                                          description: "For a date property, compare its end date instead of its start date.",
                                          type: "boolean",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "property",
                                        "propertyType",
                                        "operator",
                                        "value",
                                      ],
                                      additionalProperties: false,
                                    },
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "property",
                                          ],
                                          description: "Selects the filter or filter-value variant.",
                                        },
                                        property: {
                                          type: "string",
                                          description: "Exact data source property name to filter.",
                                        },
                                        propertyType: {
                                          type: "string",
                                          enum: [
                                            "date",
                                            "created_time",
                                            "last_edited_time",
                                            "last_visited_time",
                                          ],
                                          description: "Notion property type used to select valid operators and value shapes.",
                                        },
                                        operator: {
                                          type: "string",
                                          enum: [
                                            "date_is_within",
                                            "date_is_relative_to",
                                          ],
                                          description: "Comparison or Boolean operation applied by this filter.",
                                        },
                                        value: {
                                          anyOf: [
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "exact",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "daterange",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    start_date: {
                                                      description: "ISO 8601 date or date-time at the start of the range.",
                                                      type: "string",
                                                    },
                                                    end_date: {
                                                      description: "ISO 8601 date or date-time at the end of the range.",
                                                      type: "string",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                  ],
                                                  additionalProperties: false,
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "relative",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "string",
                                                  enum: [
                                                    "custom",
                                                  ],
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                                direction: {
                                                  type: "string",
                                                  enum: [
                                                    "past",
                                                    "future",
                                                  ],
                                                  description: "Whether the custom range extends into the past or future.",
                                                },
                                                unit: {
                                                  type: "string",
                                                  enum: [
                                                    "year",
                                                    "month",
                                                    "week",
                                                    "day",
                                                  ],
                                                  description: "Time unit used to measure a relative date range.",
                                                },
                                                count: {
                                                  type: "number",
                                                  description: "Number of units in the custom relative range.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                                "direction",
                                                "unit",
                                                "count",
                                              ],
                                              additionalProperties: false,
                                            },
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "relative",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "string",
                                                  enum: [
                                                    "surrounding",
                                                  ],
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                                unit: {
                                                  type: "string",
                                                  enum: [
                                                    "year",
                                                    "month",
                                                    "week",
                                                    "day",
                                                  ],
                                                  description: "Time unit used to measure a relative date range.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                                "unit",
                                              ],
                                              additionalProperties: false,
                                            },
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "relative",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "string",
                                                  enum: [
                                                    "this_week",
                                                    "the_past_week",
                                                    "the_past_month",
                                                    "the_past_year",
                                                    "the_next_week",
                                                    "the_next_month",
                                                    "the_next_year",
                                                  ],
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                          ],
                                          description: "Literal or relative value used by the filter.",
                                        },
                                        use_end: {
                                          description: "For a date property, compare its end date instead of its start date.",
                                          type: "boolean",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "property",
                                        "propertyType",
                                        "operator",
                                        "value",
                                      ],
                                      additionalProperties: false,
                                    },
                                  ],
                                  description: "Property filter for date properties.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "select",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "enum_is",
                                        "enum_is_not",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                    value: {
                                      anyOf: [
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "exact",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            value: {
                                              type: "string",
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                        },
                                        {
                                          type: "array",
                                          items: {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "exact",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              value: {
                                                type: "string",
                                                description: "Literal or relative value used by the filter.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                        },
                                      ],
                                      description: "Literal or relative value used by the filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "Property filter for select properties by option name.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "multi_select",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "enum_contains",
                                        "enum_does_not_contain",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                    value: {
                                      anyOf: [
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "exact",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            value: {
                                              type: "string",
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                        },
                                        {
                                          type: "array",
                                          items: {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "exact",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              value: {
                                                type: "string",
                                                description: "Literal or relative value used by the filter.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                        },
                                      ],
                                      description: "Literal or relative value used by the filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "Property filter for multi-select properties.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "checkbox",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "checkbox_is",
                                        "checkbox_is_not",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                    value: {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "exact",
                                          ],
                                          description: "Selects the filter or filter-value variant.",
                                        },
                                        value: {
                                          type: "boolean",
                                          description: "Literal or relative value used by the filter.",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "value",
                                      ],
                                      additionalProperties: false,
                                      description: "Literal or relative value used by the filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "Property filter for checkbox properties.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "relation",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "relation_contains",
                                        "relation_does_not_contain",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                    value: {
                                      anyOf: [
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "exact",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            value: {
                                              type: "string",
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                        },
                                        {
                                          type: "array",
                                          items: {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "exact",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              value: {
                                                type: "string",
                                                description: "Literal or relative value used by the filter.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                        },
                                      ],
                                      description: "Literal or relative value used by the filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "Property filter for relation properties.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "status",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "status_is",
                                        "status_is_not",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                    value: {
                                      anyOf: [
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "is_group",
                                                "is_option",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            value: {
                                              type: "string",
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                        },
                                        {
                                          type: "array",
                                          items: {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "is_group",
                                                  "is_option",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              value: {
                                                type: "string",
                                                description: "Literal or relative value used by the filter.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                        },
                                      ],
                                      description: "Literal or relative value used by the filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "Property filter for status properties by option name.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "person",
                                        "created_by",
                                        "last_edited_by",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "person_contains",
                                        "person_does_not_contain",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                    value: {
                                      anyOf: [
                                        {
                                          anyOf: [
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "exact",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "string",
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "relative",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "string",
                                                  enum: [
                                                    "me",
                                                  ],
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                          ],
                                        },
                                        {
                                          type: "array",
                                          items: {
                                            anyOf: [
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "exact",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  value: {
                                                    type: "string",
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "relative",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  value: {
                                                    type: "string",
                                                    enum: [
                                                      "me",
                                                    ],
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                              },
                                            ],
                                          },
                                        },
                                      ],
                                      description: "Literal or relative value used by the filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "Property filter for person-like properties. Exact values use user://, bot://, organization_bot://, or space_permission_group:// URIs; relative values use me.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "verification",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      type: "string",
                                      enum: [
                                        "verification_is",
                                        "verification_is_not",
                                      ],
                                      description: "Comparison or Boolean operation applied by this filter.",
                                    },
                                    value: {
                                      anyOf: [
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "exact",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            value: {
                                              type: "string",
                                              enum: [
                                                "verified",
                                                "expired",
                                                "none",
                                              ],
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                        },
                                        {
                                          type: "array",
                                          items: {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "exact",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              value: {
                                                type: "string",
                                                enum: [
                                                  "verified",
                                                  "expired",
                                                  "none",
                                                ],
                                                description: "Literal or relative value used by the filter.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                        },
                                      ],
                                      description: "Literal or relative value used by the filter.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "operator",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "Property filter for page verification state.",
                                },
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "property",
                                      ],
                                      description: "Selects the filter or filter-value variant.",
                                    },
                                    property: {
                                      type: "string",
                                      description: "Exact data source property name to filter.",
                                    },
                                    propertyType: {
                                      type: "string",
                                      enum: [
                                        "formula",
                                      ],
                                      description: "Notion property type used to select valid operators and value shapes.",
                                    },
                                    operator: {
                                      description: "Comparison or Boolean operation applied by this filter.",
                                      type: "string",
                                      enum: [
                                        "any",
                                        "none",
                                        "every",
                                      ],
                                    },
                                    resultFilter: {
                                      anyOf: [
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "is_empty",
                                                "is_not_empty",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                          ],
                                          additionalProperties: false,
                                          description: "Checks whether a property has any value.",
                                        },
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              enum: [
                                                "title",
                                                "text",
                                                "url",
                                                "email",
                                                "phone_number",
                                              ],
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "string_is",
                                                "string_is_not",
                                                "string_contains",
                                                "string_does_not_contain",
                                                "string_starts_with",
                                                "string_ends_with",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                            value: {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "exact",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "string",
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                          description: "Property filter for text-like properties.",
                                        },
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              enum: [
                                                "number",
                                                "auto_increment_id",
                                              ],
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "number_equals",
                                                "number_does_not_equal",
                                                "number_greater_than",
                                                "number_less_than",
                                                "number_greater_than_or_equal_to",
                                                "number_less_than_or_equal_to",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                            value: {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "exact",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "number",
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                          description: "Property filter for number properties.",
                                        },
                                        {
                                          anyOf: [
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "property",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                property: {
                                                  type: "string",
                                                  description: "Exact data source property name to filter.",
                                                },
                                                propertyType: {
                                                  type: "string",
                                                  enum: [
                                                    "date",
                                                    "created_time",
                                                    "last_edited_time",
                                                    "last_visited_time",
                                                  ],
                                                  description: "Notion property type used to select valid operators and value shapes.",
                                                },
                                                operator: {
                                                  type: "string",
                                                  enum: [
                                                    "date_is",
                                                    "date_is_before",
                                                    "date_is_after",
                                                    "date_is_on_or_before",
                                                    "date_is_on_or_after",
                                                  ],
                                                  description: "Comparison or Boolean operation applied by this filter.",
                                                },
                                                value: {
                                                  anyOf: [
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "exact",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "string",
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "relative",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "string",
                                                          enum: [
                                                            "today",
                                                            "tomorrow",
                                                            "yesterday",
                                                            "one_week_ago",
                                                            "one_week_from_now",
                                                            "one_month_ago",
                                                            "one_month_from_now",
                                                          ],
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                  ],
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                                use_end: {
                                                  description: "For a date property, compare its end date instead of its start date.",
                                                  type: "boolean",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "property",
                                                "propertyType",
                                                "operator",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "property",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                property: {
                                                  type: "string",
                                                  description: "Exact data source property name to filter.",
                                                },
                                                propertyType: {
                                                  type: "string",
                                                  enum: [
                                                    "date",
                                                    "created_time",
                                                    "last_edited_time",
                                                    "last_visited_time",
                                                  ],
                                                  description: "Notion property type used to select valid operators and value shapes.",
                                                },
                                                operator: {
                                                  type: "string",
                                                  enum: [
                                                    "date_is_within",
                                                    "date_is_relative_to",
                                                  ],
                                                  description: "Comparison or Boolean operation applied by this filter.",
                                                },
                                                value: {
                                                  anyOf: [
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "exact",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "object",
                                                          properties: {
                                                            type: {
                                                              type: "string",
                                                              enum: [
                                                                "daterange",
                                                              ],
                                                              description: "Selects the filter or filter-value variant.",
                                                            },
                                                            start_date: {
                                                              description: "ISO 8601 date or date-time at the start of the range.",
                                                              type: "string",
                                                            },
                                                            end_date: {
                                                              description: "ISO 8601 date or date-time at the end of the range.",
                                                              type: "string",
                                                            },
                                                          },
                                                          required: [
                                                            "type",
                                                          ],
                                                          additionalProperties: false,
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "relative",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "string",
                                                          enum: [
                                                            "custom",
                                                          ],
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                        direction: {
                                                          type: "string",
                                                          enum: [
                                                            "past",
                                                            "future",
                                                          ],
                                                          description: "Whether the custom range extends into the past or future.",
                                                        },
                                                        unit: {
                                                          type: "string",
                                                          enum: [
                                                            "year",
                                                            "month",
                                                            "week",
                                                            "day",
                                                          ],
                                                          description: "Time unit used to measure a relative date range.",
                                                        },
                                                        count: {
                                                          type: "number",
                                                          description: "Number of units in the custom relative range.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                        "direction",
                                                        "unit",
                                                        "count",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "relative",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "string",
                                                          enum: [
                                                            "surrounding",
                                                          ],
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                        unit: {
                                                          type: "string",
                                                          enum: [
                                                            "year",
                                                            "month",
                                                            "week",
                                                            "day",
                                                          ],
                                                          description: "Time unit used to measure a relative date range.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                        "unit",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "relative",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "string",
                                                          enum: [
                                                            "this_week",
                                                            "the_past_week",
                                                            "the_past_month",
                                                            "the_past_year",
                                                            "the_next_week",
                                                            "the_next_month",
                                                            "the_next_year",
                                                          ],
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                  ],
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                                use_end: {
                                                  description: "For a date property, compare its end date instead of its start date.",
                                                  type: "boolean",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "property",
                                                "propertyType",
                                                "operator",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                          ],
                                          description: "Property filter for date properties.",
                                        },
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              enum: [
                                                "select",
                                              ],
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "enum_is",
                                                "enum_is_not",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                            value: {
                                              anyOf: [
                                                {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "exact",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                                {
                                                  type: "array",
                                                  items: {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                },
                                              ],
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                          description: "Property filter for select properties by option name.",
                                        },
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              enum: [
                                                "multi_select",
                                              ],
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "enum_contains",
                                                "enum_does_not_contain",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                            value: {
                                              anyOf: [
                                                {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "exact",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                                {
                                                  type: "array",
                                                  items: {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                },
                                              ],
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                          description: "Property filter for multi-select properties.",
                                        },
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              enum: [
                                                "checkbox",
                                              ],
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "checkbox_is",
                                                "checkbox_is_not",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                            value: {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "exact",
                                                  ],
                                                  description: "Selects the filter or filter-value variant.",
                                                },
                                                value: {
                                                  type: "boolean",
                                                  description: "Literal or relative value used by the filter.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                          description: "Property filter for checkbox properties.",
                                        },
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              enum: [
                                                "relation",
                                              ],
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "relation_contains",
                                                "relation_does_not_contain",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                            value: {
                                              anyOf: [
                                                {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "exact",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                                {
                                                  type: "array",
                                                  items: {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                },
                                              ],
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                          description: "Property filter for relation properties.",
                                        },
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              enum: [
                                                "status",
                                              ],
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "status_is",
                                                "status_is_not",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                            value: {
                                              anyOf: [
                                                {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "is_group",
                                                        "is_option",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                                {
                                                  type: "array",
                                                  items: {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "is_group",
                                                          "is_option",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                },
                                              ],
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                          description: "Property filter for status properties by option name.",
                                        },
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              enum: [
                                                "person",
                                                "created_by",
                                                "last_edited_by",
                                              ],
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "person_contains",
                                                "person_does_not_contain",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                            value: {
                                              anyOf: [
                                                {
                                                  anyOf: [
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "exact",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "string",
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "relative",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "string",
                                                          enum: [
                                                            "me",
                                                          ],
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                  ],
                                                },
                                                {
                                                  type: "array",
                                                  items: {
                                                    anyOf: [
                                                      {
                                                        type: "object",
                                                        properties: {
                                                          type: {
                                                            type: "string",
                                                            enum: [
                                                              "exact",
                                                            ],
                                                            description: "Selects the filter or filter-value variant.",
                                                          },
                                                          value: {
                                                            type: "string",
                                                            description: "Literal or relative value used by the filter.",
                                                          },
                                                        },
                                                        required: [
                                                          "type",
                                                          "value",
                                                        ],
                                                        additionalProperties: false,
                                                      },
                                                      {
                                                        type: "object",
                                                        properties: {
                                                          type: {
                                                            type: "string",
                                                            enum: [
                                                              "relative",
                                                            ],
                                                            description: "Selects the filter or filter-value variant.",
                                                          },
                                                          value: {
                                                            type: "string",
                                                            enum: [
                                                              "me",
                                                            ],
                                                            description: "Literal or relative value used by the filter.",
                                                          },
                                                        },
                                                        required: [
                                                          "type",
                                                          "value",
                                                        ],
                                                        additionalProperties: false,
                                                      },
                                                    ],
                                                  },
                                                },
                                              ],
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                          description: "Property filter for person-like properties. Exact values use user://, bot://, organization_bot://, or space_permission_group:// URIs; relative values use me.",
                                        },
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "property",
                                              ],
                                              description: "Selects the filter or filter-value variant.",
                                            },
                                            property: {
                                              type: "string",
                                              description: "Exact data source property name to filter.",
                                            },
                                            propertyType: {
                                              type: "string",
                                              enum: [
                                                "verification",
                                              ],
                                              description: "Notion property type used to select valid operators and value shapes.",
                                            },
                                            operator: {
                                              type: "string",
                                              enum: [
                                                "verification_is",
                                                "verification_is_not",
                                              ],
                                              description: "Comparison or Boolean operation applied by this filter.",
                                            },
                                            value: {
                                              anyOf: [
                                                {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "exact",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      enum: [
                                                        "verified",
                                                        "expired",
                                                        "none",
                                                      ],
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                                {
                                                  type: "array",
                                                  items: {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        enum: [
                                                          "verified",
                                                          "expired",
                                                          "none",
                                                        ],
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                },
                                              ],
                                              description: "Literal or relative value used by the filter.",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "property",
                                            "propertyType",
                                            "operator",
                                            "value",
                                          ],
                                          additionalProperties: false,
                                          description: "Property filter for page verification state.",
                                        },
                                      ],
                                      description: "Filter on the formula's result. The propertyType in the resultFilter should be the resultType of the formula.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "property",
                                    "propertyType",
                                    "resultFilter",
                                  ],
                                  additionalProperties: false,
                                  description: "Filter applied to a formula property.",
                                },
                              ],
                              description: "Filter applied to a single property.",
                            },
                            {
                              type: "object",
                              properties: {
                                type: {
                                  type: "string",
                                  enum: [
                                    "group",
                                  ],
                                  description: "Selects the filter or filter-value variant.",
                                },
                                operator: {
                                  type: "string",
                                  enum: [
                                    "and",
                                    "or",
                                  ],
                                  description: "Comparison or Boolean operation applied by this filter.",
                                },
                                filters: {
                                  maxItems: 100,
                                  type: "array",
                                  items: {
                                    anyOf: [
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "is_empty",
                                              "is_not_empty",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                        ],
                                        additionalProperties: false,
                                        description: "Checks whether a property has any value.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "title",
                                              "text",
                                              "url",
                                              "email",
                                              "phone_number",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "string_is",
                                              "string_is_not",
                                              "string_contains",
                                              "string_does_not_contain",
                                              "string_starts_with",
                                              "string_ends_with",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                          value: {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "exact",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              value: {
                                                type: "string",
                                                description: "Literal or relative value used by the filter.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                            description: "Literal or relative value used by the filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "Property filter for text-like properties.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "number",
                                              "auto_increment_id",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "number_equals",
                                              "number_does_not_equal",
                                              "number_greater_than",
                                              "number_less_than",
                                              "number_greater_than_or_equal_to",
                                              "number_less_than_or_equal_to",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                          value: {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "exact",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              value: {
                                                type: "number",
                                                description: "Literal or relative value used by the filter.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                            description: "Literal or relative value used by the filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "Property filter for number properties.",
                                      },
                                      {
                                        anyOf: [
                                          {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "property",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              property: {
                                                type: "string",
                                                description: "Exact data source property name to filter.",
                                              },
                                              propertyType: {
                                                type: "string",
                                                enum: [
                                                  "date",
                                                  "created_time",
                                                  "last_edited_time",
                                                  "last_visited_time",
                                                ],
                                                description: "Notion property type used to select valid operators and value shapes.",
                                              },
                                              operator: {
                                                type: "string",
                                                enum: [
                                                  "date_is",
                                                  "date_is_before",
                                                  "date_is_after",
                                                  "date_is_on_or_before",
                                                  "date_is_on_or_after",
                                                ],
                                                description: "Comparison or Boolean operation applied by this filter.",
                                              },
                                              value: {
                                                anyOf: [
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "relative",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        enum: [
                                                          "today",
                                                          "tomorrow",
                                                          "yesterday",
                                                          "one_week_ago",
                                                          "one_week_from_now",
                                                          "one_month_ago",
                                                          "one_month_from_now",
                                                        ],
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                ],
                                                description: "Literal or relative value used by the filter.",
                                              },
                                              use_end: {
                                                description: "For a date property, compare its end date instead of its start date.",
                                                type: "boolean",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "property",
                                              "propertyType",
                                              "operator",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                          {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "property",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              property: {
                                                type: "string",
                                                description: "Exact data source property name to filter.",
                                              },
                                              propertyType: {
                                                type: "string",
                                                enum: [
                                                  "date",
                                                  "created_time",
                                                  "last_edited_time",
                                                  "last_visited_time",
                                                ],
                                                description: "Notion property type used to select valid operators and value shapes.",
                                              },
                                              operator: {
                                                type: "string",
                                                enum: [
                                                  "date_is_within",
                                                  "date_is_relative_to",
                                                ],
                                                description: "Comparison or Boolean operation applied by this filter.",
                                              },
                                              value: {
                                                anyOf: [
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "object",
                                                        properties: {
                                                          type: {
                                                            type: "string",
                                                            enum: [
                                                              "daterange",
                                                            ],
                                                            description: "Selects the filter or filter-value variant.",
                                                          },
                                                          start_date: {
                                                            description: "ISO 8601 date or date-time at the start of the range.",
                                                            type: "string",
                                                          },
                                                          end_date: {
                                                            description: "ISO 8601 date or date-time at the end of the range.",
                                                            type: "string",
                                                          },
                                                        },
                                                        required: [
                                                          "type",
                                                        ],
                                                        additionalProperties: false,
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "relative",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        enum: [
                                                          "custom",
                                                        ],
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                      direction: {
                                                        type: "string",
                                                        enum: [
                                                          "past",
                                                          "future",
                                                        ],
                                                        description: "Whether the custom range extends into the past or future.",
                                                      },
                                                      unit: {
                                                        type: "string",
                                                        enum: [
                                                          "year",
                                                          "month",
                                                          "week",
                                                          "day",
                                                        ],
                                                        description: "Time unit used to measure a relative date range.",
                                                      },
                                                      count: {
                                                        type: "number",
                                                        description: "Number of units in the custom relative range.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                      "direction",
                                                      "unit",
                                                      "count",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "relative",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        enum: [
                                                          "surrounding",
                                                        ],
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                      unit: {
                                                        type: "string",
                                                        enum: [
                                                          "year",
                                                          "month",
                                                          "week",
                                                          "day",
                                                        ],
                                                        description: "Time unit used to measure a relative date range.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                      "unit",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "relative",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        enum: [
                                                          "this_week",
                                                          "the_past_week",
                                                          "the_past_month",
                                                          "the_past_year",
                                                          "the_next_week",
                                                          "the_next_month",
                                                          "the_next_year",
                                                        ],
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                ],
                                                description: "Literal or relative value used by the filter.",
                                              },
                                              use_end: {
                                                description: "For a date property, compare its end date instead of its start date.",
                                                type: "boolean",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "property",
                                              "propertyType",
                                              "operator",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                        ],
                                        description: "Property filter for date properties.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "select",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "enum_is",
                                              "enum_is_not",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                          value: {
                                            anyOf: [
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "exact",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  value: {
                                                    type: "string",
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                              },
                                              {
                                                type: "array",
                                                items: {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "exact",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                              },
                                            ],
                                            description: "Literal or relative value used by the filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "Property filter for select properties by option name.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "multi_select",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "enum_contains",
                                              "enum_does_not_contain",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                          value: {
                                            anyOf: [
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "exact",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  value: {
                                                    type: "string",
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                              },
                                              {
                                                type: "array",
                                                items: {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "exact",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                              },
                                            ],
                                            description: "Literal or relative value used by the filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "Property filter for multi-select properties.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "checkbox",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "checkbox_is",
                                              "checkbox_is_not",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                          value: {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "exact",
                                                ],
                                                description: "Selects the filter or filter-value variant.",
                                              },
                                              value: {
                                                type: "boolean",
                                                description: "Literal or relative value used by the filter.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                            description: "Literal or relative value used by the filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "Property filter for checkbox properties.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "relation",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "relation_contains",
                                              "relation_does_not_contain",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                          value: {
                                            anyOf: [
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "exact",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  value: {
                                                    type: "string",
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                              },
                                              {
                                                type: "array",
                                                items: {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "exact",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                              },
                                            ],
                                            description: "Literal or relative value used by the filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "Property filter for relation properties.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "status",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "status_is",
                                              "status_is_not",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                          value: {
                                            anyOf: [
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "is_group",
                                                      "is_option",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  value: {
                                                    type: "string",
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                              },
                                              {
                                                type: "array",
                                                items: {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "is_group",
                                                        "is_option",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                              },
                                            ],
                                            description: "Literal or relative value used by the filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "Property filter for status properties by option name.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "person",
                                              "created_by",
                                              "last_edited_by",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "person_contains",
                                              "person_does_not_contain",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                          value: {
                                            anyOf: [
                                              {
                                                anyOf: [
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "relative",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        enum: [
                                                          "me",
                                                        ],
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                ],
                                              },
                                              {
                                                type: "array",
                                                items: {
                                                  anyOf: [
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "exact",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "string",
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                    {
                                                      type: "object",
                                                      properties: {
                                                        type: {
                                                          type: "string",
                                                          enum: [
                                                            "relative",
                                                          ],
                                                          description: "Selects the filter or filter-value variant.",
                                                        },
                                                        value: {
                                                          type: "string",
                                                          enum: [
                                                            "me",
                                                          ],
                                                          description: "Literal or relative value used by the filter.",
                                                        },
                                                      },
                                                      required: [
                                                        "type",
                                                        "value",
                                                      ],
                                                      additionalProperties: false,
                                                    },
                                                  ],
                                                },
                                              },
                                            ],
                                            description: "Literal or relative value used by the filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "Property filter for person-like properties. Exact values use user://, bot://, organization_bot://, or space_permission_group:// URIs; relative values use me.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "verification",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            type: "string",
                                            enum: [
                                              "verification_is",
                                              "verification_is_not",
                                            ],
                                            description: "Comparison or Boolean operation applied by this filter.",
                                          },
                                          value: {
                                            anyOf: [
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "exact",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  value: {
                                                    type: "string",
                                                    enum: [
                                                      "verified",
                                                      "expired",
                                                      "none",
                                                    ],
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                              },
                                              {
                                                type: "array",
                                                items: {
                                                  type: "object",
                                                  properties: {
                                                    type: {
                                                      type: "string",
                                                      enum: [
                                                        "exact",
                                                      ],
                                                      description: "Selects the filter or filter-value variant.",
                                                    },
                                                    value: {
                                                      type: "string",
                                                      enum: [
                                                        "verified",
                                                        "expired",
                                                        "none",
                                                      ],
                                                      description: "Literal or relative value used by the filter.",
                                                    },
                                                  },
                                                  required: [
                                                    "type",
                                                    "value",
                                                  ],
                                                  additionalProperties: false,
                                                },
                                              },
                                            ],
                                            description: "Literal or relative value used by the filter.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "operator",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "Property filter for page verification state.",
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "property",
                                            ],
                                            description: "Selects the filter or filter-value variant.",
                                          },
                                          property: {
                                            type: "string",
                                            description: "Exact data source property name to filter.",
                                          },
                                          propertyType: {
                                            type: "string",
                                            enum: [
                                              "formula",
                                            ],
                                            description: "Notion property type used to select valid operators and value shapes.",
                                          },
                                          operator: {
                                            description: "Comparison or Boolean operation applied by this filter.",
                                            type: "string",
                                            enum: [
                                              "any",
                                              "none",
                                              "every",
                                            ],
                                          },
                                          resultFilter: {
                                            anyOf: [
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "is_empty",
                                                      "is_not_empty",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                ],
                                                additionalProperties: false,
                                                description: "Checks whether a property has any value.",
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    enum: [
                                                      "title",
                                                      "text",
                                                      "url",
                                                      "email",
                                                      "phone_number",
                                                    ],
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "string_is",
                                                      "string_is_not",
                                                      "string_contains",
                                                      "string_does_not_contain",
                                                      "string_starts_with",
                                                      "string_ends_with",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                  value: {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "string",
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                                description: "Property filter for text-like properties.",
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    enum: [
                                                      "number",
                                                      "auto_increment_id",
                                                    ],
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "number_equals",
                                                      "number_does_not_equal",
                                                      "number_greater_than",
                                                      "number_less_than",
                                                      "number_greater_than_or_equal_to",
                                                      "number_less_than_or_equal_to",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                  value: {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "number",
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                                description: "Property filter for number properties.",
                                              },
                                              {
                                                anyOf: [
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "property",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      property: {
                                                        type: "string",
                                                        description: "Exact data source property name to filter.",
                                                      },
                                                      propertyType: {
                                                        type: "string",
                                                        enum: [
                                                          "date",
                                                          "created_time",
                                                          "last_edited_time",
                                                          "last_visited_time",
                                                        ],
                                                        description: "Notion property type used to select valid operators and value shapes.",
                                                      },
                                                      operator: {
                                                        type: "string",
                                                        enum: [
                                                          "date_is",
                                                          "date_is_before",
                                                          "date_is_after",
                                                          "date_is_on_or_before",
                                                          "date_is_on_or_after",
                                                        ],
                                                        description: "Comparison or Boolean operation applied by this filter.",
                                                      },
                                                      value: {
                                                        anyOf: [
                                                          {
                                                            type: "object",
                                                            properties: {
                                                              type: {
                                                                type: "string",
                                                                enum: [
                                                                  "exact",
                                                                ],
                                                                description: "Selects the filter or filter-value variant.",
                                                              },
                                                              value: {
                                                                type: "string",
                                                                description: "Literal or relative value used by the filter.",
                                                              },
                                                            },
                                                            required: [
                                                              "type",
                                                              "value",
                                                            ],
                                                            additionalProperties: false,
                                                          },
                                                          {
                                                            type: "object",
                                                            properties: {
                                                              type: {
                                                                type: "string",
                                                                enum: [
                                                                  "relative",
                                                                ],
                                                                description: "Selects the filter or filter-value variant.",
                                                              },
                                                              value: {
                                                                type: "string",
                                                                enum: [
                                                                  "today",
                                                                  "tomorrow",
                                                                  "yesterday",
                                                                  "one_week_ago",
                                                                  "one_week_from_now",
                                                                  "one_month_ago",
                                                                  "one_month_from_now",
                                                                ],
                                                                description: "Literal or relative value used by the filter.",
                                                              },
                                                            },
                                                            required: [
                                                              "type",
                                                              "value",
                                                            ],
                                                            additionalProperties: false,
                                                          },
                                                        ],
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                      use_end: {
                                                        description: "For a date property, compare its end date instead of its start date.",
                                                        type: "boolean",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "property",
                                                      "propertyType",
                                                      "operator",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "property",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      property: {
                                                        type: "string",
                                                        description: "Exact data source property name to filter.",
                                                      },
                                                      propertyType: {
                                                        type: "string",
                                                        enum: [
                                                          "date",
                                                          "created_time",
                                                          "last_edited_time",
                                                          "last_visited_time",
                                                        ],
                                                        description: "Notion property type used to select valid operators and value shapes.",
                                                      },
                                                      operator: {
                                                        type: "string",
                                                        enum: [
                                                          "date_is_within",
                                                          "date_is_relative_to",
                                                        ],
                                                        description: "Comparison or Boolean operation applied by this filter.",
                                                      },
                                                      value: {
                                                        anyOf: [
                                                          {
                                                            type: "object",
                                                            properties: {
                                                              type: {
                                                                type: "string",
                                                                enum: [
                                                                  "exact",
                                                                ],
                                                                description: "Selects the filter or filter-value variant.",
                                                              },
                                                              value: {
                                                                type: "object",
                                                                properties: {
                                                                  type: {
                                                                    type: "string",
                                                                    enum: [
                                                                      "daterange",
                                                                    ],
                                                                    description: "Selects the filter or filter-value variant.",
                                                                  },
                                                                  start_date: {
                                                                    description: "ISO 8601 date or date-time at the start of the range.",
                                                                    type: "string",
                                                                  },
                                                                  end_date: {
                                                                    description: "ISO 8601 date or date-time at the end of the range.",
                                                                    type: "string",
                                                                  },
                                                                },
                                                                required: [
                                                                  "type",
                                                                ],
                                                                additionalProperties: false,
                                                                description: "Literal or relative value used by the filter.",
                                                              },
                                                            },
                                                            required: [
                                                              "type",
                                                              "value",
                                                            ],
                                                            additionalProperties: false,
                                                          },
                                                          {
                                                            type: "object",
                                                            properties: {
                                                              type: {
                                                                type: "string",
                                                                enum: [
                                                                  "relative",
                                                                ],
                                                                description: "Selects the filter or filter-value variant.",
                                                              },
                                                              value: {
                                                                type: "string",
                                                                enum: [
                                                                  "custom",
                                                                ],
                                                                description: "Literal or relative value used by the filter.",
                                                              },
                                                              direction: {
                                                                type: "string",
                                                                enum: [
                                                                  "past",
                                                                  "future",
                                                                ],
                                                                description: "Whether the custom range extends into the past or future.",
                                                              },
                                                              unit: {
                                                                type: "string",
                                                                enum: [
                                                                  "year",
                                                                  "month",
                                                                  "week",
                                                                  "day",
                                                                ],
                                                                description: "Time unit used to measure a relative date range.",
                                                              },
                                                              count: {
                                                                type: "number",
                                                                description: "Number of units in the custom relative range.",
                                                              },
                                                            },
                                                            required: [
                                                              "type",
                                                              "value",
                                                              "direction",
                                                              "unit",
                                                              "count",
                                                            ],
                                                            additionalProperties: false,
                                                          },
                                                          {
                                                            type: "object",
                                                            properties: {
                                                              type: {
                                                                type: "string",
                                                                enum: [
                                                                  "relative",
                                                                ],
                                                                description: "Selects the filter or filter-value variant.",
                                                              },
                                                              value: {
                                                                type: "string",
                                                                enum: [
                                                                  "surrounding",
                                                                ],
                                                                description: "Literal or relative value used by the filter.",
                                                              },
                                                              unit: {
                                                                type: "string",
                                                                enum: [
                                                                  "year",
                                                                  "month",
                                                                  "week",
                                                                  "day",
                                                                ],
                                                                description: "Time unit used to measure a relative date range.",
                                                              },
                                                            },
                                                            required: [
                                                              "type",
                                                              "value",
                                                              "unit",
                                                            ],
                                                            additionalProperties: false,
                                                          },
                                                          {
                                                            type: "object",
                                                            properties: {
                                                              type: {
                                                                type: "string",
                                                                enum: [
                                                                  "relative",
                                                                ],
                                                                description: "Selects the filter or filter-value variant.",
                                                              },
                                                              value: {
                                                                type: "string",
                                                                enum: [
                                                                  "this_week",
                                                                  "the_past_week",
                                                                  "the_past_month",
                                                                  "the_past_year",
                                                                  "the_next_week",
                                                                  "the_next_month",
                                                                  "the_next_year",
                                                                ],
                                                                description: "Literal or relative value used by the filter.",
                                                              },
                                                            },
                                                            required: [
                                                              "type",
                                                              "value",
                                                            ],
                                                            additionalProperties: false,
                                                          },
                                                        ],
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                      use_end: {
                                                        description: "For a date property, compare its end date instead of its start date.",
                                                        type: "boolean",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "property",
                                                      "propertyType",
                                                      "operator",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                ],
                                                description: "Property filter for date properties.",
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    enum: [
                                                      "select",
                                                    ],
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "enum_is",
                                                      "enum_is_not",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                  value: {
                                                    anyOf: [
                                                      {
                                                        type: "object",
                                                        properties: {
                                                          type: {
                                                            type: "string",
                                                            enum: [
                                                              "exact",
                                                            ],
                                                            description: "Selects the filter or filter-value variant.",
                                                          },
                                                          value: {
                                                            type: "string",
                                                            description: "Literal or relative value used by the filter.",
                                                          },
                                                        },
                                                        required: [
                                                          "type",
                                                          "value",
                                                        ],
                                                        additionalProperties: false,
                                                      },
                                                      {
                                                        type: "array",
                                                        items: {
                                                          type: "object",
                                                          properties: {
                                                            type: {
                                                              type: "string",
                                                              enum: [
                                                                "exact",
                                                              ],
                                                              description: "Selects the filter or filter-value variant.",
                                                            },
                                                            value: {
                                                              type: "string",
                                                              description: "Literal or relative value used by the filter.",
                                                            },
                                                          },
                                                          required: [
                                                            "type",
                                                            "value",
                                                          ],
                                                          additionalProperties: false,
                                                        },
                                                      },
                                                    ],
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                                description: "Property filter for select properties by option name.",
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    enum: [
                                                      "multi_select",
                                                    ],
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "enum_contains",
                                                      "enum_does_not_contain",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                  value: {
                                                    anyOf: [
                                                      {
                                                        type: "object",
                                                        properties: {
                                                          type: {
                                                            type: "string",
                                                            enum: [
                                                              "exact",
                                                            ],
                                                            description: "Selects the filter or filter-value variant.",
                                                          },
                                                          value: {
                                                            type: "string",
                                                            description: "Literal or relative value used by the filter.",
                                                          },
                                                        },
                                                        required: [
                                                          "type",
                                                          "value",
                                                        ],
                                                        additionalProperties: false,
                                                      },
                                                      {
                                                        type: "array",
                                                        items: {
                                                          type: "object",
                                                          properties: {
                                                            type: {
                                                              type: "string",
                                                              enum: [
                                                                "exact",
                                                              ],
                                                              description: "Selects the filter or filter-value variant.",
                                                            },
                                                            value: {
                                                              type: "string",
                                                              description: "Literal or relative value used by the filter.",
                                                            },
                                                          },
                                                          required: [
                                                            "type",
                                                            "value",
                                                          ],
                                                          additionalProperties: false,
                                                        },
                                                      },
                                                    ],
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                                description: "Property filter for multi-select properties.",
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    enum: [
                                                      "checkbox",
                                                    ],
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "checkbox_is",
                                                      "checkbox_is_not",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                  value: {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "exact",
                                                        ],
                                                        description: "Selects the filter or filter-value variant.",
                                                      },
                                                      value: {
                                                        type: "boolean",
                                                        description: "Literal or relative value used by the filter.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "value",
                                                    ],
                                                    additionalProperties: false,
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                                description: "Property filter for checkbox properties.",
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    enum: [
                                                      "relation",
                                                    ],
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "relation_contains",
                                                      "relation_does_not_contain",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                  value: {
                                                    anyOf: [
                                                      {
                                                        type: "object",
                                                        properties: {
                                                          type: {
                                                            type: "string",
                                                            enum: [
                                                              "exact",
                                                            ],
                                                            description: "Selects the filter or filter-value variant.",
                                                          },
                                                          value: {
                                                            type: "string",
                                                            description: "Literal or relative value used by the filter.",
                                                          },
                                                        },
                                                        required: [
                                                          "type",
                                                          "value",
                                                        ],
                                                        additionalProperties: false,
                                                      },
                                                      {
                                                        type: "array",
                                                        items: {
                                                          type: "object",
                                                          properties: {
                                                            type: {
                                                              type: "string",
                                                              enum: [
                                                                "exact",
                                                              ],
                                                              description: "Selects the filter or filter-value variant.",
                                                            },
                                                            value: {
                                                              type: "string",
                                                              description: "Literal or relative value used by the filter.",
                                                            },
                                                          },
                                                          required: [
                                                            "type",
                                                            "value",
                                                          ],
                                                          additionalProperties: false,
                                                        },
                                                      },
                                                    ],
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                                description: "Property filter for relation properties.",
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    enum: [
                                                      "status",
                                                    ],
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "status_is",
                                                      "status_is_not",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                  value: {
                                                    anyOf: [
                                                      {
                                                        type: "object",
                                                        properties: {
                                                          type: {
                                                            type: "string",
                                                            enum: [
                                                              "is_group",
                                                              "is_option",
                                                            ],
                                                            description: "Selects the filter or filter-value variant.",
                                                          },
                                                          value: {
                                                            type: "string",
                                                            description: "Literal or relative value used by the filter.",
                                                          },
                                                        },
                                                        required: [
                                                          "type",
                                                          "value",
                                                        ],
                                                        additionalProperties: false,
                                                      },
                                                      {
                                                        type: "array",
                                                        items: {
                                                          type: "object",
                                                          properties: {
                                                            type: {
                                                              type: "string",
                                                              enum: [
                                                                "is_group",
                                                                "is_option",
                                                              ],
                                                              description: "Selects the filter or filter-value variant.",
                                                            },
                                                            value: {
                                                              type: "string",
                                                              description: "Literal or relative value used by the filter.",
                                                            },
                                                          },
                                                          required: [
                                                            "type",
                                                            "value",
                                                          ],
                                                          additionalProperties: false,
                                                        },
                                                      },
                                                    ],
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                                description: "Property filter for status properties by option name.",
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    enum: [
                                                      "person",
                                                      "created_by",
                                                      "last_edited_by",
                                                    ],
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "person_contains",
                                                      "person_does_not_contain",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                  value: {
                                                    anyOf: [
                                                      {
                                                        anyOf: [
                                                          {
                                                            type: "object",
                                                            properties: {
                                                              type: {
                                                                type: "string",
                                                                enum: [
                                                                  "exact",
                                                                ],
                                                                description: "Selects the filter or filter-value variant.",
                                                              },
                                                              value: {
                                                                type: "string",
                                                                description: "Literal or relative value used by the filter.",
                                                              },
                                                            },
                                                            required: [
                                                              "type",
                                                              "value",
                                                            ],
                                                            additionalProperties: false,
                                                          },
                                                          {
                                                            type: "object",
                                                            properties: {
                                                              type: {
                                                                type: "string",
                                                                enum: [
                                                                  "relative",
                                                                ],
                                                                description: "Selects the filter or filter-value variant.",
                                                              },
                                                              value: {
                                                                type: "string",
                                                                enum: [
                                                                  "me",
                                                                ],
                                                                description: "Literal or relative value used by the filter.",
                                                              },
                                                            },
                                                            required: [
                                                              "type",
                                                              "value",
                                                            ],
                                                            additionalProperties: false,
                                                          },
                                                        ],
                                                      },
                                                      {
                                                        type: "array",
                                                        items: {
                                                          anyOf: [
                                                            {
                                                              type: "object",
                                                              properties: {
                                                                type: {
                                                                  type: "string",
                                                                  enum: [
                                                                    "exact",
                                                                  ],
                                                                  description: "Selects the filter or filter-value variant.",
                                                                },
                                                                value: {
                                                                  type: "string",
                                                                  description: "Literal or relative value used by the filter.",
                                                                },
                                                              },
                                                              required: [
                                                                "type",
                                                                "value",
                                                              ],
                                                              additionalProperties: false,
                                                            },
                                                            {
                                                              type: "object",
                                                              properties: {
                                                                type: {
                                                                  type: "string",
                                                                  enum: [
                                                                    "relative",
                                                                  ],
                                                                  description: "Selects the filter or filter-value variant.",
                                                                },
                                                                value: {
                                                                  type: "string",
                                                                  enum: [
                                                                    "me",
                                                                  ],
                                                                  description: "Literal or relative value used by the filter.",
                                                                },
                                                              },
                                                              required: [
                                                                "type",
                                                                "value",
                                                              ],
                                                              additionalProperties: false,
                                                            },
                                                          ],
                                                        },
                                                      },
                                                    ],
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                                description: "Property filter for person-like properties. Exact values use user://, bot://, organization_bot://, or space_permission_group:// URIs; relative values use me.",
                                              },
                                              {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "property",
                                                    ],
                                                    description: "Selects the filter or filter-value variant.",
                                                  },
                                                  property: {
                                                    type: "string",
                                                    description: "Exact data source property name to filter.",
                                                  },
                                                  propertyType: {
                                                    type: "string",
                                                    enum: [
                                                      "verification",
                                                    ],
                                                    description: "Notion property type used to select valid operators and value shapes.",
                                                  },
                                                  operator: {
                                                    type: "string",
                                                    enum: [
                                                      "verification_is",
                                                      "verification_is_not",
                                                    ],
                                                    description: "Comparison or Boolean operation applied by this filter.",
                                                  },
                                                  value: {
                                                    anyOf: [
                                                      {
                                                        type: "object",
                                                        properties: {
                                                          type: {
                                                            type: "string",
                                                            enum: [
                                                              "exact",
                                                            ],
                                                            description: "Selects the filter or filter-value variant.",
                                                          },
                                                          value: {
                                                            type: "string",
                                                            enum: [
                                                              "verified",
                                                              "expired",
                                                              "none",
                                                            ],
                                                            description: "Literal or relative value used by the filter.",
                                                          },
                                                        },
                                                        required: [
                                                          "type",
                                                          "value",
                                                        ],
                                                        additionalProperties: false,
                                                      },
                                                      {
                                                        type: "array",
                                                        items: {
                                                          type: "object",
                                                          properties: {
                                                            type: {
                                                              type: "string",
                                                              enum: [
                                                                "exact",
                                                              ],
                                                              description: "Selects the filter or filter-value variant.",
                                                            },
                                                            value: {
                                                              type: "string",
                                                              enum: [
                                                                "verified",
                                                                "expired",
                                                                "none",
                                                              ],
                                                              description: "Literal or relative value used by the filter.",
                                                            },
                                                          },
                                                          required: [
                                                            "type",
                                                            "value",
                                                          ],
                                                          additionalProperties: false,
                                                        },
                                                      },
                                                    ],
                                                    description: "Literal or relative value used by the filter.",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                  "property",
                                                  "propertyType",
                                                  "operator",
                                                  "value",
                                                ],
                                                additionalProperties: false,
                                                description: "Property filter for page verification state.",
                                              },
                                            ],
                                            description: "Filter on the formula's result. The propertyType in the resultFilter should be the resultType of the formula.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "property",
                                          "propertyType",
                                          "resultFilter",
                                        ],
                                        additionalProperties: false,
                                        description: "Filter applied to a formula property.",
                                      },
                                    ],
                                    description: "Filter applied to a single property.",
                                  },
                                  description: "Child filters combined by the Boolean group operator.",
                                },
                              },
                              required: [
                                "type",
                                "operator",
                                "filters",
                              ],
                              additionalProperties: false,
                            },
                          ],
                        },
                        description: "Child filters combined by the Boolean group operator.",
                      },
                    },
                    required: [
                      "type",
                      "operator",
                      "filters",
                    ],
                    additionalProperties: false,
                  },
                  sort: {
                    description: "Structured property sorts applied in order.",
                    maxItems: 100,
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        property: {
                          type: "string",
                          description: "Exact data source property name to sort.",
                        },
                        direction: {
                          type: "string",
                          enum: [
                            "ascending",
                            "descending",
                          ],
                          description: "One of: `ascending`, `descending`",
                        },
                      },
                      required: [
                        "property",
                        "direction",
                      ],
                      additionalProperties: false,
                    },
                  },
                  limit: {
                    description: "Number of rows to return (default: 50, max: 100).",
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                  },
                },
                required: [
                  "mode",
                  "data_source_url",
                ],
                additionalProperties: false,
              },
            ],
          },
        },
        required: [
          "data",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-query-multiple-data-sources",
      "Query across Notion data sources.",
      'read',
      {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Read-only SQLite query to execute against the data sources. Use a data source URL as the table name, e.g. SELECT * FROM \"collection://...\" WHERE .... Use only table and column names shown in the fetched `<sqlite-table>` definition; date properties use the expanded column names listed there, not the base name. Include every needed filter in WHERE (filters on views of the data source are not automatically applied). For time comparisons or ordering, normalize text timestamps with datetime(...) or date(...). SQL text values can omit rich-text mentions and formatting, and links can lose their destination. Use faithful rows mode or fetch the page before rewriting a rich-text property.",
          },
          data_source_urls: {
            description: "Notion data source URLs whose SQLite tables are available to the query; each data source is exposed as a table named by its URL. Obtain them from the fetch tool, in the format: collection://f336d0bc-b841-465b-8045-024475c079dd",
            minItems: 2,
            maxItems: 100,
            type: "array",
            items: {
              type: "string",
            },
          },
          params: {
            description: "Positional parameters bound to `?` placeholders in the query. Prefer parameterized queries over string interpolation. Use \"__YES__\" for checked checkboxes and \"__NO__\" for unchecked checkboxes.",
            maxItems: 100,
            type: "array",
            items: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "number",
                },
                {
                  type: "boolean",
                },
                {
                  type: "null",
                },
              ],
            },
          },
          mode: {
            description: "Optional SQL mode marker. This tool only supports SQL queries.",
            type: "string",
            enum: [
              "sql",
            ],
          },
        },
        required: [
          "query",
          "data_source_urls",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-query-meeting-notes",
      "Query the connected user’s meeting notes.",
      'read',
      {
        type: "object",
        properties: {
          filter: {
            description: "Meeting note filter reference.\n\nTitle keyword searching uses a filter on property \"title\" (for example, string_contains). Returns up to 50 rows of matching meeting notes.\n\nFilterable properties:\n- \"title\" (text) — meeting title\n- \"attendees\" (person) — meeting attendees\n- \"created_time\" (date) — when the meeting note was created\n- \"created_by\" (person) — who created the meeting note\n- \"last_edited_time\" (date) — when the meeting note was last edited\n- \"last_edited_by\" (person) — who last edited the meeting note\n\n\nCombinator filters use \"filters\" (not \"operands\"): { \"operator\": \"and\" | \"or\", \"filters\": [ ... ] }\n\nDate filtering (recommended default: date_is_within):\n- Prefer \"date_is_within\" for relative windows like \"past N days/weeks/months\".\n- Relative (common): { type: \"relative\", value: \"the_past_week\" | \"the_past_month\" | \"this_week\" }\n- Relative (custom): { type: \"relative\", value: \"custom\", direction: \"past\" | \"future\", unit: \"day\" | \"week\" | \"month\" | \"year\", count: <number> }\n- Exact range: { type: \"exact\", value: { type: \"daterange\", start_date: \"YYYY-MM-DD\", end_date: \"YYYY-MM-DD\" } }\n- Single-date operators (\"date_is\", \"date_is_before\", \"date_is_after\", \"date_is_on_or_before\", \"date_is_on_or_after\"):\n- Exact: { type: \"exact\", value: { type: \"date\", start_date: \"YYYY-MM-DD\" } }\n- Relative shortcuts: today | tomorrow | yesterday | one_week_ago | one_week_from_now | one_month_ago | one_month_from_now\n\n\nTitle keyword filtering (OR vs AND):\n- Use OR (\"operator\": \"or\") when unsure or for broad discovery.\n- Use AND (\"operator\": \"and\") when the user is specific and you want to narrow results.\n- Break multi-word phrases into individual terms and filter on each term separately.\n\n\nExamples:\n- Past week: <example>{\"operator\":\"and\",\"filters\":[{\"property\":\"created_time\",\"filter\":{\"operator\":\"date_is_within\",\"value\":{\"type\":\"relative\",\"value\":\"the_past_week\"}}}]}</example>\n- Past 3 days: <example>{\"operator\":\"and\",\"filters\":[{\"property\":\"created_time\",\"filter\":{\"operator\":\"date_is_within\",\"value\":{\"type\":\"relative\",\"value\":\"custom\",\"direction\":\"past\",\"unit\":\"day\",\"count\":3}}}]}</example>\n- Exact date range: <example>{\"operator\":\"and\",\"filters\":[{\"property\":\"created_time\",\"filter\":{\"operator\":\"date_is_within\",\"value\":{\"type\":\"exact\",\"value\":{\"type\":\"daterange\",\"start_date\":\"2025-01-01\",\"end_date\":\"2025-12-31\"}}}}]}</example>\n- Created after a date: <example>{\"operator\":\"and\",\"filters\":[{\"property\":\"created_time\",\"filter\":{\"operator\":\"date_is_after\",\"value\":{\"type\":\"exact\",\"value\":{\"type\":\"date\",\"start_date\":\"2025-06-01\"}}}}]}</example>\n- Specific attendee: <example>{\"operator\":\"and\",\"filters\":[{\"property\":\"attendees\",\"filter\":{\"operator\":\"person_contains\",\"value\":[{\"type\":\"exact\",\"value\":{\"table\":\"notion_user\",\"id\":\"<user-id>\"}}]}}]}</example>\n- Attendee since a date: <example>{\"operator\":\"and\",\"filters\":[{\"property\":\"created_time\",\"filter\":{\"operator\":\"date_is_on_or_after\",\"value\":{\"type\":\"exact\",\"value\":{\"type\":\"date\",\"start_date\":\"2025-01-01\"}}}},{\"property\":\"attendees\",\"filter\":{\"operator\":\"person_contains\",\"value\":[{\"type\":\"exact\",\"value\":{\"table\":\"notion_user\",\"id\":\"<user-id>\"}}]}}]}</example>\n- Title contains both terms: <example>{\"operator\":\"and\",\"filters\":[{\"property\":\"title\",\"filter\":{\"operator\":\"string_contains\",\"value\":{\"type\":\"exact\",\"value\":\"design\"}}},{\"property\":\"title\",\"filter\":{\"operator\":\"string_contains\",\"value\":{\"type\":\"exact\",\"value\":\"review\"}}}]}</example>\n- Title contains either term: <example>{\"operator\":\"or\",\"filters\":[{\"property\":\"title\",\"filter\":{\"operator\":\"string_contains\",\"value\":{\"type\":\"exact\",\"value\":\"standup\"}}},{\"property\":\"title\",\"filter\":{\"operator\":\"string_contains\",\"value\":{\"type\":\"exact\",\"value\":\"sync\"}}}]}</example>",
            type: "object",
            properties: {
              operator: {
                type: "string",
                enum: [
                  "and",
                  "or",
                ],
                description: "Operator for combinator filters.",
              },
              filters: {
                description: "Nested filters; each may be a combinator (and/or) or property filter.",
                maxItems: 100,
                type: "array",
                items: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        property: {
                          type: "string",
                          enum: [
                            "title",
                            "attendees",
                            "created_time",
                            "created_by",
                            "last_edited_time",
                            "last_edited_by",
                            "notion://meeting_notes/attendees",
                          ],
                          description: "Which meeting-note property to filter on. Prefer the short names; the schema URI form is accepted for compatibility.",
                        },
                        filter: {
                          anyOf: [
                            {
                              type: "object",
                              properties: {
                                operator: {
                                  type: "string",
                                  enum: [
                                    "string_is",
                                    "string_is_not",
                                    "string_contains",
                                    "string_does_not_contain",
                                    "string_starts_with",
                                    "string_ends_with",
                                  ],
                                  description: "How to compare the text.",
                                },
                                value: {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      enum: [
                                        "exact",
                                      ],
                                      description: "Always `exact`",
                                    },
                                    value: {
                                      type: "string",
                                      description: "The literal text the operator compares against.",
                                    },
                                  },
                                  required: [
                                    "type",
                                    "value",
                                  ],
                                  additionalProperties: false,
                                  description: "The text to compare against.",
                                },
                              },
                              required: [
                                "operator",
                                "value",
                              ],
                              additionalProperties: false,
                            },
                            {
                              type: "object",
                              properties: {
                                operator: {
                                  type: "string",
                                  enum: [
                                    "person_contains",
                                    "person_does_not_contain",
                                  ],
                                  description: "Whether the property must contain the people listed.",
                                },
                                value: {
                                  maxItems: 100,
                                  type: "array",
                                  items: {
                                    anyOf: [
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "exact",
                                            ],
                                            description: "Always `exact`",
                                          },
                                          value: {
                                            type: "object",
                                            properties: {
                                              table: {
                                                type: "string",
                                                enum: [
                                                  "notion_user",
                                                ],
                                                description: "Always `notion_user`",
                                              },
                                              id: {
                                                type: "string",
                                                description: "The user's ID, as a UUID or the `user://<uuid>` form returned by user search.",
                                              },
                                            },
                                            required: [
                                              "table",
                                              "id",
                                            ],
                                            additionalProperties: false,
                                            description: "Pointer to the Notion user to match.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                      },
                                      {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "relative",
                                            ],
                                            description: "Always `relative`",
                                          },
                                          value: {
                                            type: "string",
                                            enum: [
                                              "me",
                                            ],
                                            description: "Always `me`",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                      },
                                    ],
                                  },
                                  description: "The people to compare against.",
                                },
                              },
                              required: [
                                "operator",
                                "value",
                              ],
                              additionalProperties: false,
                            },
                            {
                              type: "object",
                              properties: {
                                operator: {
                                  type: "string",
                                  enum: [
                                    "date_is",
                                    "date_is_before",
                                    "date_is_after",
                                    "date_is_on_or_before",
                                    "date_is_on_or_after",
                                  ],
                                  description: "How to compare the date.",
                                },
                                value: {
                                  anyOf: [
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "relative",
                                          ],
                                          description: "Always `relative`",
                                        },
                                        value: {
                                          type: "string",
                                          enum: [
                                            "today",
                                            "tomorrow",
                                            "yesterday",
                                            "one_week_ago",
                                            "one_week_from_now",
                                            "one_month_ago",
                                            "one_month_from_now",
                                          ],
                                          description: "One of: `today`, `tomorrow`, `yesterday`, `one_week_ago`, `one_week_from_now`, `one_month_ago`, `one_month_from_now`",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "value",
                                      ],
                                      additionalProperties: false,
                                    },
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "exact",
                                          ],
                                          description: "Always `exact`",
                                        },
                                        value: {
                                          anyOf: [
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "date",
                                                  ],
                                                  description: "Always `date`",
                                                },
                                                start_date: {
                                                  type: "string",
                                                  format: "date",
                                                  pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                                  description: "The calendar date as an ISO 8601 date string.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "start_date",
                                              ],
                                              additionalProperties: false,
                                            },
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "datetime",
                                                  ],
                                                  description: "Always `datetime`",
                                                },
                                                start_date: {
                                                  type: "string",
                                                  format: "date",
                                                  pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                                  description: "The calendar date as an ISO 8601 date string.",
                                                },
                                                start_time: {
                                                  type: "string",
                                                  description: "The time of day in 24-hour HH:MM format.",
                                                },
                                                time_zone: {
                                                  type: "string",
                                                  description: "The IANA time zone name the time is interpreted in.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "start_date",
                                                "start_time",
                                                "time_zone",
                                              ],
                                              additionalProperties: false,
                                            },
                                          ],
                                          description: "Use the is_empty operator to match an unset date.",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "value",
                                      ],
                                      additionalProperties: false,
                                    },
                                  ],
                                  description: "The date to compare against.",
                                },
                                use_end: {
                                  description: "Compare against the end of a date range rather than its start.",
                                  type: "boolean",
                                },
                              },
                              required: [
                                "operator",
                                "value",
                              ],
                              additionalProperties: false,
                            },
                            {
                              type: "object",
                              properties: {
                                operator: {
                                  type: "string",
                                  enum: [
                                    "date_is_within",
                                    "date_is_relative_to",
                                  ],
                                  description: "How to compare the date against the range.",
                                },
                                value: {
                                  anyOf: [
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "relative",
                                          ],
                                          description: "Always `relative`",
                                        },
                                        value: {
                                          type: "string",
                                          enum: [
                                            "custom",
                                          ],
                                          description: "Always `custom`",
                                        },
                                        direction: {
                                          type: "string",
                                          enum: [
                                            "past",
                                            "future",
                                          ],
                                          description: "Whether the window runs backwards or forwards from now.",
                                        },
                                        unit: {
                                          type: "string",
                                          enum: [
                                            "year",
                                            "month",
                                            "week",
                                            "day",
                                          ],
                                          description: "One of: `year`, `month`, `week`, `day`",
                                        },
                                        count: {
                                          type: "integer",
                                          minimum: 1,
                                          maximum: 9007199254740991,
                                          description: "How many units wide the window is.",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "value",
                                        "direction",
                                        "unit",
                                        "count",
                                      ],
                                      additionalProperties: false,
                                    },
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "relative",
                                          ],
                                          description: "Always `relative`",
                                        },
                                        value: {
                                          type: "string",
                                          enum: [
                                            "surrounding",
                                          ],
                                          description: "Always `surrounding`",
                                        },
                                        unit: {
                                          type: "string",
                                          enum: [
                                            "year",
                                            "month",
                                            "week",
                                            "day",
                                          ],
                                          description: "One of: `year`, `month`, `week`, `day`",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "value",
                                        "unit",
                                      ],
                                      additionalProperties: false,
                                    },
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "relative",
                                          ],
                                          description: "Always `relative`",
                                        },
                                        value: {
                                          type: "string",
                                          enum: [
                                            "this_week",
                                            "the_past_week",
                                            "the_past_month",
                                            "the_past_year",
                                            "the_next_week",
                                            "the_next_month",
                                            "the_next_year",
                                          ],
                                          description: "One of: `this_week`, `the_past_week`, `the_past_month`, `the_past_year`, `the_next_week`, `the_next_month`, `the_next_year`",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "value",
                                      ],
                                      additionalProperties: false,
                                    },
                                    {
                                      type: "object",
                                      properties: {
                                        type: {
                                          type: "string",
                                          enum: [
                                            "exact",
                                          ],
                                          description: "Always `exact`",
                                        },
                                        value: {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              enum: [
                                                "daterange",
                                              ],
                                              description: "Always `daterange`",
                                            },
                                            start_date: {
                                              description: "Inclusive start of the range as an ISO 8601 date string, if any.",
                                              type: "string",
                                              format: "date",
                                              pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                            },
                                            end_date: {
                                              description: "Inclusive end of the range as an ISO 8601 date string, if any.",
                                              type: "string",
                                              format: "date",
                                              pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                            },
                                          },
                                          required: [
                                            "type",
                                          ],
                                          additionalProperties: false,
                                          description: "Use the is_empty operator to match an unset date.",
                                        },
                                      },
                                      required: [
                                        "type",
                                        "value",
                                      ],
                                      additionalProperties: false,
                                    },
                                  ],
                                  description: "The range to compare against.",
                                },
                                use_end: {
                                  description: "Compare against the end of a date range rather than its start.",
                                  type: "boolean",
                                },
                              },
                              required: [
                                "operator",
                                "value",
                              ],
                              additionalProperties: false,
                            },
                            {
                              type: "object",
                              properties: {
                                operator: {
                                  type: "string",
                                  enum: [
                                    "is_empty",
                                    "is_not_empty",
                                  ],
                                  description: "Whether the property must be empty or set.",
                                },
                              },
                              required: [
                                "operator",
                              ],
                              additionalProperties: false,
                            },
                          ],
                          description: "The comparison to apply. Use the arm matching the property's type.",
                        },
                      },
                      required: [
                        "property",
                        "filter",
                      ],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        operator: {
                          type: "string",
                          enum: [
                            "and",
                            "or",
                          ],
                          description: "Whether every child must match, or any of them.",
                        },
                        filters: {
                          maxItems: 100,
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              property: {
                                type: "string",
                                enum: [
                                  "title",
                                  "attendees",
                                  "created_time",
                                  "created_by",
                                  "last_edited_time",
                                  "last_edited_by",
                                  "notion://meeting_notes/attendees",
                                ],
                                description: "Which meeting-note property to filter on. Prefer the short names; the schema URI form is accepted for compatibility.",
                              },
                              filter: {
                                anyOf: [
                                  {
                                    type: "object",
                                    properties: {
                                      operator: {
                                        type: "string",
                                        enum: [
                                          "string_is",
                                          "string_is_not",
                                          "string_contains",
                                          "string_does_not_contain",
                                          "string_starts_with",
                                          "string_ends_with",
                                        ],
                                        description: "How to compare the text.",
                                      },
                                      value: {
                                        type: "object",
                                        properties: {
                                          type: {
                                            type: "string",
                                            enum: [
                                              "exact",
                                            ],
                                            description: "Always `exact`",
                                          },
                                          value: {
                                            type: "string",
                                            description: "The literal text the operator compares against.",
                                          },
                                        },
                                        required: [
                                          "type",
                                          "value",
                                        ],
                                        additionalProperties: false,
                                        description: "The text to compare against.",
                                      },
                                    },
                                    required: [
                                      "operator",
                                      "value",
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: "object",
                                    properties: {
                                      operator: {
                                        type: "string",
                                        enum: [
                                          "person_contains",
                                          "person_does_not_contain",
                                        ],
                                        description: "Whether the property must contain the people listed.",
                                      },
                                      value: {
                                        maxItems: 100,
                                        type: "array",
                                        items: {
                                          anyOf: [
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "exact",
                                                  ],
                                                  description: "Always `exact`",
                                                },
                                                value: {
                                                  type: "object",
                                                  properties: {
                                                    table: {
                                                      type: "string",
                                                      enum: [
                                                        "notion_user",
                                                      ],
                                                      description: "Always `notion_user`",
                                                    },
                                                    id: {
                                                      type: "string",
                                                      description: "The user's ID, as a UUID or the `user://<uuid>` form returned by user search.",
                                                    },
                                                  },
                                                  required: [
                                                    "table",
                                                    "id",
                                                  ],
                                                  additionalProperties: false,
                                                  description: "Pointer to the Notion user to match.",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                            {
                                              type: "object",
                                              properties: {
                                                type: {
                                                  type: "string",
                                                  enum: [
                                                    "relative",
                                                  ],
                                                  description: "Always `relative`",
                                                },
                                                value: {
                                                  type: "string",
                                                  enum: [
                                                    "me",
                                                  ],
                                                  description: "Always `me`",
                                                },
                                              },
                                              required: [
                                                "type",
                                                "value",
                                              ],
                                              additionalProperties: false,
                                            },
                                          ],
                                        },
                                        description: "The people to compare against.",
                                      },
                                    },
                                    required: [
                                      "operator",
                                      "value",
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: "object",
                                    properties: {
                                      operator: {
                                        type: "string",
                                        enum: [
                                          "date_is",
                                          "date_is_before",
                                          "date_is_after",
                                          "date_is_on_or_before",
                                          "date_is_on_or_after",
                                        ],
                                        description: "How to compare the date.",
                                      },
                                      value: {
                                        anyOf: [
                                          {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "relative",
                                                ],
                                                description: "Always `relative`",
                                              },
                                              value: {
                                                type: "string",
                                                enum: [
                                                  "today",
                                                  "tomorrow",
                                                  "yesterday",
                                                  "one_week_ago",
                                                  "one_week_from_now",
                                                  "one_month_ago",
                                                  "one_month_from_now",
                                                ],
                                                description: "One of: `today`, `tomorrow`, `yesterday`, `one_week_ago`, `one_week_from_now`, `one_month_ago`, `one_month_from_now`",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                          {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "exact",
                                                ],
                                                description: "Always `exact`",
                                              },
                                              value: {
                                                anyOf: [
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "date",
                                                        ],
                                                        description: "Always `date`",
                                                      },
                                                      start_date: {
                                                        type: "string",
                                                        format: "date",
                                                        pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                                        description: "The calendar date as an ISO 8601 date string.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "start_date",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                  {
                                                    type: "object",
                                                    properties: {
                                                      type: {
                                                        type: "string",
                                                        enum: [
                                                          "datetime",
                                                        ],
                                                        description: "Always `datetime`",
                                                      },
                                                      start_date: {
                                                        type: "string",
                                                        format: "date",
                                                        pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                                        description: "The calendar date as an ISO 8601 date string.",
                                                      },
                                                      start_time: {
                                                        type: "string",
                                                        description: "The time of day in 24-hour HH:MM format.",
                                                      },
                                                      time_zone: {
                                                        type: "string",
                                                        description: "The IANA time zone name the time is interpreted in.",
                                                      },
                                                    },
                                                    required: [
                                                      "type",
                                                      "start_date",
                                                      "start_time",
                                                      "time_zone",
                                                    ],
                                                    additionalProperties: false,
                                                  },
                                                ],
                                                description: "Use the is_empty operator to match an unset date.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                        ],
                                        description: "The date to compare against.",
                                      },
                                      use_end: {
                                        description: "Compare against the end of a date range rather than its start.",
                                        type: "boolean",
                                      },
                                    },
                                    required: [
                                      "operator",
                                      "value",
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: "object",
                                    properties: {
                                      operator: {
                                        type: "string",
                                        enum: [
                                          "date_is_within",
                                          "date_is_relative_to",
                                        ],
                                        description: "How to compare the date against the range.",
                                      },
                                      value: {
                                        anyOf: [
                                          {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "relative",
                                                ],
                                                description: "Always `relative`",
                                              },
                                              value: {
                                                type: "string",
                                                enum: [
                                                  "custom",
                                                ],
                                                description: "Always `custom`",
                                              },
                                              direction: {
                                                type: "string",
                                                enum: [
                                                  "past",
                                                  "future",
                                                ],
                                                description: "Whether the window runs backwards or forwards from now.",
                                              },
                                              unit: {
                                                type: "string",
                                                enum: [
                                                  "year",
                                                  "month",
                                                  "week",
                                                  "day",
                                                ],
                                                description: "One of: `year`, `month`, `week`, `day`",
                                              },
                                              count: {
                                                type: "integer",
                                                minimum: 1,
                                                maximum: 9007199254740991,
                                                description: "How many units wide the window is.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                              "direction",
                                              "unit",
                                              "count",
                                            ],
                                            additionalProperties: false,
                                          },
                                          {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "relative",
                                                ],
                                                description: "Always `relative`",
                                              },
                                              value: {
                                                type: "string",
                                                enum: [
                                                  "surrounding",
                                                ],
                                                description: "Always `surrounding`",
                                              },
                                              unit: {
                                                type: "string",
                                                enum: [
                                                  "year",
                                                  "month",
                                                  "week",
                                                  "day",
                                                ],
                                                description: "One of: `year`, `month`, `week`, `day`",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                              "unit",
                                            ],
                                            additionalProperties: false,
                                          },
                                          {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "relative",
                                                ],
                                                description: "Always `relative`",
                                              },
                                              value: {
                                                type: "string",
                                                enum: [
                                                  "this_week",
                                                  "the_past_week",
                                                  "the_past_month",
                                                  "the_past_year",
                                                  "the_next_week",
                                                  "the_next_month",
                                                  "the_next_year",
                                                ],
                                                description: "One of: `this_week`, `the_past_week`, `the_past_month`, `the_past_year`, `the_next_week`, `the_next_month`, `the_next_year`",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                          {
                                            type: "object",
                                            properties: {
                                              type: {
                                                type: "string",
                                                enum: [
                                                  "exact",
                                                ],
                                                description: "Always `exact`",
                                              },
                                              value: {
                                                type: "object",
                                                properties: {
                                                  type: {
                                                    type: "string",
                                                    enum: [
                                                      "daterange",
                                                    ],
                                                    description: "Always `daterange`",
                                                  },
                                                  start_date: {
                                                    description: "Inclusive start of the range as an ISO 8601 date string, if any.",
                                                    type: "string",
                                                    format: "date",
                                                    pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                                  },
                                                  end_date: {
                                                    description: "Inclusive end of the range as an ISO 8601 date string, if any.",
                                                    type: "string",
                                                    format: "date",
                                                    pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                                                  },
                                                },
                                                required: [
                                                  "type",
                                                ],
                                                additionalProperties: false,
                                                description: "Use the is_empty operator to match an unset date.",
                                              },
                                            },
                                            required: [
                                              "type",
                                              "value",
                                            ],
                                            additionalProperties: false,
                                          },
                                        ],
                                        description: "The range to compare against.",
                                      },
                                      use_end: {
                                        description: "Compare against the end of a date range rather than its start.",
                                        type: "boolean",
                                      },
                                    },
                                    required: [
                                      "operator",
                                      "value",
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: "object",
                                    properties: {
                                      operator: {
                                        type: "string",
                                        enum: [
                                          "is_empty",
                                          "is_not_empty",
                                        ],
                                        description: "Whether the property must be empty or set.",
                                      },
                                    },
                                    required: [
                                      "operator",
                                    ],
                                    additionalProperties: false,
                                  },
                                ],
                                description: "The comparison to apply. Use the arm matching the property's type.",
                              },
                            },
                            required: [
                              "property",
                              "filter",
                            ],
                            additionalProperties: false,
                          },
                          description: "The conditions in this group. A group with no conditions matches nothing, so send at least one.",
                        },
                      },
                      required: [
                        "operator",
                        "filters",
                      ],
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            required: [
              "operator",
            ],
            additionalProperties: {},
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-list-private-pages",
      "List the connected user’s private pages.",
      'read',
      {
        type: "object",
        properties: {
          limit: {
            description: "Maximum results to return (1-200).",
            type: "number",
          },
          cursor: {
            description: "Opaque pagination cursor from the previous response.",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-list-shared-pages",
      "List pages shared with the connected user.",
      'read',
      {
        type: "object",
        properties: {
          limit: {
            description: "Maximum results to return (1-200).",
            type: "number",
          },
          cursor: {
            description: "Opaque pagination cursor from the previous response.",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-list-favorite-pages",
      "List the connected user’s favorite pages.",
      'read',
      {
        type: "object",
        properties: {
          limit: {
            description: "Maximum results to return (1-200).",
            type: "number",
          },
          cursor: {
            description: "Opaque pagination cursor from the previous response.",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-list-recent-pages",
      "List the connected user’s recent pages.",
      'read',
      {
        type: "object",
        properties: {
          limit: {
            description: "Maximum results to return (1-200).",
            type: "number",
          },
          cursor: {
            description: "Opaque pagination cursor from the previous response.",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      { readOnlyHint: true, destructiveHint: false },
      false,
    ),
    pin(
      "notion-create-view",
      "Create a view on a Notion database. A form view can open or close submissions, allow anonymous responses, and set whether respondents can view or edit their responses.",
      'write',
      {
        type: "object",
        properties: {
          data_source_id: {
            type: "string",
            description: "The data source (collection) ID. Accepts a collection:// URI from <data-source> tags or a bare UUID.",
          },
          name: {
            type: "string",
            description: "The name of the view.",
          },
          type: {
            type: "string",
            enum: [
              "table",
              "board",
              "list",
              "calendar",
              "timeline",
              "gallery",
              "form",
              "chart",
              "map",
              "dashboard",
            ],
            description: "The type of view to create.",
          },
          database_id: {
            description: "The database to add a view tab to. Accepts a Notion URL or a bare UUID. Mutually exclusive with `parent_page_id`; exactly one must be provided.",
            type: "string",
          },
          parent_page_id: {
            description: "A page to create an inline linked database view on, like the UI /linked command. Accepts a Notion URL or a bare UUID. The new linked view block is appended at the end of the page and references `data_source_id`. Mutually exclusive with `database_id`; exactly one must be provided.",
            type: "string",
          },
          configure: {
            description: "View configuration DSL directives and examples:\n- FILTER \"Property\" = \"value\" — filter rows. Relation values must be a page URL or UUID; person values must be a user URI (user://<user_id>), user UUID, or \"me\". Names are not supported for either.\n- QUICK FILTER \"Property\" — add a quick filter to the view's filter bar with no criteria; add a condition to preselect one (QUICK FILTER \"Status\" = \"Done\")\n- SORT BY \"Property\" ASC — sort rows\n- GROUP BY \"Property\" [BY OPTION | BY GROUP] [SHOW EMPTY | HIDE EMPTY] — group by property (required for board views)\n- SUB GROUP BY \"Property\" [BY OPTION | BY GROUP] [SHOW EMPTY | HIDE EMPTY] — add board sub-grouping\n- CARD LAYOUT default | compact — set board or gallery card layout\n- CALENDAR BY \"Property\" — date property (required for calendar views)\n- TIMELINE BY \"Start\" TO \"End\" — date range (required for timeline views)\n- MAP BY \"Property\" — location property (required for map views)\n- CHART column|bar|line|donut|number — chart type with optional AGGREGATE, COLOR, HEIGHT, SORT, STACK BY, CAPTION\n- FORM CLOSE|OPEN — close/open form submissions\n- FORM ANONYMOUS true|false — toggle anonymous submissions\n- FORM PERMISSIONS none|reader|editor — set submission permissions\n- SHOW \"Prop1\", \"Prop2\" — set visible properties\n- COVER \"Property\" — cover image property\n\n\n<example>SHOW \"Name\", \"Status\", \"Due Date\"</example>\n<example>GROUP BY \"Status\" BY GROUP SHOW EMPTY; SUB GROUP BY \"Priority\"; CARD LAYOUT compact</example>\n<example>FILTER \"Status\" = \"In Progress\"; SORT BY \"Due Date\" ASC</example>\n<example>CALENDAR BY \"Due Date\"</example>\n<example>TIMELINE BY \"Start\" TO \"End\"</example>\n<example>FILTER \"Company\" = \"Acme\"</example>",
            type: "string",
          },
        },
        required: [
          "data_source_id",
          "name",
          "type",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: false },
      false,
    ),
    pin(
      "notion-update-view",
      "Update a Notion database view, replacing shared settings. Form settings can open or close submissions, allow anonymous responses, and control whether respondents can view or edit their responses; CLEAR can remove filters, sorts and grouping.",
      'write',
      {
        type: "object",
        properties: {
          view_id: {
            type: "string",
            description: "The view to update. Accepts a view:// URI, a Notion URL with ?v= parameter, or a bare UUID.",
          },
          name: {
            description: "New name for the view.",
            type: "string",
          },
          configure: {
            description: "View configuration DSL string. Supports FILTER, QUICK FILTER, SORT BY, GROUP BY, SUB GROUP BY, CARD LAYOUT, CALENDAR BY, TIMELINE BY, MAP BY, CHART, FORM, SHOW, HIDE, COVER, WRAP CELLS, FREEZE COLUMNS, and CLEAR directives.",
            type: "string",
          },
        },
        required: [
          "view_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: {},
      },
      { readOnlyHint: false, destructiveHint: false },
      true,
    ),
  ],
};
