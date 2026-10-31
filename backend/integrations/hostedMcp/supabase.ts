/**
 * Supabase hosted-MCP entry (TASK-242). Its OAuth server requires the full
 * scope set for the MCP proxy, including writes. The pin excludes
 * spend-bearing tools, caller-directed SQL/GraphQL, and credential reads.
 * Known limit: the grant carries all 13 scopes, writes included, because
 * Supabase requires the full set. Read and write access is enforced only by
 * the pins in this file, so a tool missing from the pins is not callable.
 *
 * Resource and authorization-server metadata were fetched from Supabase on
 * 2026-10-19. Pins come from connector-ops's consenting tools/list capture
 * at 2026-10-19T07:03:03Z, with schemas copied unchanged for drift checks.
 * Project creation, pause/restore, branch creation and cost-confirmation
 * tools are excluded because approval cards do not authorize spending.
 * Edge Function deployment is excluded because it runs caller-supplied code.
 * execute_sql, apply_migration, and query_logs accept caller-directed SQL;
 * search_docs accepts caller-directed GraphQL; get_publishable_keys returns
 * credentials that would bypass the broker after retrieval.
 */
import type { HostedMcpEntry } from '../../services/hostedMcpEntryService';

export const SUPABASE_ENTRY: HostedMcpEntry = {
  id: 'supabase',
  title: 'Supabase',
  description: 'Projects, database schema, Edge Functions and branches. Disconnect deletes '
    + "Commonly's tokens; Commonly stays authorized in the organization until someone removes it under OAuth Apps.",
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
  // Supabase advertises no revocation endpoint. This is an organization page, not
  // an endpoint to which Commonly sends a token.
  revoke: { page: 'https://supabase.com/dashboard/org/_/apps' },
  tools: [
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
      description: "Apply the branch's migrations and Edge Functions to production after member approval; "
        + 'approval covers branch content as it stands at execution.',
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
      description: 'Reset a development branch after member approval; '
        + 'untracked data and schema changes on the branch are lost.',
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
  ],
};
