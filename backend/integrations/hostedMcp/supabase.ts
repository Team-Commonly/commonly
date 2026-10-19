/**
 * Supabase hosted-MCP entry (TASK-242). Its OAuth server requires the full
 * scope set for the MCP proxy, including writes. The eventual pin excludes
 * tools that can incur charges and classifies database mutations as `write`.
 *
 * Resource and authorization-server metadata were fetched from Supabase on
 * 2026-10-19. Pins come from connector-ops's consenting tools/list capture
 * at 2026-10-19T07:03:03Z, with schemas copied unchanged for drift checks.
 * Project creation, pause/restore, branch creation and cost-confirmation
 * tools are excluded because approval cards do not authorize spending.
 * Edge Function deployment is also excluded: publishing code can create
 * metered execution traffic.
 */
import type { HostedMcpEntry } from '../../services/hostedMcpEntryService';

export const SUPABASE_ENTRY: HostedMcpEntry = {
  id: 'supabase',
  title: 'Supabase',
  description: 'Projects, database, functions and storage. Disconnect drops the token locally; '
    + 'Supabase may keep it active until expiry.',
  resource: 'https://mcp.supabase.com/mcp',
  issuer: 'https://api.supabase.com',
  client: 'dcr',
  scopes: [
    'organizations:read',
    'projects:read',
    'projects:write',
    'database:write',
    'database:read',
    'analytics:read',
    'secrets:read',
    'edge_functions:read',
    'edge_functions:write',
    'environment:read',
    'environment:write',
    'storage:read',
    'storage:write',
  ],
  // Supabase advertises no revocation endpoint. This is an account page, not
  // an endpoint to which Commonly sends a token.
  revoke: { page: 'https://supabase.com/dashboard/account' },
  tools: [
    {
      name: 'search_docs',
      upstreamName: 'search_docs',
      description: "Search the Supabase documentation.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          graphql_query: {
            type: "string",
            description: "GraphQL query string",
          },
        },
        required: [
          "graphql_query",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'list_organizations',
      upstreamName: 'list_organizations',
      description: "List Supabase organizations for this account.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {},
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_organization',
      upstreamName: 'get_organization',
      description: "Read a Supabase organization.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The organization ID",
          },
        },
        required: [
          "id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'list_projects',
      upstreamName: 'list_projects',
      description: "List Supabase projects.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {},
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_project',
      upstreamName: 'get_project',
      description: "Read a Supabase project.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The project ID",
          },
        },
        required: [
          "id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'list_tables',
      upstreamName: 'list_tables',
      description: "List database tables and optional column details.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
          schemas: {
            default: [
              "public",
            ],
            type: "array",
            items: {
              type: "string",
            },
            description: "List of schemas to include. Defaults to all schemas.",
          },
          verbose: {
            default: false,
            type: "boolean",
            description: "When true, includes column details, primary keys, and foreign key constraints. Defaults to false for a compact summary.",
          },
        },
        required: [
          "project_id",
          "schemas",
          "verbose",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'list_extensions',
      upstreamName: 'list_extensions',
      description: "List database extensions.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
        },
        required: [
          "project_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'list_migrations',
      upstreamName: 'list_migrations',
      description: "List database migrations.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
        },
        required: [
          "project_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'apply_migration',
      upstreamName: 'apply_migration',
      description: "Apply a database migration after member approval.",
      class: 'write',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
          name: {
            type: "string",
            description: "The name of the migration in snake_case",
          },
          query: {
            type: "string",
            description: "The SQL query to apply",
          },
        },
        required: [
          "project_id",
          "name",
          "query",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'execute_sql',
      upstreamName: 'execute_sql',
      description: "Execute SQL in a Supabase database after member approval.",
      class: 'write',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
          query: {
            type: "string",
            description: "The SQL query to execute",
          },
        },
        required: [
          "project_id",
          "query",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'query_logs',
      upstreamName: 'query_logs',
      description: "Query a Supabase project’s logs.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
          sql: {
            type: "string",
            minLength: 1,
            description: "A read-only ClickHouse SQL query to run against the project's unified logs stream. Logs are exposed through a `logs` table; filter by `source` (common values include 'edge_logs', 'postgres_logs', and 'function_edge_logs', but this list is not exhaustive — run `select distinct source from logs` to discover the sources available for this project) and read nested fields via `log_attributes['<key>']`.",
          },
          iso_timestamp_start: {
            description: "The start of the log window as an ISO 8601 timestamp, including a UTC \"Z\" suffix or explicit offset. Defaults to 24 hours before the end of the window. The API caps the requested range at 24 hours.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
          },
          iso_timestamp_end: {
            description: "The end of the log window as an ISO 8601 timestamp, including a UTC \"Z\" suffix or explicit offset. Defaults to the current time. The API caps the requested range at 24 hours.",
            type: "string",
            format: "date-time",
            pattern: "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
          },
        },
        required: [
          "project_id",
          "sql",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_advisors',
      upstreamName: 'get_advisors',
      description: "Read security and performance advisors.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
          type: {
            type: "string",
            enum: [
              "security",
              "performance",
            ],
            description: "The type of advisors to fetch",
          },
        },
        required: [
          "project_id",
          "type",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_project_url',
      upstreamName: 'get_project_url',
      description: "Read a project API URL.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
        },
        required: [
          "project_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_publishable_keys',
      upstreamName: 'get_publishable_keys',
      description: "Read a project’s publishable API keys.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
        },
        required: [
          "project_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'generate_typescript_types',
      upstreamName: 'generate_typescript_types',
      description: "Generate TypeScript types from a project schema.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
        },
        required: [
          "project_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'list_edge_functions',
      upstreamName: 'list_edge_functions',
      description: "List a project’s Edge Functions.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
        },
        required: [
          "project_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_edge_function',
      upstreamName: 'get_edge_function',
      description: "Read an Edge Function’s source files.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
          function_slug: {
            type: "string",
          },
        },
        required: [
          "project_id",
          "function_slug",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'list_branches',
      upstreamName: 'list_branches',
      description: "List development branches.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
          },
        },
        required: [
          "project_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'delete_branch',
      upstreamName: 'delete_branch',
      description: "Delete a development branch after member approval.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          branch_id: {
            type: "string",
          },
        },
        required: [
          "branch_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'merge_branch',
      upstreamName: 'merge_branch',
      description: "Merge a development branch after member approval.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          branch_id: {
            type: "string",
          },
        },
        required: [
          "branch_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'reset_branch',
      upstreamName: 'reset_branch',
      description: "Reset a development branch after member approval.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          branch_id: {
            type: "string",
          },
          migration_version: {
            description: "Reset your development branch to a specific migration version.",
            type: "string",
          },
        },
        required: [
          "branch_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'rebase_branch',
      upstreamName: 'rebase_branch',
      description: "Rebase a development branch after member approval.",
      class: 'write',
      inputSchema: {
        type: "object",
        properties: {
          branch_id: {
            type: "string",
          },
        },
        required: [
          "branch_id",
        ],
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  ],
};
