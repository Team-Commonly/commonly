/**
 * Asana hosted MCP. Pinned from a consenting tools/list capture at
 * 2026-10-19T07:15:23.899Z against https://mcp.asana.com/v2/mcp.
 * V2 needs a pre-registered confidential client. Its OAuth response adds the
 * identity scope to the requested default scope; the callback records both.
 * Internal MCP-App widgets and *_confirm tools are not pinned: Commonly uses
 * its own credential-owner approval for each direct write.
 */
import type { HostedMcpEntry } from '../../services/hostedMcpEntryService';

export const ASANA_ENTRY: HostedMcpEntry = {
  id: 'asana',
  title: 'Asana',
  description: 'Projects and tasks in your Asana workspace.',
  resource: 'https://mcp.asana.com/v2/mcp',
  issuer: 'https://app.asana.com',
  client: 'pre-registered',
  scopes: ['default'],
  responseOnlyScopes: ['identity'],
  revoke: {
    page: 'https://help.asana.com/s/article/apps-settings',
    endpoint: 'https://app.asana.com/-/oauth_revoke',
  },
  tools: [
    {
      name: 'get_attachments',
      upstreamName: 'get_attachments',
      description: 'List attachments on an Asana object.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          parent: {
            type: "string",
            description: "The GID of the parent project, project_brief, or task to retrieve attachments for. Must be a GID for a project, project_brief, or task.",
          },
          limit: {
            description: "Results per page (1-100)",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          offset: {
            description: "Pagination offset token",
            type: "string",
          },
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported.",
            type: "string",
          },
        },
        required: [
          "parent",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_project',
      upstreamName: 'get_project',
      description: 'Read one Asana project.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "Globally unique identifier for the project.",
          },
          include_sections: {
            default: false,
            description: "Set to true to include the project's sections (up to 50) in the response.",
            type: "boolean",
          },
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported.",
            type: "string",
          },
        },
        required: [
          "project_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_projects',
      upstreamName: 'get_projects',
      description: 'List projects in an Asana workspace or team.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          team: {
            description: "When passed in, filters projects on team GID",
            type: "string",
          },
          archived: {
            default: false,
            description: "Include archived projects.",
            type: "boolean",
          },
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported.",
            type: "string",
          },
          limit: {
            default: 20,
            description: "Number of projects to return per page (1-100). Defaults to 20.",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          offset: {
            description: "Pagination offset token from the next_page field of a previous response. If omitted, returns the first page of results.",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'create_project',
      upstreamName: 'create_project',
      description: 'Create an Asana project.',
      class: 'write',
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the project.",
          },
          team: {
            description: "Globally unique identifier for the team. If not provided, default team will be used.",
            type: "string",
          },
          notes: {
            description: "Plain-text project description. Use html_notes for rich formatting or @-mentions.",
            type: "string",
          },
          html_notes: {
            description: "HTML-formatted project description. Use notes for plain text. Allowed elements only: <body>, <strong>, <em>, <u>, <s>, <code>, <ol>, <ul>, <li>, <a>, <blockquote>, <pre>. Must be well-formed XML with a single root <body>...</body>. Only <a> may have custom attributes; any attribute on any other element is invalid. Do not use elements outside the allowed list (400). . <a> links: For <a> tags specifically, to make it easier to create @-mentions through the API, we only require that you provide the GID of the object you wish to reference. If you have access to that object, the API will automatically generate the appropriate href and other attributes for you. For example, to create a link to a task with GID \"123\", you can send the tag <a data-asana-gid=\"123\"/> which will then be expanded to <a href=\"https://app.asana.com/0/0/123/f\" data-asana-accessible=\"true\" data-asana-dynamic=\"true\" data-asana-type=\"task\" data-asana-gid=\"123\">Task Name</a>. You can also generate a link to a task in a specific project or tag by including a data-asana-project or data-asana-tag attribute in the <a> tag. All other attributes, as well as the contents of the tag, are ignored.\n\nTo keep the contents of your tag and make a custom vanity link, include the property data-asana-dynamic=\"false\" when setting the contents of the tag. You would send <a data-asana-gid=\"123\" data-asana-dynamic=\"false\">This is some custom text!</a> and receive <a data-asana-accessible=\"true\" data-asana-dynamic=\"false\" data-asana-type=\"task\" data-asana-gid=\"123\">This is some custom text!</a>\n\nIf you do not have access to the referenced object when you try to create a link, the API will not generate an href for you, but will instead look for an href you provide. This allows you to write back <a> tags unmodified even if you do not have access to the resource. If you do not have access to the referenced object and no href is provided, your request will be rejected with a 400 Bad Request error. Similarly, if you provide neither a GID nor a valid href, the request will be rejected with the same error.",
            type: "string",
          },
          owner: {
            description: "User identifier for project owner. Can be \"me\", an email, or a user GID. Prefer using \"me\" for the current user rather than calling get_me to look up the GID of the current user.",
            type: "string",
          },
          due_on: {
            description: "Date on which this project is due (YYYY-MM-DD).",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          start_on: {
            description: "Date on which this project is started (YYYY-MM-DD).",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          color: {
            description: "Color of the project (light-green, dark-green, light-blue, dark-blue, etc).",
            type: "string",
            enum: [
              "dark-pink",
              "dark-green",
              "dark-blue",
              "dark-red",
              "dark-teal",
              "dark-brown",
              "dark-orange",
              "dark-purple",
              "dark-warm-gray",
              "light-pink",
              "light-green",
              "light-blue",
              "light-red",
              "light-teal",
              "light-brown",
              "light-orange",
              "light-purple",
              "light-warm-gray",
              "none",
            ],
          },
          privacy_setting: {
            description: "Privacy level for the project (public_to_workspace, private_to_team, private).",
            type: "string",
            enum: [
              "public_to_workspace",
              "private_to_team",
              "private",
            ],
          },
          default_view: {
            description: "The default view of the project (list, board, calendar, timeline).",
            default: "list",
            type: "string",
            enum: [
              "list",
              "board",
              "calendar",
              "timeline",
            ],
          },
          default_access_level: {
            description: "The default access for users or teams who join or are added as members to the project.",
            type: "string",
            enum: [
              "admin",
              "editor",
              "commenter",
              "viewer",
            ],
          },
          custom_fields: {
            description: "Custom field: each key is a custom field GID; each value matches that field's type in the Asana API. Use option GIDs for dropdown fields, not display names. Some tools expect a nested object; others expect one JSON string containing the same map. Examples: {\"1200456789012345\":\"1200123456789012\"} (single-select); {\"1200456789012346\":12.5} (number); {\"1200456789012347\":\"Ship by Friday\"} (text); {\"1200456789012348\":[\"1200111111111111\",\"1200222222222222\"]} (multi-select); {\"1200456789012349\":{\"date\":\"2025-06-15\"}} or {\"1200456789012349\":{\"date_time\":\"2025-06-15T17:00:00.000Z\"}} (date).",
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
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                {
                  type: "object",
                  propertyNames: {
                    type: "string",
                  },
                  additionalProperties: {},
                },
              ],
            },
          },
          members: {
            description: "Comma-separated user GIDs to add as project members. Example: \"123456,789012\".",
            type: "string",
          },
          sections: {
            description: "Sections to create. Each section requires sectionName and may include tasks to create in that section. Use the nested task fields for descriptions, assignees, dates, followers, and custom-field values.",
            type: "array",
            items: {
              type: "object",
              properties: {
                sectionName: {
                  type: "string",
                  description: "Name of the section",
                },
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: {
                        type: "string",
                        description: "Name of the task.",
                      },
                      parent: {
                        description: "Parent task GID to create this as a subtask.",
                        type: "string",
                      },
                      html_notes: {
                        description: "HTML-formatted task description. Use notes for plain text. Allowed elements only: <body>, <strong>, <em>, <u>, <s>, <code>, <ol>, <ul>, <li>, <a>, <blockquote>, <pre>, <h1>, <h2>, <hr/>, <img>, <table>, <tr>, <td>. Tables use only <table>, <tr>, and <td>; <thead>, <tbody>, and <th> are invalid. For a header row, wrap the contents of each <td> in the first <tr> in <strong>. Must be well-formed XML with a single root <body>...</body>. Only <a> may have custom attributes; any attribute on any other element is invalid. Do not use elements outside the allowed list (400). . <a> links: For <a> tags specifically, to make it easier to create @-mentions through the API, we only require that you provide the GID of the object you wish to reference. If you have access to that object, the API will automatically generate the appropriate href and other attributes for you. For example, to create a link to a task with GID \"123\", you can send the tag <a data-asana-gid=\"123\"/> which will then be expanded to <a href=\"https://app.asana.com/0/0/123/f\" data-asana-accessible=\"true\" data-asana-dynamic=\"true\" data-asana-type=\"task\" data-asana-gid=\"123\">Task Name</a>. You can also generate a link to a task in a specific project or tag by including a data-asana-project or data-asana-tag attribute in the <a> tag. All other attributes, as well as the contents of the tag, are ignored.\n\nTo keep the contents of your tag and make a custom vanity link, include the property data-asana-dynamic=\"false\" when setting the contents of the tag. You would send <a data-asana-gid=\"123\" data-asana-dynamic=\"false\">This is some custom text!</a> and receive <a data-asana-accessible=\"true\" data-asana-dynamic=\"false\" data-asana-type=\"task\" data-asana-gid=\"123\">This is some custom text!</a>\n\nIf you do not have access to the referenced object when you try to create a link, the API will not generate an href for you, but will instead look for an href you provide. This allows you to write back <a> tags unmodified even if you do not have access to the resource. If you do not have access to the referenced object and no href is provided, your request will be rejected with a 400 Bad Request error. Similarly, if you provide neither a GID nor a valid href, the request will be rejected with the same error.",
                        type: "string",
                      },
                      notes: {
                        description: "Plain-text task description. Use html_notes for rich formatting or @-mentions.",
                        type: "string",
                      },
                      assignee: {
                        description: "User identifier for task assignment. If the assignee should be the currently authenticated user, use \"me\". Otherwise, use an email address or a user GID. When used without project_id, workspace is also required.",
                        type: "string",
                      },
                      due_on: {
                        description: "Due date in ISO 8601 format (YYYY-MM-DD).",
                        type: "string",
                        format: "date",
                        pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                      },
                      due_at: {
                        description: "Due date and time in ISO 8601 format.",
                        type: "string",
                        format: "date-time",
                        pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                      },
                      resource_subtype: {
                        default: "default_task",
                        description: "Task type (default_task, milestone, approval).",
                        type: "string",
                        enum: [
                          "default_task",
                          "milestone",
                          "approval",
                        ],
                      },
                      completed: {
                        description: "True if the task is initially marked complete.",
                        type: "boolean",
                      },
                      approval_status: {
                        description: "Approval status (pending, approved, rejected, changes_requested).",
                        type: "string",
                        enum: [
                          "pending",
                          "approved",
                          "rejected",
                          "changes_requested",
                        ],
                      },
                      assignee_section: {
                        description: "Section GID to place task in the assignee's My Tasks list.",
                        type: "string",
                      },
                      followers: {
                        description: "Comma-separated list of user identifiers. Can be \"me\", email addresses, or user GIDs.",
                        type: "string",
                      },
                      start_on: {
                        description: "Start date in ISO 8601 format (YYYY-MM-DD).",
                        type: "string",
                        format: "date",
                        pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                      },
                      start_at: {
                        description: "Start date and time in ISO 8601 format.",
                        type: "string",
                        format: "date-time",
                        pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                      },
                      custom_fields: {
                        description: "Custom field: each key is a custom field GID; each value matches that field's type in the Asana API. Use option GIDs for dropdown fields, not display names. Some tools expect a nested object; others expect one JSON string containing the same map. Examples: {\"1200456789012345\":\"1200123456789012\"} (single-select); {\"1200456789012346\":12.5} (number); {\"1200456789012347\":\"Ship by Friday\"} (text); {\"1200456789012348\":[\"1200111111111111\",\"1200222222222222\"]} (multi-select); {\"1200456789012349\":{\"date\":\"2025-06-15\"}} or {\"1200456789012349\":{\"date_time\":\"2025-06-15T17:00:00.000Z\"}} (date).",
                        type: "string",
                      },
                    },
                    required: [
                      "name",
                    ],
                  },
                },
              },
              required: [
                "sectionName",
              ],
            },
          },
        },
        required: [
          "name",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: 'update_project',
      upstreamName: 'update_project',
      description: 'Update an Asana project.',
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "Globally unique identifier for the project to update.",
          },
          name: {
            description: "New project name.",
            type: "string",
          },
          notes: {
            description: "Plain-text project description. Use html_notes for rich formatting or @-mentions.",
            type: "string",
          },
          html_notes: {
            description: "HTML-formatted project description. Must be wrapped in <body></body> tags.",
            type: "string",
          },
          owner: {
            description: "New project owner. Can be \"me\", an email, or a user GID. Use null to clear.",
            type: [
              "string",
              "null",
            ],
          },
          due_on: {
            description: "New due date (YYYY-MM-DD). Use null to clear.",
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
          start_on: {
            description: "New start date (YYYY-MM-DD). due_on must also be provided when changing start_on. Use null to clear.",
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
          color: {
            description: "New project color. Use null to clear.",
            anyOf: [
              {
                type: "string",
                enum: [
                  "dark-pink",
                  "dark-green",
                  "dark-blue",
                  "dark-red",
                  "dark-teal",
                  "dark-brown",
                  "dark-orange",
                  "dark-purple",
                  "dark-warm-gray",
                  "light-pink",
                  "light-green",
                  "light-blue",
                  "light-red",
                  "light-teal",
                  "light-brown",
                  "light-orange",
                  "light-purple",
                  "light-warm-gray",
                  "none",
                ],
              },
              {
                type: "null",
              },
            ],
          },
          icon: {
            description: "New project icon. Use null to clear.",
            anyOf: [
              {
                type: "string",
                enum: [
                  "list",
                  "board",
                  "timeline",
                  "calendar",
                  "rocket",
                  "people",
                  "graph",
                  "star",
                  "bug",
                  "light_bulb",
                  "globe",
                  "gear",
                  "notebook",
                  "computer",
                  "check",
                  "target",
                  "html",
                  "megaphone",
                  "chat_bubbles",
                  "briefcase",
                  "page_layout",
                  "mountain_flag",
                  "puzzle",
                  "presentation",
                  "line_and_symbols",
                  "speed_dial",
                  "ribbon",
                  "shoe",
                  "shopping_basket",
                  "map",
                  "ticket",
                  "coins",
                ],
              },
              {
                type: "null",
              },
            ],
          },
          default_view: {
            description: "New default project view.",
            type: "string",
            enum: [
              "list",
              "board",
              "calendar",
              "timeline",
            ],
          },
          privacy_setting: {
            description: "New project privacy. Making the project public to the workspace requires explicit user confirmation.",
            type: "string",
            enum: [
              "public_to_workspace",
              "private_to_team",
              "private",
            ],
          },
          default_access_level: {
            description: "New default access for members added to the project. Requires explicit user confirmation.",
            type: "string",
            enum: [
              "admin",
              "editor",
              "commenter",
              "viewer",
            ],
          },
          archived: {
            description: "Whether the project should be archived.",
            type: "boolean",
          },
          set_custom_field_values: {
            description: "Custom-field values to set on the project itself. This does not make fields available on the project's tasks. Custom field: each key is a custom field GID; each value matches that field's type in the Asana API. Use option GIDs for dropdown fields, not display names. Some tools expect a nested object; others expect one JSON string containing the same map. Examples: {\"1200456789012345\":\"1200123456789012\"} (single-select); {\"1200456789012346\":12.5} (number); {\"1200456789012347\":\"Ship by Friday\"} (text); {\"1200456789012348\":[\"1200111111111111\",\"1200222222222222\"]} (multi-select); {\"1200456789012349\":{\"date\":\"2025-06-15\"}} or {\"1200456789012349\":{\"date_time\":\"2025-06-15T17:00:00.000Z\"}} (date).",
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
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                {
                  type: "object",
                  propertyNames: {
                    type: "string",
                  },
                  additionalProperties: {},
                },
              ],
            },
          },
          add_sections: {
            description: "Sections to add to the project.",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Name of the new section.",
                },
              },
              required: [
                "name",
              ],
            },
          },
          rename_sections: {
            description: "Existing sections to rename.",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "object",
              properties: {
                section_id: {
                  type: "string",
                  description: "GID of the section to rename.",
                },
                name: {
                  type: "string",
                  description: "New section name.",
                },
              },
              required: [
                "section_id",
                "name",
              ],
            },
          },
          remove_sections: {
            description: "Sections to delete. Asana only permits deleting empty sections that are not the project's last section; tasks are never deleted.",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "string",
              description: "GID of an existing section to delete.",
            },
          },
          add_members: {
            description: "Users to add as project members after explicit user confirmation. They will gain access to the project and all tasks in it. Accepts \"me\", email addresses, or GIDs.",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "string",
            },
          },
          remove_members: {
            description: "Users to remove from project membership. Accepts \"me\", email addresses, or GIDs.",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "string",
            },
          },
          add_custom_fields: {
            description: "Existing custom fields to make available on tasks in this project. This does not set values on the project itself.",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "object",
              properties: {
                custom_field: {
                  type: "string",
                  description: "GID of an existing custom field to add to the project.",
                },
                is_important: {
                  description: "Whether to show the field prominently in the project.",
                  type: "boolean",
                },
              },
              required: [
                "custom_field",
              ],
            },
          },
          remove_custom_fields: {
            description: "Custom fields to remove from this project's task field settings. Existing values remain on tasks but may become disabled.",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "string",
              description: "GID of an existing custom field to remove.",
            },
          },
          confirm_sensitive_changes: {
            description: "Set to true only after the user explicitly confirms every sensitive effect returned by a prior update_project call. Never infer confirmation from the original update request.",
            type: "boolean",
          },
        },
        required: [
          "project_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'search_tasks',
      upstreamName: 'search_tasks',
      description: 'Search tasks in an Asana workspace.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          text: {
            description: "Text to search for in task name or description.",
            type: "string",
          },
          resource_subtype: {
            description: "Filters results by the task's resource_subtype (e.g., milestone).",
            type: "string",
            enum: [
              "default_task",
              "milestone",
              "approval",
            ],
          },
          completed: {
            description: "Filter for completed or incomplete tasks.",
            type: "boolean",
          },
          is_subtask: {
            description: "Filter to subtasks.",
            type: "boolean",
          },
          assignee_any: {
            description: "Filter to tasks assigned to any of these users. Comma-separated list of user identifiers (\"me\", an email, or a user GID).",
            type: "string",
          },
          followers_any: {
            description: "Filter to tasks followed by any of these users. Comma-separated list of user identifiers (\"me\", an email, or a user GID).",
            type: "string",
          },
          created_by_any: {
            description: "Filter to tasks created by any of these users. Comma-separated list of user identifiers (\"me\", an email, or a user GID).",
            type: "string",
          },
          projects_any: {
            description: "Filter to tasks in any of these projects. Comma-separated list of project GIDs.",
            type: "string",
          },
          sections_any: {
            description: "Filter to tasks in any of these sections or columns. Comma-separated list of section GIDs.",
            type: "string",
          },
          tags_any: {
            description: "Filter to tasks with any of these tags. Comma-separated list of tag GIDs.",
            type: "string",
          },
          due_on_before: {
            description: "ISO 8601 date string for due date before filter.",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          due_on_after: {
            description: "ISO 8601 date string for due date after filter.",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          due_on: {
            description: "ISO 8601 date string for due date filter.",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          created_on_before: {
            description: "ISO 8601 date string for creation date before filter.",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          created_on_after: {
            description: "ISO 8601 date string for creation date after filter.",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          created_at_before: {
            description: "ISO 8601 datetime string for creation datetime before filter.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          created_at_after: {
            description: "ISO 8601 datetime string for creation datetime after filter.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          completed_on_before: {
            description: "ISO 8601 date string for completion date before filter.",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          completed_on_after: {
            description: "ISO 8601 date string for completion date after filter.",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          completed_at_before: {
            description: "ISO 8601 datetime string for completion datetime before filter.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          completed_at_after: {
            description: "ISO 8601 datetime string for completion datetime after filter.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          modified_on_after: {
            description: "ISO 8601 date string for modified date after filter.",
            type: "string",
            format: "date",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
          },
          modified_at_after: {
            description: "ISO 8601 datetime string for modified datetime after filter.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          sort_by: {
            default: "modified_at",
            description: "Field to sort by (e.g., 'due_date', 'created_at', 'completed_at', 'likes', 'modified_at'). Defaults to modified_at.",
            type: "string",
            enum: [
              "due_date",
              "created_at",
              "completed_at",
              "likes",
              "modified_at",
            ],
          },
          sort_ascending: {
            default: false,
            description: "Sort in ascending order. Defaults to false.",
            type: "boolean",
          },
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported.",
            type: "string",
          },
          custom_fields: {
            description: "JSON string of custom field filters for task search. Each key is a custom field GID followed by a search operator. Each value must be a string, number, or boolean only. Values become search query parameters, so nested objects and arrays are invalid. Use <gid>.value for an exact string or number match; for single-select fields, use the option GID as the value. Use <gid>.is_set with a boolean to test whether the field has any value. Other supported operators are not_value, starts_with, ends_with, contains, less_than, greater_than, before, and after. For compatibility, a bare GID defaults to value for strings and numbers or is_set for booleans. Examples: {\"4578152156.value\":\"1200123456789012\"}; {\"5678904321.greater_than\":42}; {\"1200999999999999.is_set\":true}.",
            type: "string",
          },
          limit: {
            default: 50,
            description: "Maximum number of results to return (1-100). Default: 50.",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_task',
      upstreamName: 'get_task',
      description: 'Read one Asana task.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Globally unique identifier for the task.",
          },
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported.",
            type: "string",
          },
          include_subtasks: {
            default: true,
            description: "Include subtasks of task",
            type: "boolean",
          },
          include_comments: {
            default: true,
            description: "Include comments of task",
            type: "boolean",
          },
          comment_limit: {
            default: 10,
            description: "Max comments to return (1-50). Default is 10.",
            type: "number",
            minimum: 1,
            maximum: 50,
          },
        },
        required: [
          "task_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_task_stories',
      upstreamName: 'get_task_stories',
      description: 'Read activity and comments on a task.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            description: "Globally unique identifier for a single task. Use task_ids instead to read several tasks in one call.",
            type: "string",
          },
          task_ids: {
            description: "Globally unique identifiers for up to 50 tasks, read in a single call. Prefer this over calling the tool once per task.",
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "string",
              minLength: 1,
            },
          },
          limit: {
            description: "Results per page (1-100). Applies per task when task_ids is used.",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          offset: {
            description: "Pagination offset token. Only valid with task_id, not task_ids.",
            type: "string",
          },
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported.",
            type: "string",
          },
          created_after: {
            description: "Only return stories created strictly after this ISO 8601 datetime. Applies to every story type; combine with resource_subtype='comment_added' for just the new comments.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          resource_subtype: {
            description: "Only return stories of this subtype. Omit to return the full activity feed. Note sticker reactions are comment stories too, so they come back as well and report resource_subtype='sticker_added' -- check each story's own resource_subtype if you need text comments only.",
            type: "string",
            enum: [
              "comment_added",
            ],
          },
          sort_ascending: {
            description: "Creation-time order: true (the default) is oldest first, false is newest first. Pair false with limit to read only the latest activity.",
            type: "boolean",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'create_tasks',
      upstreamName: 'create_tasks',
      description: 'Create Asana tasks.',
      class: 'write',
      inputSchema: {
        type: "object",
        properties: {
          tasks: {
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Name of the task.",
                },
                project_id: {
                  description: "Project GID for task creation. Required if not using parent or workspace+assignee.",
                  type: "string",
                },
                parent: {
                  description: "Parent task GID to create this as a subtask.",
                  type: "string",
                },
                html_notes: {
                  description: "HTML-formatted task description. Use notes for plain text. Allowed elements only: <body>, <strong>, <em>, <u>, <s>, <code>, <ol>, <ul>, <li>, <a>, <blockquote>, <pre>, <h1>, <h2>, <hr/>, <img>, <table>, <tr>, <td>. Tables use only <table>, <tr>, and <td>; <thead>, <tbody>, and <th> are invalid. For a header row, wrap the contents of each <td> in the first <tr> in <strong>. Must be well-formed XML with a single root <body>...</body>. Only <a> may have custom attributes; any attribute on any other element is invalid. Do not use elements outside the allowed list (400). . <a> links: For <a> tags specifically, to make it easier to create @-mentions through the API, we only require that you provide the GID of the object you wish to reference. If you have access to that object, the API will automatically generate the appropriate href and other attributes for you. For example, to create a link to a task with GID \"123\", you can send the tag <a data-asana-gid=\"123\"/> which will then be expanded to <a href=\"https://app.asana.com/0/0/123/f\" data-asana-accessible=\"true\" data-asana-dynamic=\"true\" data-asana-type=\"task\" data-asana-gid=\"123\">Task Name</a>. You can also generate a link to a task in a specific project or tag by including a data-asana-project or data-asana-tag attribute in the <a> tag. All other attributes, as well as the contents of the tag, are ignored.\n\nTo keep the contents of your tag and make a custom vanity link, include the property data-asana-dynamic=\"false\" when setting the contents of the tag. You would send <a data-asana-gid=\"123\" data-asana-dynamic=\"false\">This is some custom text!</a> and receive <a data-asana-accessible=\"true\" data-asana-dynamic=\"false\" data-asana-type=\"task\" data-asana-gid=\"123\">This is some custom text!</a>\n\nIf you do not have access to the referenced object when you try to create a link, the API will not generate an href for you, but will instead look for an href you provide. This allows you to write back <a> tags unmodified even if you do not have access to the resource. If you do not have access to the referenced object and no href is provided, your request will be rejected with a 400 Bad Request error. Similarly, if you provide neither a GID nor a valid href, the request will be rejected with the same error.",
                  type: "string",
                },
                notes: {
                  description: "Plain-text task description. Use html_notes for rich formatting or @-mentions.",
                  type: "string",
                },
                assignee: {
                  description: "User identifier for task assignment. If the assignee should be the currently authenticated user, use \"me\". Otherwise, use an email address or a user GID. When used without project_id, workspace is also required.",
                  type: "string",
                },
                due_on: {
                  description: "Due date in ISO 8601 format (YYYY-MM-DD).",
                  type: "string",
                  format: "date",
                  pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                },
                due_at: {
                  description: "Due date and time in ISO 8601 format.",
                  type: "string",
                  format: "date-time",
                  pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                },
                resource_subtype: {
                  default: "default_task",
                  description: "Task type (default_task, milestone, approval).",
                  type: "string",
                  enum: [
                    "default_task",
                    "milestone",
                    "approval",
                  ],
                },
                completed: {
                  description: "True if the task is initially marked complete.",
                  type: "boolean",
                },
                approval_status: {
                  description: "Approval status (pending, approved, rejected, changes_requested).",
                  type: "string",
                  enum: [
                    "pending",
                    "approved",
                    "rejected",
                    "changes_requested",
                  ],
                },
                section_id: {
                  description: "Section GID to place task in. Requires project_id to be provided.",
                  type: "string",
                },
                assignee_section: {
                  description: "Section GID to place task in the assignee's My Tasks list.",
                  type: "string",
                },
                followers: {
                  description: "Comma-separated list of user identifiers. Can be \"me\", email addresses, or user GIDs.",
                  type: "string",
                },
                start_on: {
                  description: "Start date in ISO 8601 format (YYYY-MM-DD).",
                  type: "string",
                  format: "date",
                  pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
                },
                start_at: {
                  description: "Start date and time in ISO 8601 format.",
                  type: "string",
                  format: "date-time",
                  pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                },
                custom_fields: {
                  description: "Custom field: each key is a custom field GID; each value matches that field's type in the Asana API. Use option GIDs for dropdown fields, not display names. Some tools expect a nested object; others expect one JSON string containing the same map. Examples: {\"1200456789012345\":\"1200123456789012\"} (single-select); {\"1200456789012346\":12.5} (number); {\"1200456789012347\":\"Ship by Friday\"} (text); {\"1200456789012348\":[\"1200111111111111\",\"1200222222222222\"]} (multi-select); {\"1200456789012349\":{\"date\":\"2025-06-15\"}} or {\"1200456789012349\":{\"date_time\":\"2025-06-15T17:00:00.000Z\"}} (date).",
                  type: "string",
                },
              },
              required: [
                "name",
              ],
            },
            description: "Array of task objects (1-50 tasks).",
          },
          default_project: {
            description: "Default project GID for all tasks. Omit when each task has project_id or parent, or when creating in My Tasks (use workspace+default_assignee).",
            type: "string",
          },
          default_assignee: {
            description: "Default assignee. Use \"me\" to assign the current authenticated user, an email, or a GID.",
            type: "string",
          },
        },
        required: [
          "tasks",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: 'update_tasks',
      upstreamName: 'update_tasks',
      description: 'Update Asana tasks.',
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          tasks: {
            minItems: 1,
            maxItems: 50,
            type: "array",
            items: {
              type: "object",
              properties: {
                task: {
                  type: "string",
                  description: "GID (Globally Unique Identifier) of the task to update.",
                },
                name: {
                  description: "New task name.",
                  type: "string",
                },
                assignee: {
                  description: "User identifier to assign the task to. Can be \"me\", an email, or a user GID. Prefer using \"me\" for the current user rather than calling get_me to look up the GID of the current user. Use null to unassign.",
                  type: [
                    "string",
                    "null",
                  ],
                },
                assignee_section: {
                  description: "Move the task to a specific section in the assignee's My Tasks by providing the section GID. Use null to clear.",
                  type: [
                    "string",
                    "null",
                  ],
                },
                due_on: {
                  description: "New due date (YYYY-MM-DD). Use null to clear.",
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
                start_on: {
                  description: "New start date (YYYY-MM-DD). Use null to clear. Note: due_on must be present when setting or unsetting start_on.",
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
                notes: {
                  description: "Plain-text task description. Use html_notes for rich formatting or @-mentions.",
                  type: "string",
                },
                html_notes: {
                  description: "HTML-formatted task description. Use notes for plain text. Allowed elements only: <body>, <strong>, <em>, <u>, <s>, <code>, <ol>, <ul>, <li>, <a>, <blockquote>, <pre>, <h1>, <h2>, <hr/>, <img>, <table>, <tr>, <td>. Tables use only <table>, <tr>, and <td>; <thead>, <tbody>, and <th> are invalid. For a header row, wrap the contents of each <td> in the first <tr> in <strong>. Must be well-formed XML with a single root <body>...</body>. Only <a> may have custom attributes; any attribute on any other element is invalid. Do not use elements outside the allowed list (400). . <a> links: For <a> tags specifically, to make it easier to create @-mentions through the API, we only require that you provide the GID of the object you wish to reference. If you have access to that object, the API will automatically generate the appropriate href and other attributes for you. For example, to create a link to a task with GID \"123\", you can send the tag <a data-asana-gid=\"123\"/> which will then be expanded to <a href=\"https://app.asana.com/0/0/123/f\" data-asana-accessible=\"true\" data-asana-dynamic=\"true\" data-asana-type=\"task\" data-asana-gid=\"123\">Task Name</a>. You can also generate a link to a task in a specific project or tag by including a data-asana-project or data-asana-tag attribute in the <a> tag. All other attributes, as well as the contents of the tag, are ignored.\n\nTo keep the contents of your tag and make a custom vanity link, include the property data-asana-dynamic=\"false\" when setting the contents of the tag. You would send <a data-asana-gid=\"123\" data-asana-dynamic=\"false\">This is some custom text!</a> and receive <a data-asana-accessible=\"true\" data-asana-dynamic=\"false\" data-asana-type=\"task\" data-asana-gid=\"123\">This is some custom text!</a>\n\nIf you do not have access to the referenced object when you try to create a link, the API will not generate an href for you, but will instead look for an href you provide. This allows you to write back <a> tags unmodified even if you do not have access to the resource. If you do not have access to the referenced object and no href is provided, your request will be rejected with a 400 Bad Request error. Similarly, if you provide neither a GID nor a valid href, the request will be rejected with the same error.",
                  type: "string",
                },
                completed: {
                  description: "Mark complete or incomplete.",
                  type: "boolean",
                },
                approval_status: {
                  description: "Set the approval status of approval-type tasks (resource_subtype: approval). Has no effect on non-approval tasks. Synced with completed: 'pending' sets completed to false; 'approved', 'rejected', or 'changes_requested' set completed to true. Conversely, setting completed to true automatically sets this to 'approved'.",
                  type: "string",
                  enum: [
                    "pending",
                    "approved",
                    "rejected",
                    "changes_requested",
                  ],
                },
                parent: {
                  description: "New parent task (converts to subtask). Use null to convert to regular task.",
                  type: [
                    "string",
                    "null",
                  ],
                },
                add_projects: {
                  description: "Projects to add the task to, with optional section placement.",
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      project_id: {
                        type: "string",
                        description: "The GID of the project to add the task to.",
                      },
                      section_id: {
                        description: "The GID of the section within the project to add the task to. If omitted or null, the task is added to the project without a specific section.",
                        type: [
                          "string",
                          "null",
                        ],
                      },
                    },
                    required: [
                      "project_id",
                    ],
                  },
                },
                remove_projects: {
                  description: "Project GIDs to remove the task from.",
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                add_dependencies: {
                  description: "Task GIDs to add as dependencies.",
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                remove_dependencies: {
                  description: "Task GIDs to remove as dependencies.",
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                add_dependents: {
                  description: "Task GIDs to add as dependents.",
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                remove_dependents: {
                  description: "Task GIDs to remove as dependents.",
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                add_followers: {
                  description: "Followers to add (user GIDs or emails).",
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                remove_followers: {
                  description: "Followers to remove (user GIDs or emails).",
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                custom_fields: {
                  description: "Custom field: each key is a custom field GID; each value matches that field's type in the Asana API. Use option GIDs for dropdown fields, not display names. Some tools expect a nested object; others expect one JSON string containing the same map. Examples: {\"1200456789012345\":\"1200123456789012\"} (single-select); {\"1200456789012346\":12.5} (number); {\"1200456789012347\":\"Ship by Friday\"} (text); {\"1200456789012348\":[\"1200111111111111\",\"1200222222222222\"]} (multi-select); {\"1200456789012349\":{\"date\":\"2025-06-15\"}} or {\"1200456789012349\":{\"date_time\":\"2025-06-15T17:00:00.000Z\"}} (date).",
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
                        type: "array",
                        items: {
                          type: "string",
                        },
                      },
                      {
                        type: "object",
                        propertyNames: {
                          type: "string",
                        },
                        additionalProperties: {},
                      },
                    ],
                  },
                },
              },
              required: [
                "task",
              ],
            },
            description: "Array of task update objects (1-50). Each object requires 'task' (the task GID) and one or more optional fields to update: name, assignee (null to unassign), assignee_section (section GID in assignee's My Tasks, null to clear), due_on (YYYY-MM-DD or null), start_on (YYYY-MM-DD or null; due_on must be present), notes, html_notes, completed, approval_status (pending/approved/rejected/changes_requested), parent (null to convert to top-level task), add/remove_dependencies, add/remove_dependents, add/remove_projects, add/remove_followers, and custom_fields. Example: [{\"task\": \"123\", \"name\": \"New name\", \"due_on\": \"2025-06-01\", \"completed\": true}]",
          },
        },
        required: [
          "tasks",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'add_comment',
      upstreamName: 'add_comment',
      description: 'Add a comment to an Asana task.',
      class: 'write',
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Globally unique identifier for the task.",
          },
          text: {
            description: "Plain-text comment body. Exactly one of text or html_text must be provided.",
            type: "string",
          },
          html_text: {
            description: "Exactly one of text or html_text must be provided. Allowed elements only: <body>, <strong>, <em>, <u>, <s>, <code>, <ol>, <ul>, <li>, <a>, <blockquote>, <pre>. Do not use <h1>, <h2>, <hr/>, or <img> here. Must be well-formed XML with a single root <body>...</body>. Only <a> may have custom attributes; any attribute on any other element is invalid. Do not use elements outside the allowed list (400). . <a> links: For <a> tags specifically, to make it easier to create @-mentions through the API, we only require that you provide the GID of the object you wish to reference. If you have access to that object, the API will automatically generate the appropriate href and other attributes for you. For example, to create a link to a task with GID \"123\", you can send the tag <a data-asana-gid=\"123\"/> which will then be expanded to <a href=\"https://app.asana.com/0/0/123/f\" data-asana-accessible=\"true\" data-asana-dynamic=\"true\" data-asana-type=\"task\" data-asana-gid=\"123\">Task Name</a>. You can also generate a link to a task in a specific project or tag by including a data-asana-project or data-asana-tag attribute in the <a> tag. All other attributes, as well as the contents of the tag, are ignored.\n\nTo keep the contents of your tag and make a custom vanity link, include the property data-asana-dynamic=\"false\" when setting the contents of the tag. You would send <a data-asana-gid=\"123\" data-asana-dynamic=\"false\">This is some custom text!</a> and receive <a data-asana-accessible=\"true\" data-asana-dynamic=\"false\" data-asana-type=\"task\" data-asana-gid=\"123\">This is some custom text!</a>\n\nIf you do not have access to the referenced object when you try to create a link, the API will not generate an href for you, but will instead look for an href you provide. This allows you to write back <a> tags unmodified even if you do not have access to the resource. If you do not have access to the referenced object and no href is provided, your request will be rejected with a 400 Bad Request error. Similarly, if you provide neither a GID nor a valid href, the request will be rejected with the same error.",
            type: "string",
          },
          is_pinned: {
            default: false,
            description: "Pinned comments stay at the top of the task's activity feed.",
            type: "boolean",
          },
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported. Returns gid,name,task,created_by,created_at,text,html_text,is_pinned by default.",
            type: "string",
          },
        },
        required: [
          "task_id",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: 'get_tasks',
      upstreamName: 'get_tasks',
      description: 'List tasks in an Asana project, section, or tag.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project: {
            description: "Globally unique identifier for the project.",
            type: "string",
          },
          tag: {
            description: "The tag GID to retrieve tasks for",
            type: "string",
          },
          section: {
            description: "Globally unique identifier for the section.",
            type: "string",
          },
          user_task_list: {
            description: "Globally unique identifier for the user task list.",
            type: "string",
          },
          assignee: {
            description: "User identifier to assign the task to. Can be \"me\", an email, or a user GID. Prefer using \"me\" for the current user rather than calling get_me to look up the GID of the current user.",
            type: "string",
          },
          completed_since: {
            description: "Filter for tasks completed since this date in datetime format.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          modified_since: {
            description: "Filter for tasks modified since this date in datetime format.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported.",
            type: "string",
          },
          limit: {
            description: "Number of sections to return per page (1-100).",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          offset: {
            description: "Pagination offset token.",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_my_tasks',
      upstreamName: 'get_my_tasks',
      description: 'List tasks assigned to the connected user.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          completed_since: {
            description: "Filter by completion. Use \"now\" for incomplete tasks only. Omit for all tasks. Use ISO datetime for tasks completed since a date.",
            type: "string",
          },
          limit: {
            description: "Results per page (1-100). Default: 50.",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          offset: {
            description: "Pagination offset token from the next_page field of a previous response. If omitted, returns the first page of results.",
            type: "string",
          },
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported. Returns gid,name,assignee,due_on,completed by default.",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'delete_task',
      upstreamName: 'delete_task',
      description: 'Delete an Asana task and its subtasks unless a subtask also sits in another project.',
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Globally unique identifier for the task to delete.",
          },
        },
        required: [
          "task",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'get_teams',
      upstreamName: 'get_teams',
      description: 'List Asana teams visible to the connected user.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          user: {
            description: "A user GID to filter teams to only those the user belongs to. When omitted, returns all teams in the workspace.",
            type: "string",
          },
          limit: {
            default: 20,
            description: "Number of teams to return per page (1-100). Defaults to 20.",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          offset: {
            description: "Pagination offset token from the next_page field of a previous response. If omitted, returns the first page of results.",
            type: "string",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'search_objects',
      upstreamName: 'search_objects',
      description: 'Search Asana projects, tasks, people, teams, tags, goals, portfolios, project templates, custom fields, and AI Teammates.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          opt_fields: {
            description: "Comma-separated list of optional fields to include in the response. Name each subfield explicitly as parent.child; wildcard and glob syntax such as parent.* is not supported.",
            type: "string",
          },
          resource_type: {
            type: "string",
            enum: [
              "actor",
              "agent",
              "custom_field",
              "goal",
              "project",
              "project_template",
              "portfolio",
              "tag",
              "task",
              "team",
              "user",
            ],
            description: "The type of resource to search for. Use 'user' for human workspace members. Use 'agent' for AI teammates (e.g. named assistants). Use 'actor' when searching for any entity that can be assigned work (humans + AI teammates).",
          },
          query: {
            description: "The search query. Can be empty to get default results for the resource type.",
            type: "string",
          },
          count: {
            description: "Number of results to return. Default is 20 if parameter is empty. Minimum 1, maximum 100.",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
        },
        required: [
          "resource_type",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_me',
      upstreamName: 'get_me',
      description: 'Read the connected Asana user.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {},
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ],
};
