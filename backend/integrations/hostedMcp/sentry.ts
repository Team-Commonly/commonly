/**
 * Sentry hosted-MCP entry (TASK-241). The OAuth proxy requests its complete
 * five-scope set, including write scopes; every pinned writer must therefore
 * have class `write` so the broker parks it for the credential owner's approval.
 *
 * Resource and authorization-server metadata were fetched from mcp.sentry.dev
 * on 2026-10-19. The tool pin comes from connector-ops's consenting tools/list
 * capture at 2026-10-19T07:02:33Z. The get_sentry_resource pin deliberately
 * omits the vendor's optional `url`: that route can reach types outside the
 * pinned enum, so its live schema always reports a compatible addition in
 * the assessment log. The by-name dispatcher and its catalogue are excluded
 * because they can reach operations outside this reviewed pin. Seer analysis is
 * excluded because it starts a vendor AI workflow.
 */
import type { HostedMcpEntry } from '../../services/hostedMcpEntryService';

export const SENTRY_ENTRY: HostedMcpEntry = {
  id: 'sentry',
  title: 'Sentry',
  description: 'Errors, projects and issue triage in your Sentry organization.',
  resource: 'https://mcp.sentry.dev/mcp',
  issuer: 'https://mcp.sentry.dev',
  client: 'cimd',
  scopes: ['org:read', 'project:write', 'team:write', 'event:write', 'alerts:write'],
  revoke: {
    page: 'https://sentry.io/settings/account/authorizations/',
    endpoint: 'https://mcp.sentry.dev/oauth/token',
  },
  tools: [
    {
      name: 'find_organizations',
      upstreamName: 'find_organizations',
      description: "Find Sentry organizations available to this account.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          query: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "Search query to filter results by name or slug. Use this to narrow down results when there are many items.",
              },
              {
                type: "null",
              },
            ],
          },
          cursor: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "Pagination cursor from a previous call's nextCursor. Reuse it with the same filters and scope to fetch the next page.",
              },
              {
                type: "null",
              },
            ],
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'find_projects',
      upstreamName: 'find_projects',
      description: "Find projects in a Sentry organization.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          query: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "Search query to filter results by name or slug. Use this to narrow down results when there are many items.",
              },
              {
                type: "null",
              },
            ],
          },
          cursor: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "Pagination cursor from a previous call's nextCursor. Reuse it with the same filters and scope to fetch the next page.",
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: [
          "organizationSlug",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'update_issue',
      upstreamName: 'update_issue',
      description: "Change a Sentry issue status or assignee, with an optional reason.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          issueId: {
            type: "string",
            description: "The Issue ID. e.g. `PROJECT-1Z43`",
          },
          issueUrl: {
            type: "string",
            format: "uri",
            description: "The URL of the issue. e.g. https://my-organization.sentry.io/issues/PROJECT-1Z43",
          },
          status: {
            type: "string",
            enum: [
              "resolved",
              "resolvedInNextRelease",
              "unresolved",
              "ignored",
            ],
            description: "The new status for the issue. Valid values are 'resolved', 'resolvedInNextRelease', 'unresolved', and 'ignored'.",
          },
          assignedTo: {
            anyOf: [
              {
                type: "string",
                minLength: 1,
              },
              {
                type: "null",
              },
            ],
            description: "The assignee in format 'user:ID' or 'team:ID_OR_SLUG' where ID is numeric. Pass null to unassign the issue. Example: 'user:123456', 'team:789', or 'team:my-team-slug'. Use `execute_sentry_tool(name='whoami', arguments={})` to find your user ID.",
          },
          ignoreMode: {
            type: "string",
            enum: [
              "untilEscalating",
              "forever",
              "forDuration",
              "untilOccurrenceCount",
              "untilUserCount",
            ],
            description: "How ignored issues should behave. Use 'untilEscalating' to match the Sentry UI default, 'forever' for a permanent ignore, 'forDuration' with ignoreDurationMinutes, 'untilOccurrenceCount' with ignoreCount and optional ignoreWindowMinutes, or 'untilUserCount' with ignoreUserCount and optional ignoreUserWindowMinutes.",
          },
          ignoreDurationMinutes: {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 9007199254740991,
            description: "How many minutes to ignore the issue when ignoreMode is 'forDuration'.",
          },
          ignoreCount: {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 9007199254740991,
            description: "How many times the issue must occur before it stops being ignored when ignoreMode is 'untilOccurrenceCount'.",
          },
          ignoreWindowMinutes: {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 10080,
            description: "Optional time window in minutes for ignoreCount. If omitted, Sentry counts all future occurrences.",
          },
          ignoreUserCount: {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 9007199254740991,
            description: "How many users must be affected before the issue stops being ignored when ignoreMode is 'untilUserCount'.",
          },
          ignoreUserWindowMinutes: {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 10080,
            description: "Optional time window in minutes for ignoreUserCount. If omitted, Sentry counts all future affected users.",
          },
          reason: {
            type: "string",
            minLength: 1,
            description: "Optional reason for taking this action. When provided, it will be posted as a comment on the issue's activity feed.",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'search_errors',
      upstreamName: 'search_errors',
      description: "Search error events and stack traces in Sentry.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          query: {
            description: "What to find, in natural language (preferred) or Sentry search syntax. Include environment, release, or other filters here.",
            type: "string",
          },
          fields: {
            description: "Fields to return. If not specified, uses sensible defaults. Include aggregate functions like count(), avg() for statistics.",
            anyOf: [
              {
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
          sort: {
            description: "Sort field (prefix with - for descending). Defaults to -timestamp. Use -count() for aggregations.",
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
          },
          projectSlug: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The project's slug. You can find a list of existing projects in an organization using the `find_projects()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          period: {
            type: "string",
            pattern: "^\\d+[hdw]$",
            description: "Relative time window, such as `24h`, `7d`, `14d`, `30d`, or `90d`. Controls which records fall within the search window.",
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          limit: {
            default: 10,
            description: "Maximum number of results to return (1-100)",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          includeExplanation: {
            default: false,
            description: "Include explanation of how the query was translated or repaired",
            type: "boolean",
          },
        },
        required: [
          "organizationSlug",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'search_logs',
      upstreamName: 'search_logs',
      description: "Search application log entries in Sentry.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          query: {
            description: "What to find, in natural language (preferred) or Sentry search syntax. Include environment, release, or other filters here.",
            type: "string",
          },
          fields: {
            description: "Fields to return. If not specified, uses sensible defaults. Include aggregate functions like count(), avg() for statistics.",
            anyOf: [
              {
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
          sort: {
            description: "Sort field (prefix with - for descending). Defaults to -timestamp. Use -count() for aggregations.",
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
          },
          projectSlug: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The project's slug. You can find a list of existing projects in an organization using the `find_projects()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          period: {
            type: "string",
            pattern: "^\\d+[hdw]$",
            description: "Relative time window, such as `24h`, `7d`, `14d`, `30d`, or `90d`. Controls which records fall within the search window.",
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          limit: {
            default: 10,
            description: "Maximum number of results to return (1-100)",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          includeExplanation: {
            default: false,
            description: "Include explanation of how the query was translated or repaired",
            type: "boolean",
          },
        },
        required: [
          "organizationSlug",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'search_traces',
      upstreamName: 'search_traces',
      description: "Search spans and traces in Sentry.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          query: {
            description: "What to find, in natural language (preferred) or Sentry search syntax. Include environment, release, or other filters here.",
            type: "string",
          },
          fields: {
            description: "Fields to return. If not specified, uses sensible defaults. Include aggregate functions like count(), avg() for statistics.",
            anyOf: [
              {
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
          sort: {
            description: "Sort field (prefix with - for descending). Defaults to -timestamp. Use -count() for aggregations.",
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
          },
          projectSlug: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The project's slug. You can find a list of existing projects in an organization using the `find_projects()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          period: {
            type: "string",
            pattern: "^\\d+[hdw]$",
            description: "Relative time window, such as `24h`, `7d`, `14d`, `30d`, or `90d`. Controls which records fall within the search window.",
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          limit: {
            default: 10,
            description: "Maximum number of results to return (1-100)",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          includeExplanation: {
            default: false,
            description: "Include explanation of how the query was translated or repaired",
            type: "boolean",
          },
        },
        required: [
          "organizationSlug",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'search_metrics',
      upstreamName: 'search_metrics',
      description: "Search Sentry metrics and trends.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          query: {
            description: "What to find, in natural language (preferred) or Sentry search syntax. Include environment, release, or other filters here.",
            type: "string",
          },
          fields: {
            description: "Fields to return. If not specified, uses sensible defaults. Include aggregate functions like count(), avg() for statistics.",
            anyOf: [
              {
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
          sort: {
            description: "Sort field (prefix with - for descending). Defaults to -timestamp. Use -count() for aggregations.",
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
          },
          projectSlug: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The project's slug. You can find a list of existing projects in an organization using the `find_projects()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          period: {
            type: "string",
            pattern: "^\\d+[hdw]$",
            description: "Relative time window, such as `24h`, `7d`, `14d`, `30d`, or `90d`. Controls which records fall within the search window.",
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          limit: {
            default: 10,
            description: "Maximum number of results to return (1-100)",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          includeExplanation: {
            default: false,
            description: "Include explanation of how the query was translated or repaired",
            type: "boolean",
          },
        },
        required: [
          "organizationSlug",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'search_profiles',
      upstreamName: 'search_profiles',
      description: "Search Sentry profiling results.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          query: {
            description: "What to find, in natural language (preferred) or Sentry search syntax. Include environment, release, or other filters here.",
            type: "string",
          },
          fields: {
            description: "Fields to return. If not specified, uses sensible defaults. Include aggregate functions like count(), avg() for statistics.",
            anyOf: [
              {
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
          sort: {
            description: "Sort field (prefix with - for descending). Defaults to -timestamp. Use -count() for aggregations.",
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
          },
          projectSlug: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The project's slug. You can find a list of existing projects in an organization using the `find_projects()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          period: {
            type: "string",
            pattern: "^\\d+[hdw]$",
            description: "Relative time window, such as `24h`, `7d`, `14d`, `30d`, or `90d`. Controls which records fall within the search window.",
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          limit: {
            default: 10,
            description: "Maximum number of results to return (1-100)",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          includeExplanation: {
            default: false,
            description: "Include explanation of how the query was translated or repaired",
            type: "boolean",
          },
        },
        required: [
          "organizationSlug",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'search_replays',
      upstreamName: 'search_replays',
      description: "Search Sentry session replays.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          query: {
            description: "What to find, in natural language (preferred) or replay search syntax.",
            type: "string",
          },
          sort: {
            description: "Replay sort (prefix with - for descending): -started_at (default), -count_errors, -count_rage_clicks, or -duration.",
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
          },
          projectSlug: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The project's slug. You can find a list of existing projects in an organization using the `find_projects()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          environment: {
            description: "Optional environment filter. Use a string for one environment or an array for multiple. Omit when unused.",
            anyOf: [
              {
                type: "string",
                minLength: 1,
              },
              {
                minItems: 1,
                type: "array",
                items: {
                  type: "string",
                  minLength: 1,
                },
              },
            ],
          },
          period: {
            type: "string",
            pattern: "^\\d+[hdw]$",
            description: "Relative time window, such as `24h`, `7d`, `14d`, `30d`, or `90d`. Controls which records fall within the search window.",
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          limit: {
            default: 10,
            description: "Maximum number of results to return (1-100)",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          includeExplanation: {
            default: false,
            description: "Include explanation of how the query was translated or repaired",
            type: "boolean",
          },
        },
        required: [
          "organizationSlug",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'search_issues',
      upstreamName: 'search_issues',
      description: "Search grouped Sentry issues.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          query: {
            default: "is:unresolved",
            description: "Natural language or Sentry issue search query syntax.",
            type: "string",
          },
          sort: {
            default: "date",
            description: "Sort order: date (last seen), freq (frequency), new (first seen), user (user count), recommended (Sentry's prioritized ranking)",
            type: "string",
            enum: [
              "date",
              "freq",
              "new",
              "user",
              "recommended",
            ],
          },
          projectSlugOrId: {
            default: null,
            description: "The project's slug or numeric ID (optional)",
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          limit: {
            default: 10,
            description: "Maximum number of issues to return (1-100)",
            type: "number",
            minimum: 1,
            maximum: 100,
          },
          period: {
            default: "30d",
            description: "Time window for issue search results. Controls which issues are returned based on when they had activity. Default 30d is a balance between coverage and query performance; use 24h for very recent issues or 90d for broader historical searches.",
            type: "string",
            enum: [
              "24h",
              "7d",
              "14d",
              "30d",
              "90d",
            ],
          },
          includeExplanation: {
            default: false,
            description: "Include explanation of how the query was translated or repaired",
            type: "boolean",
          },
        },
        required: [
          "organizationSlug",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'find_dropped_events',
      upstreamName: 'find_dropped_events',
      description: "Find events dropped before Sentry stored them.",
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
          regionUrl: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The region URL for the organization you're querying, if known. For Sentry's Cloud Service (sentry.io), this is typically the region-specific URL like 'https://us.sentry.io'. For self-hosted Sentry installations, this parameter is usually not needed and should be omitted. You can find the correct regionUrl from the organization details using the `find_organizations()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          dataset: {
            default: "spans",
            type: "string",
            enum: [
              "spans",
              "logs",
              "metrics",
              "errors",
            ],
            description: "Which data type to report drops for.",
          },
          projectSlug: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "The project's slug. You can find a list of existing projects in an organization using the `find_projects()` tool.",
              },
              {
                type: "null",
              },
            ],
          },
          statsPeriod: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "Relative time range, e.g. '24h', '7d', '30d'. Mutually exclusive with start/end.",
              },
              {
                type: "null",
              },
            ],
          },
          start: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "Absolute start (ISO 8601). Must be paired with end.",
              },
              {
                type: "null",
              },
            ],
          },
          end: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "Absolute end (ISO 8601). Must be paired with start.",
              },
              {
                type: "null",
              },
            ],
          },
          interval: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "Bucket size, e.g. '1h', '1d'. Omit to let Sentry pick for the range.",
              },
              {
                type: "null",
              },
            ],
          },
          outcome: {
            default: null,
            anyOf: [
              {
                type: "string",
                enum: [
                  "rate_limited",
                  "filtered",
                  "invalid",
                  "abuse",
                  "client_discard",
                  "cardinality_limited",
                ],
                description: "Scope the dropped side to one top-level drop classification. Accepted volume is still returned in full.",
              },
              {
                type: "null",
              },
            ],
          },
          reason: {
            default: null,
            anyOf: [
              {
                type: "string",
                description: "Scope the dropped side to one reason (sub-classification within an outcome, e.g. 'spike_protection'). Combine with `outcome`.",
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: [
          "organizationSlug",
        ],
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'get_sentry_resource',
      upstreamName: 'get_sentry_resource',
      description: 'Read a Sentry issue, event, trace, AI conversation, replay, '
        + 'monitor, snapshot, or dashboard by type and ID.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          resourceType: {
            description: "Resource type. With a URL, can override a span-focused trace URL with `trace`. Use `monitor` with a monitor slug only when inspect monitor tools are available, `snapshot` with a snapshot artifact ID, or `dashboard` with a dashboard ID or exact title when inspect dashboard tools are available.",
            type: "string",
            enum: [
              "issue",
              "event",
              "trace",
              "ai_conversation",
              "replay",
              "monitor",
              "snapshot",
              "dashboard",
            ],
          },
          resourceId: {
            description: "Resource identifier: issue shortId (e.g., 'PROJECT-123'), event ID, trace ID, agent conversation ID, replay ID, monitor slug when inspect monitor tools are available, dashboard ID or title when inspect dashboard tools are available, or snapshot artifact ID. Required when not using a URL.",
            type: "string",
          },
          organizationSlug: {
            type: "string",
            description: "The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
          },
        },
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ],
};
