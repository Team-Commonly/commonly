/**
 * Linear — TASK-238. Pins transcribed from connector-ops's consenting
 * 2026-10-19T07:00:52.954Z tools/list at read write openid (68 tools).
 * 36 reads and 26 writes, per Wren's 2026-10-24 pin ruling. Every writer maps
 * to write-with-confirm, with the exact arguments approved by the credential owner before a vendor call.
 * Existing read-scoped connections must reconnect after deployment.
 *
 * get_attachment and extract_images remain excluded: they can fetch external
 * caller-chosen targets into agent context. Upload preparation exposes upload
 * credentials, its asset-link partner depends on that flow, base64 attachment
 * creation hides bytes from approval, and create_issue_label is deprecated.
 * Those four writers are excluded. Named diff review/merge remains included.
 * Nineteen writers are marked irreversible. The other seven have pinned
 * reversals. The flag records the ruling even though all hosted writes park.
 * Schemas and both security annotations are pinned unchanged from the capture.
 * Descriptions are local copy. No outputSchema was captured.
 *
 * CIMD remains the registration mode. openid binds providerSubject during
 * reconnect. The revoke page is the signed-in Authorized applications page
 * verified in the 2026-10-15 walk, not the workspace security settings page.
 */
import type { HostedMcpEntry } from '../../services/hostedMcpEntryService';

export const LINEAR_ENTRY: HostedMcpEntry = {
  id: "linear",
  title: "Linear",
  description: "Read Linear issues and projects; changes require your approval.",
  resource: "https://mcp.linear.app/mcp",
  issuer: "https://mcp.linear.app",
  client: "cimd",
  scopes: [
    "read",
    "write",
    "openid",
  ],
  revoke: {
    page: "https://linear.app/settings/account/security",
  },
  tools: [
    {
      name: "delete_attachment",
      upstreamName: "delete_attachment",
      description: "Remove an attachment link from a Linear issue's Resources; the stored file remains.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Issue attachment ID from get_issue's attachments array (attachments[].id)",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "list_agent_skills",
      upstreamName: "list_agent_skills",
      description: "List the Linear Agent skills this workspace can use.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_agent_skill",
      upstreamName: "get_agent_skill",
      description: "Read one Linear Agent skill by id, with its full instructions.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Agent skill ID",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "list_comments",
      upstreamName: "list_comments",
      description: "List comments, optionally narrowed to one issue, project, initiative, document, milestone or status update.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          issueId: {
            description: "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues (provide exactly one parent)",
            type: "string",
          },
          projectId: {
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug (provide exactly one parent)",
            type: "string",
          },
          initiativeId: {
            description: "Initiative name, ID, identifier (e.g., I-123), or slug (provide exactly one parent)",
            type: "string",
          },
          documentId: {
            description: "Document ID or slug (provide exactly one parent)",
            type: "string",
          },
          milestoneId: {
            description: "Milestone UUID (provide exactly one parent). Resolve milestone names via `list_milestones` first.",
            type: "string",
          },
          statusUpdateId: {
            description: "Status update UUID (provide exactly one parent). Resolve status updates via `get_status_updates` first.",
            type: "string",
          },
          statusUpdateType: {
            description: "Type of status update named by `statusUpdateId`, as returned by `get_status_updates`. Only valid together with `statusUpdateId`; omit to check both project and initiative status updates.",
            type: "string",
            enum: [
              "project",
              "initiative",
            ],
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_comment",
      upstreamName: "save_comment",
      description: "Create or edit a comment on a Linear issue, project, initiative, document, milestone or status update.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            description: "Comment ID. If provided, updates the existing comment",
            type: "string",
          },
          issueId: {
            description: "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues (provide exactly one parent)",
            type: "string",
          },
          projectId: {
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug (provide exactly one parent)",
            type: "string",
          },
          initiativeId: {
            description: "Initiative name, ID, identifier (e.g., I-123), or slug (provide exactly one parent)",
            type: "string",
          },
          documentId: {
            description: "Document ID or slug (provide exactly one parent)",
            type: "string",
          },
          milestoneId: {
            description: "Milestone UUID (provide exactly one parent). Resolve milestone names via `list_milestones` first.",
            type: "string",
          },
          statusUpdateId: {
            description: "Status update UUID (provide exactly one parent). Resolve status updates via `get_status_updates` first.",
            type: "string",
          },
          statusUpdateType: {
            description: "Type of status update named by `statusUpdateId`, as returned by `get_status_updates`. Only valid together with `statusUpdateId`; omit to check both project and initiative status updates.",
            type: "string",
            enum: [
              "project",
              "initiative",
            ],
          },
          parentId: {
            description: "Parent comment ID (for replies, only when creating)",
            type: "string",
          },
          body: {
            type: "string",
            description: "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)",
          },
        },
        required: [
          "body",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "delete_comment",
      upstreamName: "delete_comment",
      description: "Delete a Linear comment identified by its ID.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Comment ID",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "list_cycles",
      upstreamName: "list_cycles",
      description: "List one team's cycles.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          teamId: {
            type: "string",
            description: "Team UUID from list_teams or get_team; names and keys are not accepted",
          },
          type: {
            description: "Filter relative to the team's current cycle. Omit to return cycles without this filter",
            type: "string",
            enum: [
              "current",
              "previous",
              "next",
            ],
          },
        },
        required: [
          "teamId",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "list_custom_views",
      upstreamName: "list_custom_views",
      description: "List the saved issue, project and initiative views this account can see. The views come back, not the records they match.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          query: {
            description: "Search custom view names",
            type: "string",
          },
          type: {
            description: "Entity type displayed by the view",
            type: "string",
            enum: [
              "Issue",
              "Project",
              "Initiative",
            ],
          },
          team: {
            description: "Team name or ID",
            type: "string",
          },
          shared: {
            description: "True for shared views, false for personal views",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_document",
      upstreamName: "get_document",
      description: "Read one document by id.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Document ID or slug",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "list_documents",
      upstreamName: "list_documents",
      description: "List documents, optionally filtered by project, initiative, team, creator or a date range.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          query: {
            description: "Search query",
            type: "string",
          },
          projectId: {
            description: "Filter by project ID, identifier (e.g., 'P-ENG-123'), or slug",
            type: "string",
          },
          initiativeId: {
            description: "Filter by initiative ID, identifier (e.g., 'I-123'), or slug",
            type: "string",
          },
          teamId: {
            description: "Filter by team ID",
            type: "string",
          },
          creatorId: {
            description: "Filter by creator ID",
            type: "string",
          },
          createdAt: {
            description: "Created after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          updatedAt: {
            description: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
          fields: {
            description: "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.",
            type: "array",
            items: {
              type: "string",
              enum: [
                "id",
                "title",
                "content",
                "url",
                "createdAt",
                "updatedAt",
                "archivedAt",
                "creator",
                "updatedBy",
                "project",
                "initiative",
                "team",
                "issue",
              ],
            },
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_document",
      upstreamName: "save_document",
      description: "Create or edit a Linear document and its links to workspace records.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            description: "Document ID or slug to update. Omit to create a new document.",
            type: "string",
          },
          title: {
            description: "Document title (required when creating)",
            type: "string",
          },
          content: {
            description: "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)",
            type: "string",
          },
          patch: {
            description: "Partial edits applied to the current content, in order and atomically (one failing operation aborts the whole save). Every anchor string must match the current content exactly once. Only valid on update, in place of the full content/description field",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "replace",
                    },
                    old_string: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to replace. Must match the current content exactly once",
                    },
                    new_string: {
                      type: "string",
                      description: "Replacement text. Empty string deletes the match",
                    },
                    replace_all: {
                      description: "Replace every occurrence instead of requiring a unique match",
                      type: "boolean",
                    },
                  },
                  required: [
                    "op",
                    "old_string",
                    "new_string",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "insert_before",
                    },
                    anchor: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to insert before. Must match the current content exactly once",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert directly before the anchor. Include separators (e.g. \"\\n\\n\")",
                    },
                  },
                  required: [
                    "op",
                    "anchor",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "insert_after",
                    },
                    anchor: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to insert after. Must match the current content exactly once",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert directly after the anchor. Include separators (e.g. \"\\n\\n\")",
                    },
                  },
                  required: [
                    "op",
                    "anchor",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "prepend",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert at the very start of the content",
                    },
                  },
                  required: [
                    "op",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "append",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert at the very end of the content",
                    },
                  },
                  required: [
                    "op",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "replace_range",
                    },
                    from: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text where the range starts (inclusive). Must match exactly once",
                    },
                    to: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text where the range ends (exclusive, stays in place). Must match exactly once after `from`",
                    },
                    new_string: {
                      type: "string",
                      description: "Text replacing the range. Empty string deletes it",
                    },
                  },
                  required: [
                    "op",
                    "from",
                    "to",
                    "new_string",
                  ],
                },
              ],
            },
          },
          project: {
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
            type: "string",
          },
          issue: {
            description: "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues",
            type: "string",
          },
          initiative: {
            description: "Initiative name, ID, identifier (e.g., I-123), or slug",
            type: "string",
          },
          cycle: {
            description: "Cycle name, number, or ID. When passing a name or number, also pass `team` to disambiguate.",
            type: "string",
          },
          team: {
            description: "Team name or ID. Attaches the document to the team, unless `cycle` is also passed, in which case it disambiguates the cycle.",
            type: "string",
          },
          icon: {
            description: "Icon name or emoji code (e.g. \"Rocket\" or \":eagle:\"), not a raw Unicode emoji",
            type: "string",
          },
          color: {
            description: "Hex color",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "get_issue",
      upstreamName: "get_issue",
      description: "Read one issue by id or identifier, optionally with its relations, customer needs and releases.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues",
          },
          fields: {
            description: "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.",
            type: "array",
            items: {
              type: "string",
              enum: [
                "id",
                "uuid",
                "title",
                "description",
                "projectMilestone",
                "priority",
                "estimate",
                "url",
                "gitBranchName",
                "createdAt",
                "updatedAt",
                "archivedAt",
                "completedAt",
                "startedAt",
                "canceledAt",
                "startedTriageAt",
                "triagedAt",
                "dueDate",
                "slaStartedAt",
                "slaMediumRiskAt",
                "slaHighRiskAt",
                "slaBreachesAt",
                "slaType",
                "status",
                "statusType",
                "labels",
                "triageIntel",
                "createdBy",
                "createdById",
                "assignee",
                "assigneeId",
                "delegate",
                "delegateId",
                "project",
                "projectId",
                "parentId",
                "team",
                "teamId",
                "cycleId",
                "attachments",
                "documents",
                "stateHistory",
                "relations",
                "customerNeeds",
                "releases",
              ],
            },
          },
          includeRelations: {
            default: false,
            description: "Include blocking/related/duplicate relations",
            type: "boolean",
          },
          includeCustomerNeeds: {
            default: false,
            description: "Include associated customer needs",
            type: "boolean",
          },
          includeReleases: {
            default: false,
            description: "Include associated releases",
            type: "boolean",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "list_issues",
      upstreamName: "list_issues",
      description: "List issues, optionally filtered by team, state, cycle, label, assignee, creator, delegate, project, release, priority, parent or a search query.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          query: {
            description: "Search issue title or description. Cannot be combined with customView",
            type: "string",
          },
          customView: {
            description: "Saved view ID, URL, slug, or exact name. Use list_custom_views to discover views. Applies saved filters and scope; other filters narrow the results. Uses list ordering, not saved display settings",
            type: "string",
            minLength: 1,
          },
          team: {
            description: "Team name or ID",
            type: "string",
          },
          includeSubTeams: {
            default: false,
            description: "Include results from the selected team and all descendants when team is set. Team ID filters already include descendants; this also expands name and key filters",
            type: "boolean",
          },
          state: {
            description: "State type, name, or ID",
            type: "string",
          },
          cycle: {
            description: "Cycle name, number, or ID",
            type: "string",
          },
          label: {
            description: "Label name or ID",
            type: "string",
          },
          assignee: {
            description: "User ID, name, email, or \"me\"",
            type: [
              "string",
              "null",
            ],
          },
          creator: {
            description: "User ID, name, email, or \"me\"",
            type: "string",
          },
          delegate: {
            description: "Agent name or ID. When the user asks to delegate to \"Linear\" or \"the Linear agent\", this refers to the \"Linear\" app user specifically",
            type: "string",
          },
          project: {
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
            type: "string",
          },
          release: {
            description: "Release ID or slug",
            type: "string",
          },
          priority: {
            description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
            type: "number",
          },
          parentId: {
            description: "Parent issue ID or identifier (e.g., LIN-123)",
            type: "string",
          },
          fields: {
            description: "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.",
            type: "array",
            items: {
              type: "string",
              enum: [
                "id",
                "uuid",
                "title",
                "description",
                "projectMilestone",
                "priority",
                "estimate",
                "url",
                "gitBranchName",
                "createdAt",
                "updatedAt",
                "archivedAt",
                "completedAt",
                "startedAt",
                "canceledAt",
                "startedTriageAt",
                "triagedAt",
                "dueDate",
                "slaStartedAt",
                "slaMediumRiskAt",
                "slaHighRiskAt",
                "slaBreachesAt",
                "slaType",
                "status",
                "statusType",
                "labels",
                "triageIntel",
                "createdBy",
                "createdById",
                "assignee",
                "assigneeId",
                "delegate",
                "delegateId",
                "project",
                "projectId",
                "parentId",
                "team",
                "teamId",
                "cycleId",
              ],
            },
          },
          createdAt: {
            description: "Created after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          updatedAt: {
            description: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          triagedAt: {
            description: "Left triage after: ISO-8601 date/duration (e.g., -P1D). Issues still in triage have no triagedAt; list them with state \"triage\"",
            type: "string",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_issue",
      upstreamName: "save_issue",
      description: "Create or edit a Linear issue. Assignee \"me\" means the connection owner; delegate assigns work to an agent installed in that Linear workspace.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            description: "Only for updating an existing issue. Pass the issue ID or identifier (e.g., LIN-123). Do NOT pass this parameter when creating a new issue.",
            type: "string",
          },
          title: {
            description: "Issue title (required when creating, unless template is set)",
            type: "string",
          },
          description: {
            description: "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)",
            type: "string",
          },
          patch: {
            description: "Partial edits applied to the current content, in order and atomically (one failing operation aborts the whole save). Every anchor string must match the current content exactly once. Only valid on update, in place of the full content/description field",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "replace",
                    },
                    old_string: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to replace. Must match the current content exactly once",
                    },
                    new_string: {
                      type: "string",
                      description: "Replacement text. Empty string deletes the match",
                    },
                    replace_all: {
                      description: "Replace every occurrence instead of requiring a unique match",
                      type: "boolean",
                    },
                  },
                  required: [
                    "op",
                    "old_string",
                    "new_string",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "insert_before",
                    },
                    anchor: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to insert before. Must match the current content exactly once",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert directly before the anchor. Include separators (e.g. \"\\n\\n\")",
                    },
                  },
                  required: [
                    "op",
                    "anchor",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "insert_after",
                    },
                    anchor: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to insert after. Must match the current content exactly once",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert directly after the anchor. Include separators (e.g. \"\\n\\n\")",
                    },
                  },
                  required: [
                    "op",
                    "anchor",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "prepend",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert at the very start of the content",
                    },
                  },
                  required: [
                    "op",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "append",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert at the very end of the content",
                    },
                  },
                  required: [
                    "op",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "replace_range",
                    },
                    from: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text where the range starts (inclusive). Must match exactly once",
                    },
                    to: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text where the range ends (exclusive, stays in place). Must match exactly once after `from`",
                    },
                    new_string: {
                      type: "string",
                      description: "Text replacing the range. Empty string deletes it",
                    },
                  },
                  required: [
                    "op",
                    "from",
                    "to",
                    "new_string",
                  ],
                },
              ],
            },
          },
          team: {
            description: "Team name or ID (required when creating)",
            type: "string",
          },
          template: {
            description: "Template name or ID. Applied on create only. The template fills in the content, fields, and sub-issues server-side. A `description` replaces the template body rather than merging with it, but an empty `description` keeps the template body. Labels merge with the template's own",
            type: "string",
          },
          cycle: {
            description: "Cycle name, number, or ID. Null to remove",
            type: [
              "string",
              "null",
            ],
          },
          milestone: {
            description: "Milestone name or ID",
            type: "string",
          },
          priority: {
            description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
            type: "number",
          },
          project: {
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug. Null to remove",
            type: [
              "string",
              "null",
            ],
          },
          state: {
            description: "State type, name, or ID",
            type: "string",
          },
          assignee: {
            description: "User ID, name, email, or \"me\". Null to remove",
            type: [
              "string",
              "null",
            ],
          },
          delegate: {
            description: "Agent name or ID. When the user asks to delegate to \"Linear\" or \"the Linear agent\", this refers to the \"Linear\" app user specifically. Null to remove",
            type: [
              "string",
              "null",
            ],
          },
          labels: {
            description: "Label names or IDs as a JSON array of strings (e.g. [\"Bug\", \"Urgent\"]). Replaces the full label set; existing labels not included are removed. Omit to leave labels unchanged. Cannot be combined with addLabels/removeLabels; prefer those for incremental changes",
            type: "array",
            items: {
              type: "string",
            },
          },
          addLabels: {
            description: "Label names or IDs as a JSON array of strings (e.g. [\"Bug\", \"Urgent\"]) to add. Append-only; existing labels are never removed. Cannot be combined with a team change",
            type: "array",
            items: {
              type: "string",
            },
          },
          removeLabels: {
            description: "Label names or IDs as a JSON array of strings (e.g. [\"Bug\", \"Urgent\"]) to remove. Only valid when updating an existing issue. Cannot be combined with a team change",
            type: "array",
            items: {
              type: "string",
            },
          },
          dueDate: {
            description: "Due date (ISO format). On update, pass null to remove the due date",
            type: [
              "string",
              "null",
            ],
          },
          slaBreachesAt: {
            description: "ISO-8601 timestamp when the SLA will breach. On update, pass null to remove the SLA",
            anyOf: [
              {
                type: "string",
                format: "date-time",
                pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
              },
              {
                type: "null",
              },
            ],
          },
          slaType: {
            description: "SLA day counting type: \"all\" or \"onlyBusinessDays\". Only use with slaBreachesAt; null means unset",
            anyOf: [
              {
                type: "string",
                enum: [
                  "all",
                  "onlyBusinessDays",
                ],
              },
              {
                type: "null",
              },
            ],
          },
          parentId: {
            description: "Parent issue ID or identifier (e.g., LIN-123). Null to remove",
            type: [
              "string",
              "null",
            ],
          },
          estimate: {
            description: "Issue estimate value. On create, pass null or omit for no estimate. On update, pass null to clear the estimate; omitting leaves it unchanged. 0 is a real estimate only on teams that allow zero estimates.",
            type: [
              "number",
              "null",
            ],
          },
          links: {
            description: "Link attachments to add [{url, title}]. Append-only; existing links are never removed",
            type: "array",
            items: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                  format: "uri",
                },
                title: {
                  type: "string",
                  minLength: 1,
                },
              },
              required: [
                "url",
                "title",
              ],
            },
          },
          setReleases: {
            description: "Replace all releases on the issue with these. Cannot be combined with addReleases/removeReleases",
            type: "array",
            items: {
              type: "string",
            },
          },
          addReleases: {
            description: "Release IDs or slugs to add. Append-only; existing releases are never removed",
            type: "array",
            items: {
              type: "string",
            },
          },
          removeReleases: {
            description: "Release IDs or slugs to remove. Only valid when updating an existing issue",
            type: "array",
            items: {
              type: "string",
            },
          },
          blocks: {
            description: "Issue IDs/identifiers this blocks. Append-only; existing relations are never removed",
            type: "array",
            items: {
              type: "string",
            },
          },
          blockedBy: {
            description: "Issue IDs/identifiers blocking this. Append-only; existing relations are never removed",
            type: "array",
            items: {
              type: "string",
            },
          },
          relatedTo: {
            description: "Related issue IDs/identifiers. Append-only; existing relations are never removed",
            type: "array",
            items: {
              type: "string",
            },
          },
          duplicateOf: {
            description: "Duplicate of issue ID/identifier. Null to remove",
            type: [
              "string",
              "null",
            ],
          },
          removeBlocks: {
            description: "Issue IDs/identifiers to stop blocking",
            type: "array",
            items: {
              type: "string",
            },
          },
          removeBlockedBy: {
            description: "Issue IDs/identifiers to remove as blockers of this issue",
            type: "array",
            items: {
              type: "string",
            },
          },
          removeRelatedTo: {
            description: "Related issue IDs/identifiers to remove",
            type: "array",
            items: {
              type: "string",
            },
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "list_issue_statuses",
      upstreamName: "list_issue_statuses",
      description: "List the workflow statuses of one team.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          team: {
            type: "string",
            description: "Team name or ID",
          },
        },
        required: [
          "team",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_issue_status",
      upstreamName: "get_issue_status",
      description: "Read one workflow status by id, or by name within a team.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Status ID",
          },
          name: {
            type: "string",
            description: "Status name",
          },
          team: {
            type: "string",
            description: "Team name or ID",
          },
        },
        required: [
          "id",
          "name",
          "team",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "list_issue_labels",
      upstreamName: "list_issue_labels",
      description: "List issue labels, optionally filtered by name or team, and optionally including label groups.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          name: {
            description: "Filter by name",
            type: "string",
          },
          team: {
            description: "Team name or ID",
            type: "string",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
          includeGroups: {
            default: false,
            description: "Include label groups in the results, marked with `isGroup`. A group cannot be applied directly; retiring or restoring one cascades to its child labels",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_issue_label",
      upstreamName: "save_issue_label",
      description: "Create or edit an issue label in Linear, including its grouping and team.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            description: "Label name or ID. If provided, updates the existing label",
            type: "string",
          },
          name: {
            description: "Label name (required when creating)",
            type: "string",
          },
          description: {
            description: "Label description. Null to clear it",
            type: [
              "string",
              "null",
            ],
          },
          color: {
            description: "Hex color code",
            type: "string",
          },
          teamId: {
            description: "Team UUID (omit for workspace label). When updating, only disambiguates `id` by name; a label's team cannot be changed",
            type: "string",
          },
          parent: {
            description: "Parent label group name or ID. Null to remove from its group",
            type: [
              "string",
              "null",
            ],
          },
          isGroup: {
            description: "Whether the label is a group",
            type: "boolean",
          },
          groupType: {
            description: "Selection mode for label groups. Defaults to singleSelect when creating; omit to keep it unchanged when updating",
            type: "string",
            enum: [
              "singleSelect",
              "multiSelect",
            ],
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "retire_issue_label",
      upstreamName: "retire_issue_label",
      description: "Retire a Linear issue label from active use.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Label or label group ID",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: false,
    },
    {
      name: "restore_issue_label",
      upstreamName: "restore_issue_label",
      description: "Restore a retired Linear issue label to active use.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Label or label group ID",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: false,
    },
    {
      name: "list_projects",
      upstreamName: "list_projects",
      description: "List projects, optionally filtered by state, initiative, team, member, label or a search query.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Max results (default 50, max 50)",
            type: "number",
            maximum: 50,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          customView: {
            description: "Saved view ID, URL, slug, or exact name. Use list_custom_views to discover views. Applies saved filters and scope; other filters narrow the results. Uses list ordering, not saved display settings",
            type: "string",
            minLength: 1,
          },
          query: {
            description: "Search project name",
            type: "string",
          },
          state: {
            description: "State type, name, or ID",
            type: "string",
          },
          initiative: {
            description: "Initiative name, ID, identifier (e.g., I-123), or slug",
            type: "string",
          },
          team: {
            description: "Team name or ID",
            type: "string",
          },
          includeSubTeams: {
            default: false,
            description: "Include results from the selected team and all descendants when team is set. Team ID filters already include descendants; this also expands name and key filters",
            type: "boolean",
          },
          member: {
            description: "User ID, name, email, or \"me\"",
            type: "string",
          },
          label: {
            description: "Label name or ID",
            type: "string",
          },
          createdAt: {
            description: "Created after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          updatedAt: {
            description: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          includeMilestones: {
            default: false,
            description: "Include milestones",
            type: "boolean",
          },
          includeMembers: {
            default: false,
            description: "Include project members",
            type: "boolean",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
          fields: {
            description: "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.",
            type: "array",
            items: {
              type: "string",
              enum: [
                "id",
                "uuid",
                "name",
                "summary",
                "description",
                "url",
                "trashed",
                "createdAt",
                "updatedAt",
                "startedAt",
                "completedAt",
                "canceledAt",
                "startDate",
                "startDateResolution",
                "targetDate",
                "targetDateResolution",
                "priority",
                "sortOrder",
                "labels",
                "initiatives",
                "lead",
                "leadTeam",
                "status",
                "teams",
                "members",
                "milestones",
              ],
            },
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_project",
      upstreamName: "get_project",
      description: "Read one project by name or id, optionally with its milestones, members, resources and customer needs.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
          },
          includeCustomerNeeds: {
            default: false,
            description: "Include one page of customer needs attached directly to the project",
            type: "boolean",
          },
          customerNeedsLimit: {
            default: 10,
            description: "Customer needs per page when includeCustomerNeeds is true (default 10, max 50)",
            type: "integer",
            minimum: 1,
            maximum: 50,
          },
          customerNeedsCursor: {
            description: "Next customer-needs page: pass customerNeedsPageInfo.endCursor with includeCustomerNeeds true",
            type: "string",
          },
          includeMilestones: {
            default: false,
            description: "Include milestones",
            type: "boolean",
          },
          includeMembers: {
            default: false,
            description: "Include project members",
            type: "boolean",
          },
          includeResources: {
            default: false,
            description: "Include resources (documents, links, attachments)",
            type: "boolean",
          },
        },
        required: [
          "query",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_project",
      upstreamName: "save_project",
      description: "Create or edit a Linear project, including its teams, dates, labels and links.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug. If provided, updates the existing project",
            type: "string",
          },
          name: {
            description: "Project name (required when creating)",
            type: "string",
          },
          template: {
            description: "Template name or ID. Applied on create only. The template fills in the content, fields, and sub-issues server-side. A `description` replaces the template body rather than merging with it, but an empty `description` keeps the template body. Labels merge with the template's own",
            type: "string",
          },
          icon: {
            description: "Icon name or emoji code (e.g. \"Rocket\" or \":eagle:\"), not a raw Unicode emoji",
            type: "string",
          },
          color: {
            description: "Hex color",
            type: "string",
          },
          summary: {
            description: "Short summary (max 255 chars)",
            type: "string",
          },
          description: {
            description: "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)",
            type: "string",
          },
          patch: {
            description: "Partial edits applied to the current content, in order and atomically (one failing operation aborts the whole save). Every anchor string must match the current content exactly once. Only valid on update, in place of the full content/description field",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "replace",
                    },
                    old_string: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to replace. Must match the current content exactly once",
                    },
                    new_string: {
                      type: "string",
                      description: "Replacement text. Empty string deletes the match",
                    },
                    replace_all: {
                      description: "Replace every occurrence instead of requiring a unique match",
                      type: "boolean",
                    },
                  },
                  required: [
                    "op",
                    "old_string",
                    "new_string",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "insert_before",
                    },
                    anchor: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to insert before. Must match the current content exactly once",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert directly before the anchor. Include separators (e.g. \"\\n\\n\")",
                    },
                  },
                  required: [
                    "op",
                    "anchor",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "insert_after",
                    },
                    anchor: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to insert after. Must match the current content exactly once",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert directly after the anchor. Include separators (e.g. \"\\n\\n\")",
                    },
                  },
                  required: [
                    "op",
                    "anchor",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "prepend",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert at the very start of the content",
                    },
                  },
                  required: [
                    "op",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "append",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert at the very end of the content",
                    },
                  },
                  required: [
                    "op",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "replace_range",
                    },
                    from: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text where the range starts (inclusive). Must match exactly once",
                    },
                    to: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text where the range ends (exclusive, stays in place). Must match exactly once after `from`",
                    },
                    new_string: {
                      type: "string",
                      description: "Text replacing the range. Empty string deletes it",
                    },
                  },
                  required: [
                    "op",
                    "from",
                    "to",
                    "new_string",
                  ],
                },
              ],
            },
          },
          state: {
            description: "Project status name, type, or ID. Names resolve within the lead team's project statuses. If the lead team is unknown, standard labels resolve as status types; custom names require a status ID or leadTeam",
            type: "string",
          },
          startDate: {
            description: "Start date (ISO format). Pair with startDateResolution to indicate precision (e.g. month, quarter). Null to remove",
            type: [
              "string",
              "null",
            ],
          },
          startDateResolution: {
            description: "Start date resolution. Null for an exact day. When omitted, the current resolution stays and the date snaps to it",
            anyOf: [
              {
                type: "string",
                enum: [
                  "halfYear",
                  "month",
                  "quarter",
                  "year",
                ],
              },
              {
                type: "null",
              },
            ],
          },
          targetDate: {
            description: "Target date (ISO format). Pair with targetDateResolution to indicate precision (e.g. month, quarter). Null to remove",
            type: [
              "string",
              "null",
            ],
          },
          targetDateResolution: {
            description: "Target date resolution. Null for an exact day. When omitted, the current resolution stays and the date snaps to it",
            anyOf: [
              {
                type: "string",
                enum: [
                  "halfYear",
                  "month",
                  "quarter",
                  "year",
                ],
              },
              {
                type: "null",
              },
            ],
          },
          priority: {
            description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
            type: "integer",
            minimum: 0,
            maximum: 4,
          },
          addTeams: {
            description: "Team name or ID to add",
            type: "array",
            items: {
              type: "string",
            },
          },
          removeTeams: {
            description: "Team name or ID to remove",
            type: "array",
            items: {
              type: "string",
            },
          },
          setTeams: {
            description: "Replace all teams with these. Cannot combine with addTeams/removeTeams",
            type: "array",
            items: {
              type: "string",
            },
          },
          leadTeam: {
            description: "Team that leads the project. Team name or ID. Overrides the default lead team; added to the project's teams when not among them",
            type: "string",
          },
          labels: {
            description: "Label names or IDs as a JSON array of strings (e.g. [\"Bug\", \"Urgent\"]). Replaces the full label set; existing labels not included are removed. Omit to leave labels unchanged",
            type: "array",
            items: {
              type: "string",
            },
          },
          lead: {
            description: "User ID, name, email, or \"me\". Null to remove, except on create with a template that names a lead",
            type: [
              "string",
              "null",
            ],
          },
          addInitiatives: {
            description: "Initiatives to add. Initiative name, ID, identifier (e.g., I-123), or slug",
            type: "array",
            items: {
              type: "string",
            },
          },
          removeInitiatives: {
            description: "Initiatives to remove. Initiative name, ID, identifier (e.g., I-123), or slug",
            type: "array",
            items: {
              type: "string",
            },
          },
          setInitiatives: {
            description: "Replace all initiatives with these. Initiative name, ID, identifier (e.g., I-123), or slug. Cannot combine with addInitiatives/removeInitiatives",
            type: "array",
            items: {
              type: "string",
            },
          },
          links: {
            description: "External resource links to add [{url, title}]. Append-only; existing links are never removed",
            type: "array",
            items: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                  format: "uri",
                },
                title: {
                  type: "string",
                  minLength: 1,
                },
              },
              required: [
                "url",
                "title",
              ],
            },
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "list_project_labels",
      upstreamName: "list_project_labels",
      description: "List project labels, optionally filtered by name or team, and optionally including label groups.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          name: {
            description: "Filter by name",
            type: "string",
          },
          team: {
            description: "Team name or ID",
            type: "string",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
          includeGroups: {
            default: false,
            description: "Include label groups in the results, marked with `isGroup`. A group cannot be applied directly; retiring or restoring one cascades to its child labels",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "retire_project_label",
      upstreamName: "retire_project_label",
      description: "Retire a Linear project label from active use.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Label or label group ID",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: false,
    },
    {
      name: "restore_project_label",
      upstreamName: "restore_project_label",
      description: "Restore a retired Linear project label to active use.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Label or label group ID",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: false,
    },
    {
      name: "save_project_label",
      upstreamName: "save_project_label",
      description: "Create or edit a Linear project label, including its grouping and team.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            description: "Label name or ID. If provided, updates the existing label",
            type: "string",
          },
          name: {
            description: "Label name (required when creating)",
            type: "string",
          },
          description: {
            description: "Label description. Null to clear it",
            type: [
              "string",
              "null",
            ],
          },
          color: {
            description: "Hex color code",
            type: "string",
          },
          teamId: {
            description: "Team UUID (omit for workspace label). When updating, only disambiguates `id` by name; a label's team cannot be changed",
            type: "string",
          },
          parent: {
            description: "Parent label group name or ID. Null to remove from its group",
            type: [
              "string",
              "null",
            ],
          },
          isGroup: {
            description: "Whether the label is a group",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "list_release_pipelines",
      upstreamName: "list_release_pipelines",
      description: "List release pipelines, optionally narrowed to one team or to the production pipelines.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          query: {
            description: "Search pipeline name",
            type: "string",
          },
          team: {
            description: "Team name or ID",
            type: "string",
          },
          type: {
            description: "Pipeline type: continuous | scheduled",
            type: "string",
            enum: [
              "continuous",
              "scheduled",
            ],
          },
          isProduction: {
            description: "Filter by production pipeline flag",
            type: "boolean",
          },
          includeStages: {
            default: false,
            description: "Include each pipeline's stages",
            type: "boolean",
          },
          includeTeams: {
            default: false,
            description: "Include each pipeline's teams",
            type: "boolean",
          },
          createdAt: {
            description: "Created after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          updatedAt: {
            description: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "list_releases",
      upstreamName: "list_releases",
      description: "List releases, optionally filtered by pipeline, stage, stage type, version or a search query.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          query: {
            description: "Search release name or version",
            type: "string",
          },
          pipeline: {
            description: "Release pipeline ID, slug, or exact name",
            type: "string",
          },
          stage: {
            description: "Release stage ID or exact name",
            type: "string",
          },
          stageType: {
            description: "Filter by stage lifecycle type",
            type: "string",
            enum: [
              "planned",
              "started",
              "completed",
              "canceled",
            ],
          },
          version: {
            description: "Exact version match",
            type: "string",
          },
          hasReleaseNotes: {
            description: "Filter to releases that do (true) or do not (false) have release notes",
            type: "boolean",
          },
          includeReleaseNotes: {
            default: false,
            description: "Include associated release notes",
            type: "boolean",
          },
          createdAt: {
            description: "Created after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          updatedAt: {
            description: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_release",
      upstreamName: "get_release",
      description: "Read one release by id, optionally with its release notes.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Release ID or slug",
          },
          includeReleaseNotes: {
            default: false,
            description: "Include associated release notes",
            type: "boolean",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_release",
      upstreamName: "save_release",
      description: "Create or edit a release in a Linear release pipeline.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            description: "Release ID or slug to update. Omit to create a new release.",
            type: "string",
          },
          name: {
            description: "Release name (required when creating)",
            type: "string",
          },
          description: {
            description: "Release description",
            type: "string",
          },
          version: {
            description: "Version identifier",
            type: "string",
          },
          pipeline: {
            description: "Release pipeline ID, slug, or exact name (required when creating)",
            type: "string",
          },
          stage: {
            description: "Release stage ID, exact name, or lifecycle type within the release pipeline",
            type: "string",
          },
          startDate: {
            description: "Estimated start date (ISO YYYY-MM-DD, null to remove)",
            type: [
              "string",
              "null",
            ],
          },
          targetDate: {
            description: "Estimated completion date (ISO YYYY-MM-DD, null to remove)",
            type: [
              "string",
              "null",
            ],
          },
          createdAt: {
            description: "Import/create timestamp (ISO DateTime)",
            type: "string",
          },
          startedAt: {
            description: "Started timestamp (ISO DateTime, null to remove)",
            type: [
              "string",
              "null",
            ],
          },
          completedAt: {
            description: "Completed timestamp (ISO DateTime, null to remove)",
            type: [
              "string",
              "null",
            ],
          },
          commitSha: {
            description: "Commit SHA associated with the release",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "list_release_notes",
      upstreamName: "list_release_notes",
      description: "List release notes, optionally filtered by pipeline, release or a search query.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          query: {
            description: "Search release notes title",
            type: "string",
          },
          pipeline: {
            description: "Release pipeline ID, slug, or exact name",
            type: "string",
          },
          release: {
            description: "Release ID or slug",
            type: "string",
          },
          includeContent: {
            default: false,
            description: "Include markdown release notes content",
            type: "boolean",
          },
          includeReleases: {
            default: false,
            description: "Include associated releases",
            type: "boolean",
          },
          createdAt: {
            description: "Created after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          updatedAt: {
            description: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_release_note",
      upstreamName: "get_release_note",
      description: "Read one release note by id or slug, including its markdown.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Release notes ID or slug",
          },
          includeReleases: {
            default: false,
            description: "Include associated releases",
            type: "boolean",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_release_note",
      upstreamName: "save_release_note",
      description: "Create or edit published release-note text and its associated releases in Linear.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            description: "Release notes ID or slug to update. Omit to create new release notes.",
            type: "string",
          },
          pipeline: {
            description: "Release pipeline ID, slug, or exact name (required when creating)",
            type: "string",
          },
          title: {
            description: "Release notes title",
            type: "string",
          },
          content: {
            description: "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)",
            type: "string",
          },
          patch: {
            description: "Partial edits applied to the current content, in order and atomically (one failing operation aborts the whole save). Every anchor string must match the current content exactly once. Only valid on update, in place of the full content/description field",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "replace",
                    },
                    old_string: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to replace. Must match the current content exactly once",
                    },
                    new_string: {
                      type: "string",
                      description: "Replacement text. Empty string deletes the match",
                    },
                    replace_all: {
                      description: "Replace every occurrence instead of requiring a unique match",
                      type: "boolean",
                    },
                  },
                  required: [
                    "op",
                    "old_string",
                    "new_string",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "insert_before",
                    },
                    anchor: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to insert before. Must match the current content exactly once",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert directly before the anchor. Include separators (e.g. \"\\n\\n\")",
                    },
                  },
                  required: [
                    "op",
                    "anchor",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "insert_after",
                    },
                    anchor: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text to insert after. Must match the current content exactly once",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert directly after the anchor. Include separators (e.g. \"\\n\\n\")",
                    },
                  },
                  required: [
                    "op",
                    "anchor",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "prepend",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert at the very start of the content",
                    },
                  },
                  required: [
                    "op",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "append",
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      description: "Text to insert at the very end of the content",
                    },
                  },
                  required: [
                    "op",
                    "text",
                  ],
                },
                {
                  type: "object",
                  properties: {
                    op: {
                      type: "string",
                      const: "replace_range",
                    },
                    from: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text where the range starts (inclusive). Must match exactly once",
                    },
                    to: {
                      type: "string",
                      minLength: 1,
                      description: "Exact text where the range ends (exclusive, stays in place). Must match exactly once after `from`",
                    },
                    new_string: {
                      type: "string",
                      description: "Text replacing the range. Empty string deletes it",
                    },
                  },
                  required: [
                    "op",
                    "from",
                    "to",
                    "new_string",
                  ],
                },
              ],
            },
          },
          releases: {
            description: "Release IDs or slugs to include in the note",
            type: "array",
            items: {
              type: "string",
            },
          },
          rangeFromRelease: {
            description: "Oldest release ID or slug in the note range",
            type: "string",
          },
          rangeToRelease: {
            description: "Newest release ID or slug in the note range",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "share_issue",
      upstreamName: "share_issue",
      description: "Give the specified user access to a Linear issue.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          issue: {
            type: "string",
            description: "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues",
          },
          user: {
            type: "string",
            description: "User ID, name, email, or \"me\" Must be an email address or UUID.",
          },
        },
        required: [
          "issue",
          "user",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "unshare_issue",
      upstreamName: "unshare_issue",
      description: "Remove the specified user from the sharing list of a Linear issue.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          issue: {
            type: "string",
            description: "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues",
          },
          user: {
            type: "string",
            description: "User ID, name, email, or \"me\" Must be an email address or UUID.",
          },
        },
        required: [
          "issue",
          "user",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: false,
    },
    {
      name: "list_milestones",
      upstreamName: "list_milestones",
      description: "List the milestones of one project.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
          },
        },
        required: [
          "project",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_milestone",
      upstreamName: "get_milestone",
      description: "Read one project milestone by id or name.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
          },
          query: {
            type: "string",
            description: "Milestone name or ID",
          },
        },
        required: [
          "project",
          "query",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_milestone",
      upstreamName: "save_milestone",
      description: "Create or edit a milestone in a Linear project.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
          },
          id: {
            description: "Milestone name or ID",
            type: "string",
          },
          name: {
            description: "Milestone name (required when creating)",
            type: "string",
          },
          description: {
            description: "Milestone description",
            type: "string",
          },
          targetDate: {
            description: "Target completion date (ISO format, null to remove)",
            type: [
              "string",
              "null",
            ],
          },
        },
        required: [
          "project",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "get_notifications",
      upstreamName: "get_notifications",
      description: "Read a page of the connected account's notifications, optionally the unread ones only.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          unreadOnly: {
            default: false,
            description: "Only return unread notifications",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "mark_notification",
      upstreamName: "mark_notification",
      description: "Change a Linear notification to read or unread, or change when it is snoozed until.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Notification ID",
          },
          read: {
            description: "Whether the notification should be marked as read",
            type: "boolean",
          },
          snoozedUntilAt: {
            description: "ISO-8601 time to snooze until, or null to unsnooze",
            anyOf: [
              {
                type: "string",
                format: "date-time",
                pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
      irreversible: false,
    },
    {
      name: "list_teams",
      upstreamName: "list_teams",
      description: "List the workspace's teams.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          query: {
            description: "Search query",
            type: "string",
          },
          parentTeam: {
            description: "Only direct sub-teams of this team (name, key, or ID)",
            type: "string",
          },
          ancestorTeam: {
            description: "All descendant teams of this team, at any depth, excluding itself (name, key, or ID)",
            type: "string",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
          createdAt: {
            description: "Created after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          updatedAt: {
            description: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_team",
      upstreamName: "get_team",
      description: "Read one team by name or id.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Team UUID, key, or name",
          },
        },
        required: [
          "query",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_triage_responsibility",
      upstreamName: "get_triage_responsibility",
      description: "Read a team's triage rotation: who is on triage now, what triage does, and the upcoming shifts.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          team: {
            type: "string",
            description: "Team name or ID",
          },
          user: {
            description: "Only return shifts of this user: User ID, name, email, or \"me\"",
            type: "string",
          },
          limit: {
            default: 10,
            description: "Max upcoming shifts to return (default 10, max 50)",
            type: "integer",
            minimum: 1,
            maximum: 50,
          },
        },
        required: [
          "team",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "list_templates",
      upstreamName: "list_templates",
      description: "List issue and project templates, optionally for one team.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            description: "Filter by template type. Omit to return every type",
            type: "string",
            enum: [
              "issue",
              "project",
              "document",
            ],
          },
          team: {
            description: "Team name or ID. Returns that team's templates plus workspace-level ones",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_template",
      upstreamName: "get_template",
      description: "Read one template by id.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Template ID or name",
          },
        },
        required: [
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "list_users",
      upstreamName: "list_users",
      description: "List workspace users, optionally filtered by team or a search query.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          query: {
            description: "Match part of a name or email. Omit to list users without a name or email filter",
            type: "string",
          },
          team: {
            description: "Team name or ID. Only return members of this team; omit to search the workspace",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_user",
      upstreamName: "get_user",
      description: "Read one user by name, email or id.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "User ID, name, email, or \"me\"",
          },
        },
        required: [
          "query",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_workspace",
      upstreamName: "get_workspace",
      description: "Read the connected workspace.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {},
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "search_documentation",
      upstreamName: "search_documentation",
      description: "Search Linear's documentation for how a feature works.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Feature name, topic, or question to search for in Linear's product documentation",
          },
          page: {
            default: 0,
            description: "Zero-based page number. Increment by one to fetch the next page for the same query",
            type: "number",
          },
        },
        required: [
          "query",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_diff",
      upstreamName: "get_diff",
      description: "Exact lookup for a Linear diff. Review URLs and GitHub PR URLs are lookup keys in Linear, not fetch targets.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          urlOrId: {
            type: "string",
            minLength: 1,
            description: "Linear review URL, diff slug, pull request ID, Linear full identifier, or GitHub PR URL",
          },
        },
        required: [
          "urlOrId",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "list_diffs",
      upstreamName: "list_diffs",
      description: "List the diffs this account can see, optionally filtered by owner, repository, status, author or reviewer.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          query: {
            description: "Broad search by title, branch, PR number, or bare slug",
            type: "string",
          },
          owner: {
            description: "Filter returned diffs by repository owner",
            type: "string",
          },
          repo: {
            description: "Filter returned diffs by repository name",
            type: "string",
          },
          status: {
            description: "Filter returned diffs by pull request status",
            type: "string",
          },
          author: {
            description: "Filter by author ID, name, email, or \"me\"",
            type: "string",
          },
          reviewer: {
            description: "Filter by reviewer ID, name, email, or \"me\"",
            type: "string",
          },
          reviewState: {
            description: "Reviewer state; requires reviewer and defaults to pending when reviewer is set",
            type: "string",
            enum: [
              "pending",
              "approved",
              "changesRequested",
              "commented",
              "dismissed",
            ],
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "get_diff_threads",
      upstreamName: "get_diff_threads",
      description: "Read review threads for the exact Linear diff lookup; supplied URLs are lookup keys, not fetch targets.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          urlOrId: {
            type: "string",
            minLength: 1,
            description: "Linear review URL, diff slug, pull request ID, Linear full identifier, or GitHub PR URL",
          },
          threadId: {
            description: "Optional Linear comment UUID of any comment in the thread (not its `externalThreadId`); a reply's UUID resolves to its thread root",
            type: "string",
          },
          resolved: {
            description: "Filter returned threads by resolved state",
            type: "boolean",
          },
          orderBy: {
            default: "updatedAt",
            description: "Sort: createdAt | updatedAt",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
        },
        required: [
          "urlOrId",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_diff_comment",
      upstreamName: "save_diff_comment",
      description: "Create or edit a comment or draft on a Linear diff, including inline anchors and replies.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          urlOrId: {
            description: "Linear review URL, diff slug, pull request ID, Linear full identifier, or GitHub PR URL",
            type: "string",
            minLength: 1,
          },
          commentId: {
            description: "Existing comment ID to edit",
            type: "string",
          },
          draftId: {
            description: "Existing persisted draft ID to edit or submit",
            type: "string",
          },
          draft: {
            default: false,
            description: "Save as a private persisted draft without submitting",
            type: "boolean",
          },
          parentId: {
            description: "Top-level comment ID to reply to; also required when submitting a persisted reply draft",
            type: "string",
          },
          body: {
            type: "string",
            minLength: 1,
            description: "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences",
          },
          anchor: {
            description: "Optional comment anchor copied from a diff thread or built for a file or diff hunk",
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {},
          },
          anchorContent: {
            description: "Exact source text of the anchor's end line; stored with an inline draft so it can be re-anchored after the diff receives new revisions",
            type: "string",
          },
        },
        required: [
          "body",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "resolve_diff_thread",
      upstreamName: "resolve_diff_thread",
      description: "Resolve or reopen a discussion thread on a Linear diff.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            minLength: 1,
            description: "Top-level diff thread/comment ID",
          },
          resolved: {
            default: true,
            description: "True to resolve the thread; false to reopen it",
            type: "boolean",
          },
        },
        required: [
          "threadId",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: false,
    },
    {
      name: "delete_diff_comment",
      upstreamName: "delete_diff_comment",
      description: "Delete a comment or draft from a Linear diff.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          commentId: {
            description: "Submitted diff comment ID to delete",
            type: "string",
            minLength: 1,
          },
          draftId: {
            description: "Persisted diff comment draft ID to delete",
            type: "string",
            minLength: 1,
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "submit_diff_review",
      upstreamName: "submit_diff_review",
      description: "Publish a review of a Linear diff, with approval, requested changes or a comment.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          urlOrId: {
            type: "string",
            minLength: 1,
            description: "Linear review URL, diff slug, pull request ID, Linear full identifier, or GitHub PR URL",
          },
          decision: {
            type: "string",
            enum: [
              "approved",
              "changesRequested",
              "commented",
            ],
            description: "Review decision: approved, changesRequested, or commented",
          },
          body: {
            description: "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. Required when requesting changes or commenting",
            type: "string",
            minLength: 1,
          },
        },
        required: [
          "urlOrId",
          "decision",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "update_diff",
      upstreamName: "update_diff",
      description: "Edit a Linear diff and its review requests, issue links or status.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          urlOrId: {
            type: "string",
            minLength: 1,
            description: "Linear review URL, diff slug, pull request ID, Linear full identifier, or GitHub PR URL",
          },
          title: {
            description: "New diff title",
            type: "string",
            minLength: 1,
          },
          description: {
            description: "New description as Markdown; an empty string clears it",
            type: "string",
          },
          addedReviewRequests: {
            description: "Request or re-request reviews; existing pending requests are unchanged",
            minItems: 1,
            maxItems: 25,
            type: "array",
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    user: {
                      type: "string",
                      minLength: 1,
                      description: "Workspace user ID, name, email, or \"me\"",
                    },
                  },
                  required: [
                    "user",
                  ],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    externalUserId: {
                      type: "string",
                      format: "uuid",
                      pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                      description: "External user ID from get_diff reviewer metadata",
                    },
                  },
                  required: [
                    "externalUserId",
                  ],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    githubTeamId: {
                      type: "string",
                      format: "uuid",
                      pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                      description: "GitHub team ID from get_diff reviewer metadata",
                    },
                  },
                  required: [
                    "githubTeamId",
                  ],
                  additionalProperties: false,
                },
              ],
            },
          },
          removedReviewRequests: {
            description: "Withdraw pending review requests; submitted reviews are preserved",
            minItems: 1,
            maxItems: 25,
            type: "array",
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    user: {
                      type: "string",
                      minLength: 1,
                      description: "Workspace user ID, name, email, or \"me\"",
                    },
                  },
                  required: [
                    "user",
                  ],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    externalUserId: {
                      type: "string",
                      format: "uuid",
                      pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                      description: "External user ID from get_diff reviewer metadata",
                    },
                  },
                  required: [
                    "externalUserId",
                  ],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    githubTeamId: {
                      type: "string",
                      format: "uuid",
                      pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                      description: "GitHub team ID from get_diff reviewer metadata",
                    },
                  },
                  required: [
                    "githubTeamId",
                  ],
                  additionalProperties: false,
                },
              ],
            },
          },
          addedIssueLinks: {
            description: "Add issue links or change the relationship of an existing link",
            minItems: 1,
            maxItems: 25,
            type: "array",
            items: {
              type: "object",
              properties: {
                issue: {
                  type: "string",
                  minLength: 1,
                  description: "Linear issue identifier or UUID",
                },
                type: {
                  type: "string",
                  enum: [
                    "closes",
                    "contributes",
                    "links",
                    "reopens",
                  ],
                  description: "Relationship: closes, contributes, links, or reopens",
                },
              },
              required: [
                "issue",
                "type",
              ],
              additionalProperties: false,
            },
          },
          removedIssueLinks: {
            description: "Linear issue identifiers or UUIDs to unlink",
            minItems: 1,
            maxItems: 25,
            type: "array",
            items: {
              type: "string",
              minLength: 1,
            },
          },
          statusAction: {
            description: "Status transition to perform after metadata is updated",
            type: "string",
            enum: [
              "markReadyForReview",
              "convertToDraft",
              "close",
              "reopen",
            ],
          },
        },
        required: [
          "urlOrId",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "merge_diff",
      upstreamName: "merge_diff",
      description: "Merge a Linear diff or place it in its repository's merge queue.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          urlOrId: {
            type: "string",
            minLength: 1,
            description: "Linear review URL, diff slug, pull request ID, Linear full identifier, or GitHub PR URL",
          },
          mergeMethod: {
            description: "Merge method; omit to use the repository default",
            type: "string",
            enum: [
              "MERGE",
              "REBASE",
              "SQUASH",
            ],
          },
        },
        required: [
          "urlOrId",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "get_status_updates",
      upstreamName: "get_status_updates",
      description: "List project status updates of one type, optionally for a project, initiative or user, or one update by id.",
      class: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            default: 50,
            description: "Maximum number of results to return per page",
            type: "number",
            maximum: 250,
          },
          cursor: {
            description: "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true",
            type: "string",
          },
          orderBy: {
            default: "updatedAt",
            description: "Timestamp to sort results by: creation time or last update time",
            type: "string",
            enum: [
              "createdAt",
              "updatedAt",
            ],
          },
          type: {
            type: "string",
            enum: [
              "project",
              "initiative",
            ],
            description: "Type of status update",
          },
          id: {
            description: "Update ID from get_status_updates results (statusUpdates[].id) or save_status_update's id",
            type: "string",
          },
          project: {
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug. Filters project updates only; omit to include all accessible projects",
            type: "string",
          },
          initiative: {
            description: "Initiative name, ID, identifier (e.g., I-123), or slug. Filters initiative updates only; omit to include all accessible initiatives",
            type: "string",
          },
          user: {
            description: "Filter by update author: User ID, name, email, or \"me\". Omit to include all authors",
            type: "string",
          },
          createdAt: {
            description: "Created after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          updatedAt: {
            description: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
            type: "string",
          },
          includeArchived: {
            default: false,
            description: "Include archived items",
            type: "boolean",
          },
        },
        required: [
          "type",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    {
      name: "save_status_update",
      upstreamName: "save_status_update",
      description: "Create or edit a project or initiative status update in Linear.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "project",
              "initiative",
            ],
            description: "Type of status update",
          },
          id: {
            description: "Update ID from get_status_updates results (statusUpdates[].id) or save_status_update's id. Omit to create",
            type: "string",
          },
          project: {
            description: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
            type: "string",
          },
          initiative: {
            description: "Initiative name, ID, identifier (e.g., I-123), or slug",
            type: "string",
          },
          body: {
            description: "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe). Required on create; replaces the body on update. Omit on update to leave the body unchanged",
            type: "string",
          },
          health: {
            description: "onTrack | atRisk | offTrack",
            type: "string",
            enum: [
              "onTrack",
              "atRisk",
              "offTrack",
            ],
          },
          isDiffHidden: {
            description: "Deprecated. Hide diff with previous update (create only)",
            type: "boolean",
          },
        },
        required: [
          "type",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
    {
      name: "delete_status_update",
      upstreamName: "delete_status_update",
      description: "Delete a project or initiative status update in Linear.",
      class: "write",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "project",
              "initiative",
            ],
            description: "Type of status update",
          },
          id: {
            type: "string",
            description: "Update ID from get_status_updates results (statusUpdates[].id) or save_status_update's id; type must match the update",
          },
        },
        required: [
          "type",
          "id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      irreversible: true,
    },
  ],
};
