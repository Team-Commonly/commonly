/**
 * Airtable — a hosted-MCP catalogue entry (TASK-186).
 *
 * Pinned from a real `tools/list` taken on a consenting account at
 * 2026-10-09T11:46:22.063Z against `https://mcp.airtable.com/mcp`, with the token at exactly the
 * four read scopes below. The capture is connector-ops's and is committed as a
 * fixture; every pinned `inputSchema` is transcribed from it unchanged.
 *
 * Read tools only, and the credential carries only `:read` scopes. The server
 * still LISTS 21 writers under that token (record, table, field, page,
 * interface and automation writes), so the pin is what keeps them out, with the
 * vendor's scope check as the second fence.
 *
 * Pin set per Wren 76761: a read is pinned only if it is named, product-scoped
 * and carries no credential or foreign payload. So three tools annotated
 * read-only stay out: `list_secrets` and `list_external_accounts`
 * (credential-adjacent reconnaissance) and `fetch_automation_input_data`
 * (externally injected payloads into agent context).
 *
 * Airtable requires `state` on the authorization request (16-1024 characters),
 * which the intake always sends. Airtable publishes no revocation endpoint, so
 * removal is page-only: the person removes the integration in Airtable's own
 * settings, Account > Integrations > Third-party integrations > the integration
 * > Revoke access (Airtable support, "Third-party integrations via OAuth").
 * Revoking removes access to every base granted through that authorization. The
 * exact URL a person lands on is the live walk's to pin (C9), as Linear's was. No
 * `openid`, so rows carry no `providerSubject`. Access tokens last one hour and
 * come with a refresh token (measured).
 */
import type { HostedMcpEntry, HostedMcpPinnedTool } from '../../services/hostedMcpEntryService';

/** The vendor's annotations as the pin records them; all 22 pinned reads arrived with this set. */
const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false };

/** One read tool: the name an agent sees is the upstream name, checked by the entry load. */
const readTool = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): HostedMcpPinnedTool => ({
  name,
  upstreamName: name,
  description,
  class: 'read',
  inputSchema,
  annotations: { ...READ_ANNOTATIONS },
});

export const AIRTABLE_ENTRY: HostedMcpEntry = {
  id: 'airtable',
  title: 'Airtable',
  description: 'Bases, tables and records in your Airtable workspace.',
  resource: 'https://mcp.airtable.com/mcp',
  issuer: 'https://airtable.com/oauth2/v1',
  // The authorization server advertises `client_id_metadata_document_supported:
  // true` and S256, so nothing is registered and no secret is stored.
  client: 'cimd',
  scopes: [
    'data.records:read',
    'schema.bases:read',
    'data.recordComments:read',
    'workspacesAndBases:read',
  ],
  revoke: { page: 'https://airtable.com/account' },
  tools: [
    readTool(
      'ping',
      'Check that the Airtable connection answers.',
      {
        type: 'object',
        properties: {},
      },
    ),
    readTool(
      'list_bases',
      'List the bases this connection can read.',
      {
        type: 'object',
        properties: {
          offset: {
            type: 'string',
            description: 'Pagination cursor from a previous list_bases response. Pass this to retrieve the next page of results.',
          },
        },
        additionalProperties: false,
      },
    ),
    readTool(
      'list_workspaces',
      'List the workspaces this connection can read.',
      {
        type: 'object',
        properties: {
          offset: {
            anyOf: [
              {
                anyOf: [
                  {
                    not: {},
                  },
                  {
                    type: 'string',
                  },
                ],
              },
              {
                type: 'null',
              },
            ],
            description: 'Pagination offset from the previous response. Pass this to retrieve the next page of results. Omit for the first page.',
          },
        },
        additionalProperties: false,
      },
    ),
    readTool(
      'search_bases',
      'Search bases by name.',
      {
        type: 'object',
        properties: {
          searchQuery: {
            type: 'string',
            description: 'The query to search for bases by name.\nThe search is case-insensitive and works with partial matches.\nExamples: "projects", "issues", "customers"',
          },
        },
        required: [
          'searchQuery',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'list_tables_for_base',
      'List the tables in a base.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base to get the summary of.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
        },
        required: [
          'baseId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'get_table_schema',
      'Read the fields and types of a table.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base containing the tables.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          tables: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tableId: {
                  type: 'string',
                  pattern: '^tbl[A-Za-z0-9]{14}$',
                },
                fieldIds: {
                  type: 'array',
                  items: {
                    type: 'string',
                    pattern: '^fld[A-Za-z0-9]{14}$',
                  },
                  minItems: 1,
                  description: 'The IDs of the fields to get schema information for.\nOmit this to get schema information for every field in the table.',
                },
              },
              required: [
                'tableId',
              ],
              additionalProperties: false,
            },
            minItems: 1,
            description: 'An array of table IDs, each optionally narrowed to specific field IDs.\nMust start with "tbl" and is 17 characters long.\nExample: "tblGlReoTNWfYnXIG".\nDo not substitute user-facing names for tableId.\nTo get tableId, use the list_tables_for_base tool.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
          },
        },
        required: [
          'baseId',
          'tables',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'list_records_for_table',
      'List records in a table.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base containing the table.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          tableId: {
            type: 'string',
            minLength: 1,
            description: 'The table to list records from.\nAccepts either a table ID (e.g., "tblGlReoTNWfYnXIG") or a table name (e.g., "Orders").\nNames are resolved case-insensitively within the base.\nTo discover tables, use the list_tables_for_base tool.',
          },
          fieldIds: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
            },
            description: 'Only data for fields whose IDs or names are in this list will be included in the result.\nPass in only the fields most useful for the user to see.\nIf not provided, all fields will be included in the result.\nAccepts either a field ID (e.g., "fldGlRtkBNWfYnPOV") or a field name (e.g., "Status").\nNames are resolved case-sensitively within the table.\nTo discover fields, use the list_tables_for_base tool.',
          },
          pageSize: {
            type: 'integer',
            exclusiveMinimum: 0,
            maximum: 8000,
            description: 'The maximum number of records to return in the response.\nThe server may respond with fewer records than this value when the total set has fewer records than this value.',
          },
          cursor: {
            type: 'string',
            minLength: 1,
            description: 'The cursor to start from. To begin from the first record, do not include a cursor.\nFor a subsequent paginated request, include the nextCursor from the previous response.',
          },
          sort: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fieldId: {
                  type: 'string',
                  minLength: 1,
                  description: 'The field to sort by. Accepts either a field ID (e.g., "fldGlRtkBNWfYnPOV") or field name (e.g., "Status").',
                },
                direction: {
                  type: 'string',
                  enum: [
                    'asc',
                    'desc',
                  ],
                  description: 'The direction to sort by.',
                },
              },
              required: [
                'fieldId',
              ],
              additionalProperties: false,
            },
            description: 'A list of sort objects that specifies how the records will be ordered.\nEach sort object must have a fieldId key specifying the field to sort on (ID or name), and an optional direction key that is either "asc" or "desc".\nThe default direction is "asc".\nRecords are sorted by the first sort object first, then by the second sort object for records that have the same value for the first sort, and so on.\nExample sort by a single field in descending order: [{"fieldId": "Status", "direction": "desc"}]\nExample sort by two fields, first ascending then descending: [{"fieldId": "Priority", "direction": "asc"}, {"fieldId": "Created", "direction": "desc"}]',
          },
          recordIds: {
            type: 'array',
            items: {
              type: 'string',
              pattern: '^rec[A-Za-z0-9]{14}$',
            },
            minItems: 1,
            description: 'An array of record IDs to filter by. Only records with these IDs will be returned.\nMust start with "rec" and is 17 characters long.\nExample: "recZOTa3BDHxlJNzf".\nDo not substitute user-facing names for IDs\nTo get recordId, use the list_records_for_table tool or display_records_for_table tools.',
          },
          filters: {
            type: 'object',
            properties: {
              operator: {
                type: 'string',
                enum: [
                  'and',
                  'or',
                ],
                description: "The operator to use to combine the operands (filter conditions).\nAcceptable values are 'and' and 'or'.\nThe default operator is 'and'.",
              },
              operands: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    operator: {
                      type: 'string',
                      enum: [
                        '=',
                        '!=',
                        '<',
                        '>',
                        '<=',
                        '>=',
                        'hasAnyOf',
                        'hasAllOf',
                        'isWithin',
                        'isAnyOf',
                        'isNoneOf',
                        'contains',
                        'doesNotContain',
                        'filename',
                        'fileType',
                        'isEmpty',
                        'isNotEmpty',
                      ],
                      description: 'The comparison operator for this filter condition, applied to the operands.\nAcceptable values are =, !=, <, >, <=, >=, hasAnyOf, hasAllOf, isWithin, isAnyOf, isNoneOf, contains, doesNotContain, filename, fileType, isEmpty, isNotEmpty.\nFor singleSelect and singleCollaborator fields, use =, !=, isAnyOf, or isNoneOf.\nFor multipleSelects and multipleCollaborators fields, use hasAnyOf, hasAllOf, =, or doesNotContain.\nFor multipleRecordLinks (linked record) fields, use hasAnyOf, hasAllOf, =, isNoneOf, contains, or doesNotContain.',
                    },
                    operands: {
                      type: 'array',
                      items: {
                        anyOf: [
                          {
                            type: 'string',
                            pattern: '^fld[A-Za-z0-9]{14}$',
                          },
                          {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'number',
                              },
                              {
                                type: 'boolean',
                              },
                              {
                                type: 'null',
                              },
                              {
                                type: 'array',
                                items: {
                                  type: 'string',
                                },
                              },
                              {
                                type: 'string',
                                enum: [
                                  'image',
                                  'text',
                                ],
                              },
                              {
                                anyOf: [
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'today',
                                          'tomorrow',
                                          'yesterday',
                                          'oneWeekAgo',
                                          'oneWeekFromNow',
                                          'oneMonthAgo',
                                          'oneMonthFromNow',
                                        ],
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'exactDate',
                                        ],
                                      },
                                      exactDate: {
                                        type: 'string',
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'exactDate',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'daysAgo',
                                          'daysFromNow',
                                        ],
                                      },
                                      numberOfDays: {
                                        type: 'integer',
                                        minimum: 0,
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'numberOfDays',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                ],
                              },
                              {
                                anyOf: [
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'pastWeek',
                                          'pastMonth',
                                          'pastYear',
                                          'nextWeek',
                                          'nextMonth',
                                          'nextYear',
                                          'thisWeekToDate',
                                          'thisMonthToDate',
                                          'thisYearToDate',
                                          'thisCalendarWeek',
                                          'thisCalendarMonth',
                                          'thisCalendarYear',
                                        ],
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'nextNumberOfDays',
                                          'pastNumberOfDays',
                                        ],
                                      },
                                      numberOfDays: {
                                        type: 'integer',
                                        minimum: 0,
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'numberOfDays',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      minItems: 1,
                      maxItems: 2,
                      description: 'The operands (arguments) to the comparison operator.\nThe first operand must be a field ID. Example: "fld9x4rqyBSCLzsJM". Do not substitute user-facing names for IDs.\nThe second operand depends on the operator and field type:\n    - isEmpty, isNotEmpty: No second operand (use a single-element array with just the field ID).\n    - =, !=, contains, doesNotContain: A string for text fields, a number for number fields, a boolean for checkbox fields.\n    - <, >, <=, >=: A number.\n    - For singleSelect/multipleSelects fields: The second operand must be a choice ID (e.g., "selABCDEFGHIJKLM") obtained from get_table_schema, not the choice\n    name.\n    - hasAnyOf, hasAllOf, isAnyOf, isNoneOf, doesNotContain: An array of strings (e.g., choice IDs for select fields, collaborator IDs for collaborator fields, record IDs for multipleRecordLinks fields).\n    - For multipleRecordLinks (linked record) fields with =, hasAnyOf, hasAllOf, or isNoneOf: The second operand must be an array of record IDs (e.g., ["recABCDEFGHIJKLM"]), not record display names or a plain string. Unlike other field types, = takes an array here. Use contains/doesNotContain with a string to match by record display name instead.\n    - For date/datetime fields with =, !=, <, >, <=, >=: The second operand is a date value object, e.g. {"mode": "today", "timeZone": "America/New_York"}, {"mode": "exactDate",\n    "exactDate": "2024-01-15", "timeZone": "America/New_York"}, or {"mode": "daysAgo", "numberOfDays": 7, "timeZone": "America/New_York"}.\n    - isWithin (date fields only): The second operand is a date range object, e.g. {"mode": "pastWeek", "timeZone": "America/New_York"}, {"mode": "pastNumberOfDays", "numberOfDays":\n    30, "timeZone": "America/New_York"}.\n    - filename: A string to match against attachment filenames.\n    - fileType: Either "image" or "text".\nFor singleSelect/multipleSelects fields, the second operand must be a choice ID (e.g., "selet1KAKDTOhXQJk") obtained from get_table_schema.',
                    },
                    operatorOptions: {
                      type: 'object',
                      properties: {
                        matchGroupsByMembership: {
                          type: 'boolean',
                          description: 'Only set this when operand is a collaborator field.\nWhen true, groups are matched by their individual members.\nWhen false, groups are matched by their literal group ID.',
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  required: [
                    'operator',
                    'operands',
                  ],
                  additionalProperties: false,
                },
                minItems: 1,
                maxItems: 50,
                description: 'A list of filter conditions to apply to the records. These are combined using the top-level operator (default "and").\nEach filter condition must have an "operator" key (the comparison operator, e.g. "=", "contains", "isEmpty", etc) and an "operands" key (an array where\nthe first element is a field ID and the optional second element is the value to compare against).\nExample: [{"operator": "contains", "operands": ["fld9x4rqyBSCLzsJM", "apple"]}]',
              },
            },
            required: [
              'operands',
            ],
            additionalProperties: false,
            description: 'Describes the filters to apply to the records using a structured format.\nExample filter where the value of the field with ID "fld8WsrpLHHevsnW8" is "orange" or the value of the field with ID "fldulcCPDVz87Bmnw" is greater than 5:\n{"operator": "or", "operands": [{"operator": "=", "operands": ["fld8WsrpLHHevsnW8", "orange"]}, {"operator": ">", "operands": ["fldulcCPDVz87Bmnw", 5]}]}\nExample filter where the value of the collaborator field with ID "fldCRi9oz2vRLcIWr" can be any user in a group with ID "ugpDUVUnftA7H9bG8" and the value of the field with ID "fldgD18XtsueoiguT" equals select option with ID "selha8nGNAT5ATR7P":\n{"operator": "and", "operands": [{"operator": "hasAnyOf", "operands": ["fldCRi9oz2vRLcIWr", "ugpDUVUnftA7H9bG8"], "operatorOptions": {"matchGroupsByMembership": true}}, {"operator": "=", "operands": ["fldgD18XtsueoiguT", "selha8nGNAT5ATR7P"]}]}\nExample filter for records where a date field is within the past week:\n{"operands": [{"operator": "isWithin", "operands": ["fldABC12345678x", {"mode": "pastWeek", "timeZone": "America/New_York"}]}]}\nExample filter for records where a field is not empty:\n{"operands": [{"operator": "isNotEmpty", "operands": ["fldABC12345678x"]}]}',
          },
        },
        required: [
          'baseId',
          'tableId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'list_record_comments',
      'List the comments on a record.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          tableId: {
            type: 'string',
            pattern: '^tbl[A-Za-z0-9]{14}$',
            description: 'The ID of the table.\nMust start with "tbl" and is 17 characters long.\nExample: "tblGlReoTNWfYnXIG".\nDo not substitute user-facing names for tableId.\nTo get tableId, use the list_tables_for_base tool.',
          },
          recordId: {
            type: 'string',
            pattern: '^rec[A-Za-z0-9]{14}$',
            description: 'The ID of the record.\nMust start with "rec" and is 17 characters long.\nExample: "recZOTa3BDHxlJNzf".\nDo not substitute user-facing names for IDs\nTo get recordId, use the list_records_for_table tool or display_records_for_table tools.',
          },
          pageSize: {
            type: 'integer',
            exclusiveMinimum: 0,
            maximum: 100,
            description: 'The number of comments to return per page. Maximum and default is 100.',
          },
          offset: {
            type: 'string',
            description: 'Pass the offset from a previous response to fetch the next page.',
          },
        },
        required: [
          'baseId',
          'tableId',
          'recordId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'list_records_for_page',
      'List records shown on an interface page.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base (application) containing the page.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          pageId: {
            type: 'string',
            pattern: '^pag[A-Za-z0-9]{14}$',
            description: 'The ID of the interface page to read records from.\nMust start with "pag" and is 17 characters long.\nExample: "pagXxYyZzAaBbCcDd".',
          },
          interfaceId: {
            type: 'string',
            pattern: '^pbd[A-Za-z0-9]{14}$',
            description: 'The ID of the interface that contains the page.\nMust start with "pbd" and is 17 characters long.',
          },
          elementId: {
            type: 'string',
            pattern: '^pel[A-Za-z0-9]{14}$',
            description: 'The ID of a specific element to query records for.\nRequired for dashboard pages. Obtain element IDs from the dashboardElements\narray in the list_pages_for_base response.\nMust start with "pel" and is 17 characters long.',
          },
          fieldIds: {
            type: 'array',
            items: {
              type: 'string',
              pattern: '^fld[A-Za-z0-9]{14}$',
            },
            description: "Only data for fields whose IDs are in this list will be included in the result.\nPass in only the fields most useful for the user to see.\nIf not provided, the fields visible in the page element's visualization will be returned.\nFor hierarchy pages, field IDs are matched against each table — a field belonging to\nthe projects table will filter the projects records, and one belonging to the tasks\ntable will filter the tasks records. You can mix field IDs from different tables.\nField IDs must start with \"fld\" and is 17 characters long.\nExample: \"fldGlRtkBNWfYnPOV\".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.\nFor interface-only bases, use the field IDs from the list_pages_for_base response instead.",
          },
          pageSize: {
            type: 'integer',
            exclusiveMinimum: 0,
            maximum: 1000,
            description: 'The maximum number of records to return in the response.\nThe server may respond with fewer records than this value when the total set has fewer records than this value.',
          },
          filters: {
            type: 'object',
            properties: {
              operator: {
                type: 'string',
                enum: [
                  'and',
                  'or',
                ],
                description: "The operator to use to combine the operands (filter conditions).\nAcceptable values are 'and' and 'or'.\nThe default operator is 'and'.",
              },
              operands: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    operator: {
                      type: 'string',
                      enum: [
                        '=',
                        '!=',
                        '<',
                        '>',
                        '<=',
                        '>=',
                        'hasAnyOf',
                        'hasAllOf',
                        'isWithin',
                        'isAnyOf',
                        'isNoneOf',
                        'contains',
                        'doesNotContain',
                        'filename',
                        'fileType',
                        'isEmpty',
                        'isNotEmpty',
                      ],
                      description: 'The comparison operator for this filter condition, applied to the operands.\nAcceptable values are =, !=, <, >, <=, >=, hasAnyOf, hasAllOf, isWithin, isAnyOf, isNoneOf, contains, doesNotContain, filename, fileType, isEmpty, isNotEmpty.\nFor singleSelect and singleCollaborator fields, use =, !=, isAnyOf, or isNoneOf.\nFor multipleSelects and multipleCollaborators fields, use hasAnyOf, hasAllOf, =, or doesNotContain.\nFor multipleRecordLinks (linked record) fields, use hasAnyOf, hasAllOf, =, isNoneOf, contains, or doesNotContain.',
                    },
                    operands: {
                      type: 'array',
                      items: {
                        anyOf: [
                          {
                            type: 'string',
                            pattern: '^fld[A-Za-z0-9]{14}$',
                          },
                          {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'number',
                              },
                              {
                                type: 'boolean',
                              },
                              {
                                type: 'null',
                              },
                              {
                                type: 'array',
                                items: {
                                  type: 'string',
                                },
                              },
                              {
                                type: 'string',
                                enum: [
                                  'image',
                                  'text',
                                ],
                              },
                              {
                                anyOf: [
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'today',
                                          'tomorrow',
                                          'yesterday',
                                          'oneWeekAgo',
                                          'oneWeekFromNow',
                                          'oneMonthAgo',
                                          'oneMonthFromNow',
                                        ],
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'exactDate',
                                        ],
                                      },
                                      exactDate: {
                                        type: 'string',
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'exactDate',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'daysAgo',
                                          'daysFromNow',
                                        ],
                                      },
                                      numberOfDays: {
                                        type: 'integer',
                                        minimum: 0,
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'numberOfDays',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                ],
                              },
                              {
                                anyOf: [
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'pastWeek',
                                          'pastMonth',
                                          'pastYear',
                                          'nextWeek',
                                          'nextMonth',
                                          'nextYear',
                                          'thisWeekToDate',
                                          'thisMonthToDate',
                                          'thisYearToDate',
                                          'thisCalendarWeek',
                                          'thisCalendarMonth',
                                          'thisCalendarYear',
                                        ],
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                  {
                                    type: 'object',
                                    properties: {
                                      mode: {
                                        type: 'string',
                                        enum: [
                                          'nextNumberOfDays',
                                          'pastNumberOfDays',
                                        ],
                                      },
                                      numberOfDays: {
                                        type: 'integer',
                                        minimum: 0,
                                      },
                                      timeZone: {
                                        type: 'string',
                                        description: 'IANA time zone identifier (e.g., "America/New_York").',
                                      },
                                    },
                                    required: [
                                      'mode',
                                      'numberOfDays',
                                      'timeZone',
                                    ],
                                    additionalProperties: false,
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      minItems: 1,
                      maxItems: 2,
                      description: 'The operands (arguments) to the comparison operator.\nThe first operand must be a field ID. Example: "fld9x4rqyBSCLzsJM". Do not substitute user-facing names for IDs.\nThe second operand depends on the operator and field type:\n    - isEmpty, isNotEmpty: No second operand (use a single-element array with just the field ID).\n    - =, !=, contains, doesNotContain: A string for text fields, a number for number fields, a boolean for checkbox fields.\n    - <, >, <=, >=: A number.\n    - For singleSelect/multipleSelects fields: The second operand must be a choice ID (e.g., "selABCDEFGHIJKLM") obtained from get_table_schema, not the choice\n    name.\n    - hasAnyOf, hasAllOf, isAnyOf, isNoneOf, doesNotContain: An array of strings (e.g., choice IDs for select fields, collaborator IDs for collaborator fields, record IDs for multipleRecordLinks fields).\n    - For multipleRecordLinks (linked record) fields with =, hasAnyOf, hasAllOf, or isNoneOf: The second operand must be an array of record IDs (e.g., ["recABCDEFGHIJKLM"]), not record display names or a plain string. Unlike other field types, = takes an array here. Use contains/doesNotContain with a string to match by record display name instead.\n    - For date/datetime fields with =, !=, <, >, <=, >=: The second operand is a date value object, e.g. {"mode": "today", "timeZone": "America/New_York"}, {"mode": "exactDate",\n    "exactDate": "2024-01-15", "timeZone": "America/New_York"}, or {"mode": "daysAgo", "numberOfDays": 7, "timeZone": "America/New_York"}.\n    - isWithin (date fields only): The second operand is a date range object, e.g. {"mode": "pastWeek", "timeZone": "America/New_York"}, {"mode": "pastNumberOfDays", "numberOfDays":\n    30, "timeZone": "America/New_York"}.\n    - filename: A string to match against attachment filenames.\n    - fileType: Either "image" or "text".\nFor singleSelect/multipleSelects fields, the second operand must be a choice ID (e.g., "selet1KAKDTOhXQJk") obtained from get_table_schema.',
                    },
                    operatorOptions: {
                      type: 'object',
                      properties: {
                        matchGroupsByMembership: {
                          type: 'boolean',
                          description: 'Only set this when operand is a collaborator field.\nWhen true, groups are matched by their individual members.\nWhen false, groups are matched by their literal group ID.',
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  required: [
                    'operator',
                    'operands',
                  ],
                  additionalProperties: false,
                },
                minItems: 1,
                maxItems: 50,
                description: 'A list of filter conditions to apply to the records. These are combined using the top-level operator (default "and").\nEach filter condition must have an "operator" key (the comparison operator, e.g. "=", "contains", "isEmpty", etc) and an "operands" key (an array where\nthe first element is a field ID and the optional second element is the value to compare against).\nExample: [{"operator": "contains", "operands": ["fld9x4rqyBSCLzsJM", "apple"]}]',
              },
            },
            required: [
              'operands',
            ],
            additionalProperties: false,
            description: "Additional filters to apply on top of the page element's built-in filters.\nThese are combined with the element's static filters using AND.\nFor hierarchy pages, filters apply only to the source level's table. Related levels\nmay be constrained indirectly through the hierarchy's foreign key relationships.\nDescribes the filters to apply to the records using a structured format.\nExample filter where the value of the field with ID \"fld8WsrpLHHevsnW8\" is \"orange\" or the value of the field with ID \"fldulcCPDVz87Bmnw\" is greater than 5:\n{\"operator\": \"or\", \"operands\": [{\"operator\": \"=\", \"operands\": [\"fld8WsrpLHHevsnW8\", \"orange\"]}, {\"operator\": \">\", \"operands\": [\"fldulcCPDVz87Bmnw\", 5]}]}\nExample filter where the value of the collaborator field with ID \"fldCRi9oz2vRLcIWr\" can be any user in a group with ID \"ugpDUVUnftA7H9bG8\" and the value of the field with ID \"fldgD18XtsueoiguT\" equals select option with ID \"selha8nGNAT5ATR7P\":\n{\"operator\": \"and\", \"operands\": [{\"operator\": \"hasAnyOf\", \"operands\": [\"fldCRi9oz2vRLcIWr\", \"ugpDUVUnftA7H9bG8\"], \"operatorOptions\": {\"matchGroupsByMembership\": true}}, {\"operator\": \"=\", \"operands\": [\"fldgD18XtsueoiguT\", \"selha8nGNAT5ATR7P\"]}]}\nExample filter for records where a date field is within the past week:\n{\"operands\": [{\"operator\": \"isWithin\", \"operands\": [\"fldABC12345678x\", {\"mode\": \"pastWeek\", \"timeZone\": \"America/New_York\"}]}]}\nExample filter for records where a field is not empty:\n{\"operands\": [{\"operator\": \"isNotEmpty\", \"operands\": [\"fldABC12345678x\"]}]}",
          },
        },
        required: [
          'baseId',
          'pageId',
          'interfaceId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'list_pages_for_base',
      'List the interface pages in a base.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base to list pages from.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          shouldIncludeRecordDetailPages: {
            type: 'boolean',
            description: "When true, also return the record detail pages this base's pages\nopen records into, in the top-level recordDetailPages array. Each entry\ncarries the page's table schema and per-field editability (unless\nshouldIncludeTableSchema is false). Before creating a\npage that opens records into a detail view, check here for an existing record\ndetail page on the same table and pass its ID as the recordDetailPageId in\ncreate_page instead of creating a duplicate.",
          },
          shouldIncludeDraftPages: {
            type: 'boolean',
            description: "When true, also return this base's draft pages in a top-level draftPages array. Use this\nto find pages with no published layout (never published or since unpublished). When\nshouldIncludeRecordDetailPages is also set, draftPages additionally includes record\ndetail pages not reachable via a published page. Each draft page includes only\nits id, name, interfaceId, interfaceName, and pageType, never layout detail. Callers who\ncannot read unpublished changes, such as those with \"interfaceOnly\"\npermissionLevel, get a permission error when setting this.",
          },
          shouldIncludeTableSchema: {
            type: 'boolean',
            description: "Defaults to true. Set to false to omit tablesByTableId (the per-table field lists)\nfrom every page and record detail page entry, which makes the response much smaller\nfor bases with many pages. Page ids, names, types, source tables, dashboard elements,\nand record detail linkage are still returned. Use this to survey a base's pages\nfirst, then call list_tables_for_base or this tool again with the\ndefault when you need field-level detail.",
          },
          pageIds: {
            type: 'array',
            items: {
              type: 'string',
              pattern: '^pag[A-Za-z0-9]{14}$',
            },
            description: 'When provided, restrict the response to these pages. Interfaces with no matching\npages are omitted.',
          },
        },
        required: [
          'baseId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'list_views_for_table',
      'List the views of a table.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base that contains the table.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          tableId: {
            type: 'string',
            minLength: 1,
            description: 'The table to list views from.\nAccepts either a table ID (e.g., "tblGlReoTNWfYnXIG") or a table name (e.g., "Orders").\nNames are resolved case-insensitively within the base.\nTo discover tables, use the list_tables_for_base tool.',
          },
        },
        required: [
          'baseId',
          'tableId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'get_record_for_page',
      'Read one record as an interface page shows it.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base (application) containing the page.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          interfaceId: {
            type: 'string',
            pattern: '^pbd[A-Za-z0-9]{14}$',
            description: 'The ID of the interface that contains the page.\nMust start with "pbd" and is 17 characters long.',
          },
          path: {
            type: 'object',
            properties: {
              root: {
                type: 'object',
                properties: {
                  pageId: {
                    type: 'string',
                    pattern: '^pag[A-Za-z0-9]{14}$',
                    description: 'The page where the record was listed.\nMust start with "pag" and is 17 characters long.\nExample: "pagXxYyZzAaBbCcDd".',
                  },
                  recordId: {
                    type: 'string',
                    pattern: '^rec[A-Za-z0-9]{14}$',
                    description: 'A record from list_records_for_page results. With no edges, this is\nthe record returned. With edges, this is the starting point of the navigation.\nMust start with "rec" and is 17 characters long.\nExample: "recZOTa3BDHxlJNzf".\nDo not substitute user-facing names for IDs\nTo get recordId, use the list_records_for_table tool or display_records_for_table tools.',
                  },
                  elementId: {
                    type: 'string',
                    pattern: '^pel[A-Za-z0-9]{14}$',
                    description: 'The ID of the dashboard element to query. Required for dashboard pages.\nObtain element IDs from the dashboardElements array in the\nlist_pages_for_base response.\nMust start with "pel" and is 17 characters long.',
                  },
                },
                required: [
                  'pageId',
                  'recordId',
                ],
                additionalProperties: false,
                description: 'The page and starting record. Set once from list_records_for_page results;\nstays the same as edges are appended.',
              },
              edges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    fieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The linked record field used to traverse to the detail page.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                    linkedRecordId: {
                      type: 'string',
                      pattern: '^rec[A-Za-z0-9]{14}$',
                      description: 'The record to navigate to by following the linked record field.\nMust start with "rec" and is 17 characters long.\nExample: "recZOTa3BDHxlJNzf".\nDo not substitute user-facing names for IDs\nTo get recordId, use the list_records_for_table tool or display_records_for_table tools.',
                    },
                  },
                  required: [
                    'fieldId',
                    'linkedRecordId',
                  ],
                  additionalProperties: false,
                },
                description: 'Linked record traversals leading to the target record.\nEmpty array if the record is directly listed on the root page.',
              },
            },
            required: [
              'root',
              'edges',
            ],
            additionalProperties: false,
            description: 'The navigation path from the page where the record was listed.\nConstruct the root from the same pageId used in list_records_for_page.',
          },
          fieldIds: {
            type: 'array',
            items: {
              type: 'string',
              pattern: '^fld[A-Za-z0-9]{14}$',
            },
            description: 'Only data for fields whose IDs are in this list will be included in the result.\nIf not provided, all fields visible on the page will be returned.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
          },
        },
        required: [
          'baseId',
          'interfaceId',
          'path',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'get_form_schema',
      'Read the fields of a form.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base containing the form page.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          pageId: {
            type: 'string',
            pattern: '^pag[A-Za-z0-9]{14}$',
            description: 'The ID of the form page whose schema you want to read.\nMust start with "pag" and is 17 characters long.\nExample: "pagXxYyZzAaBbCcDd".',
          },
          interfaceId: {
            type: 'string',
            pattern: '^pbd[A-Za-z0-9]{14}$',
            description: 'The ID of the interface containing the form page, if the form is in an interface.\nMust start with "pbd" and is 17 characters long.',
          },
        },
        required: [
          'baseId',
          'pageId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'search_records',
      'Search records in a table.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base containing the table.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          table: {
            type: 'string',
            description: 'The table to search. Accepts either a table ID (e.g., "tblGlReoTNWfYnXIG") or a table name (e.g., "Orders"). Names are resolved case-insensitively within the base.',
          },
          query: {
            type: 'string',
            description: 'The search query. Matches are case-insensitive and term-order independent. Examples: "acme" matches "Acme Corp", "john smith" matches "Smith, John", ""Q1 Report"" (quoted) matches the exact phrase only.',
          },
          fields: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              {
                type: 'string',
                const: 'ALL_SEARCHABLE_FIELDS',
              },
            ],
            description: 'The fields to search over. Either pass an array of field IDs/names, or the literal string "ALL_SEARCHABLE_FIELDS" to search across all searchable fields in the table. Field IDs look like "fldGlRtkBNWfYnPOV". Field names (e.g., "Status") are resolved case-insensitively. Note: Not all field types are searchable. If this fails, fallback to using the list_records_for_table tool instead.',
          },
          limit: {
            type: 'integer',
            exclusiveMinimum: 0,
            maximum: 500,
            description: 'The maximum number of records to return, ordered by search relevance. Defaults to 100. Maximum 500.',
          },
          resultFieldIds: {
            type: 'array',
            items: {
              type: 'string',
              minLength: 1,
            },
            description: 'The field IDs or names of the fields to include in the result. If not provided, defaults to the fields being searched over (the "fields" parameter), or to all fields when searching over ALL_SEARCHABLE_FIELDS. Pass this explicitly to include fields beyond the ones being searched.\nAccepts either a field ID (e.g., "fldGlRtkBNWfYnPOV") or a field name (e.g., "Status").\nNames are resolved case-sensitively within the table.\nTo discover fields, use the list_tables_for_base tool.',
          },
        },
        required: [
          'baseId',
          'table',
          'query',
          'fields',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'search_candidate_linked_records',
      'Search records that a linked-record field could point to.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base containing the page and the linked-record field.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          pageId: {
            type: 'string',
            pattern: '^pag[A-Za-z0-9]{14}$',
            description: 'The ID of the page that surfaces the linked-record field.\nMust start with "pag" and is 17 characters long.\nExample: "pagXxYyZzAaBbCcDd".',
          },
          interfaceId: {
            anyOf: [
              {
                type: 'string',
                pattern: '^pbd[A-Za-z0-9]{14}$',
              },
              {
                type: 'null',
              },
            ],
            description: 'The ID of the interface containing the page, or null/omitted for a standalone form (one\nthat is not inside an interface).\nMust start with "pbd" and is 17 characters long.',
          },
          fieldId: {
            type: 'string',
            pattern: '^fld[A-Za-z0-9]{14}$',
            description: 'The ID of the linked-record (foreign-key) field whose candidate records you want to\nsearch.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
          },
          query: {
            type: 'string',
            description: "The text to search candidate records by. Matching is case-insensitive against each\nrecord's display name. Pass an empty string to list candidates without filtering.",
          },
          limit: {
            type: 'integer',
            exclusiveMinimum: 0,
            maximum: 100,
            description: 'The maximum number of records to return. The server may return fewer. Defaults to a\nsmall page size when omitted.',
          },
          fields: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: {},
              },
              {
                type: 'null',
              },
            ],
            description: "The values entered so far (or planned) for the OTHER fields of the record being\nfilled. The linked field's cross-field dynamic record-selection filters are evaluated\nagainst these values, and omitting them can return records that are not actually\nselectable. When searching candidates for a new record (e.g. a\nsubmit_form submission), always pass every other field value you know.\nWhen editing an existing record (recordId provided), pass the values you are changing\nin the same update — each value here overrides the record's stored value, and fields\nnot passed fall back to the stored values.\nField IDs must start with \"fld\" and is 17 characters long.\nExample: \"fldGlRtkBNWfYnPOV\".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.",
          },
          recordId: {
            anyOf: [
              {
                type: 'string',
                pattern: '^rec[A-Za-z0-9]{14}$',
              },
              {
                type: 'null',
              },
            ],
            description: "The ID of the EXISTING record being updated, when searching linked records in the\ncontext of an existing record (e.g. for update_records_for_table). The\nrecord's stored values are used to apply the linked field's cross-field dynamic\nrecord-selection filters, except for values you also pass in fields, which take\nprecedence — so pass both when the update changes a value those filters depend on.\nMust start with \"rec\" and is 17 characters long.\nExample: \"recZOTa3BDHxlJNzf\".\nDo not substitute user-facing names for IDs\nTo get recordId, use the list_records_for_table tool or display_records_for_table tools.",
          },
        },
        required: [
          'baseId',
          'pageId',
          'fieldId',
          'query',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'describe_page_type',
      'Describe an interface page type.',
      {
        type: 'object',
        properties: {
          pageType: {
            type: 'string',
            enum: [
              'visualization',
              'dashboard',
              'recordDetail',
            ],
            description: 'The page type to get the config schema for.',
          },
        },
        required: [
          'pageType',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'describe_page_element',
      'Describe an interface page element.',
      {
        type: 'object',
        properties: {
          elementType: {
            type: 'string',
            enum: [
              'kanban',
              'list',
              'calendar',
              'gallery',
              'grid',
              'timeline',
              'recordReview',
              'number',
              'barChart',
              'lineChart',
              'scatterChart',
              'pieChart',
              'donutChart',
              'pivotTable',
            ],
            description: 'The page element type to get the config schema for.',
          },
        },
        required: [
          'elementType',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'get_create_automation_instructions',
      'Read Airtable guidance text on how automations are built.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base you plan to create automations in. Providing this includes features that may be available for this base but not globally. If omitted, only globally available features are returned.',
          },
        },
        additionalProperties: false,
      },
    ),
    readTool(
      'list_automations',
      'List the automations in a base.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base to list automations from.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          triggerType: {
            type: 'string',
            enum: [
              'recordEntersView',
              'recordCreated',
              'recordUpdated',
              'recordMatchesConditions',
              'googleSheetsRowCreated',
              'googleFormsNewResponse',
              'googleCalendarEventCreated',
              'googleCalendarEventChanged',
              'googleCalendarEventCancelled',
              'cron',
              'microsoftOutlookEventCreated',
              'microsoftOutlookEventChanged',
              'microsoftOutlookNewEmail',
              'genericWebhookReceived',
              'emailReceived',
              'formSubmitted',
              'inputReceivedFromConnection',
              'agentTriggerReceived',
              'rowCommentCreated',
              'testTrigger',
            ],
            description: 'Optional trigger type to filter automations by (e.g., "agentTriggerReceived").',
          },
          includeDeployedVersion: {
            type: 'boolean',
            description: 'When true, each returned automation includes a `deployedVersion` field showing the most recently published configuration when it differs from the draft.',
          },
        },
        required: [
          'baseId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'list_automation_runs',
      'List recent runs of an automation.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base containing the automation.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          automationId: {
            type: 'string',
            pattern: '^wfl[A-Za-z0-9]{14}$',
            description: 'The ID of the automation whose runs to list.\nMust start with "wfl" and is 17 characters long.\nExample: "wflGlRtkBNWfYnPOV".\nDo not guess or construct an automationId.\nTo get automationId, use the list_automations or create_automation tool.',
          },
          status: {
            type: 'string',
            enum: [
              'success',
              'failure',
              'canceled',
            ],
            description: 'Return only runs with this status. Use "failure" when diagnosing.',
          },
          startedBefore: {
            type: 'string',
            format: 'date-time',
            description: 'Returns runs queued before this time. Must be an ISO 8601 datetime with either Z or an explicit timezone offset.',
          },
          pageSize: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Number of runs to return. Defaults to 20, maximum 100.',
          },
          cursor: {
            type: 'string',
            pattern: '^wfx[A-Za-z0-9]{14}$',
            description: 'Pass nextCursor from a previous response to fetch the following page.\nMust start with "wfx" and is 17 characters long.\nExample: "wfxR9dBiKHQokh1Jt".',
          },
        },
        required: [
          'baseId',
          'automationId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'get_automation',
      'Read one automation definition.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base containing the automation.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          automationId: {
            type: 'string',
            pattern: '^wfl[A-Za-z0-9]{14}$',
            description: 'The ID of the automation to retrieve.\nMust start with "wfl" and is 17 characters long.\nExample: "wflGlRtkBNWfYnPOV".\nDo not guess or construct an automationId.\nTo get automationId, use the list_automations or create_automation tool.',
          },
          includeDeployedVersion: {
            type: 'boolean',
            description: 'When true, each returned automation includes a `deployedVersion` field showing the most recently published configuration when it differs from the draft.',
          },
        },
        required: [
          'baseId',
          'automationId',
        ],
        additionalProperties: false,
      },
    ),
    readTool(
      'analyze_table',
      'Summarize the shape of a table.',
      {
        type: 'object',
        properties: {
          baseId: {
            type: 'string',
            pattern: '^app[A-Za-z0-9]{14}$',
            description: 'The ID of the base containing the table.\nMust start with "app" and is 17 characters long.\nExample: "appZfrNIUEip5MazD".\nDo not substitute user-facing names for baseId.\nTo get baseId, use the search_bases or list_bases tool.',
          },
          tableId: {
            type: 'string',
            pattern: '^tbl[A-Za-z0-9]{14}$',
            description: 'The ID of the table to analyze.\nMust start with "tbl" and is 17 characters long.\nExample: "tblGlReoTNWfYnXIG".\nDo not substitute user-facing names for tableId.\nTo get tableId, use the list_tables_for_base tool.',
          },
          operation: {
            type: 'string',
            enum: [
              'sum',
              'avg',
              'median',
              'count',
              'min',
              'max',
              'stdev',
              'variance',
              'distinct',
            ],
            description: 'The aggregation operation to perform. Do not provide a numericField for "count" operations.',
          },
          numericField: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    const: 'field',
                    description: 'A field-based source. Use this type for existing fields in the table.',
                  },
                  fieldId: {
                    type: 'string',
                    pattern: '^fld[A-Za-z0-9]{14}$',
                    description: 'The ID of the field to use as the source.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                  },
                },
                required: [
                  'type',
                  'fieldId',
                ],
                additionalProperties: false,
                description: 'An existing field in the table.',
              },
              {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    const: 'formula',
                    description: 'A formula-based source. Use this type to dynamically compute a value using an Airtable formula.',
                  },
                  name: {
                    type: 'string',
                    description: 'A display name for the field computed from the formula. This will be present in the output.',
                  },
                  formula: {
                    type: 'string',
                    maxLength: 500,
                    description: 'An Airtable formula. Reference fields using their field ID in curly braces, e.g. "{fldABC12345678xyz} - {fldXYZ12345678abc}".',
                  },
                },
                required: [
                  'type',
                  'name',
                  'formula',
                ],
                additionalProperties: false,
                description: 'An ad-hoc formula computed from one or more fields in the table.',
              },
            ],
            description: 'The field to aggregate. Required for operations other than "count".',
          },
          filters: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    fieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The ID of the field to filter on.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                    operator: {
                      type: 'string',
                      enum: [
                        '=',
                        '!=',
                        '<',
                        '>',
                        '<=',
                        '>=',
                      ],
                      description: 'The comparison operator to apply. These operators have their typical SQL-esque meanings.',
                    },
                    value: {
                      anyOf: [
                        {
                          type: 'string',
                          description: "A string value. For text fields: case-sensitive. For date fields: 'YYYY-MM-DD'\n(day-level) or ISO 8601 (time-level). For select fields: the choice ID. For\ncollaborator fields: the user ID (prefixed with \"usr\").",
                        },
                        {
                          type: 'number',
                          description: 'A numeric value. Behaves as a JavaScript number.',
                        },
                        {
                          type: 'boolean',
                          description: 'A boolean value: true or false.',
                        },
                        {
                          type: 'array',
                          items: {
                            type: 'string',
                          },
                          description: 'A list of string values. Each entry can be a choice ID, collaborator ID, email, linked record ID, or a name.',
                        },
                      ],
                    },
                  },
                  required: [
                    'fieldId',
                    'operator',
                    'value',
                  ],
                  additionalProperties: false,
                  description: 'A mathematical comparison (=, !=, <, >, <=, >=).',
                },
                {
                  type: 'object',
                  properties: {
                    fieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The ID of the field to filter on.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                    operator: {
                      type: 'string',
                      const: 'hasAnyOf',
                    },
                    value: {
                      type: 'array',
                      items: {
                        type: 'string',
                      },
                      description: 'A list of string values. Each entry can be a choice ID, collaborator ID, email, linked record ID, or a name.',
                    },
                  },
                  required: [
                    'fieldId',
                    'operator',
                    'value',
                  ],
                  additionalProperties: false,
                  description: 'Checks if a multi-valued field contains at least one of the given values.',
                },
                {
                  type: 'object',
                  properties: {
                    fieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The ID of the field to filter on.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                    operator: {
                      type: 'string',
                      const: 'hasAllOf',
                    },
                    value: {
                      type: 'array',
                      items: {
                        type: 'string',
                      },
                      description: 'A list of string values. Each entry can be a choice ID, collaborator ID, email, linked record ID, or a name.',
                    },
                  },
                  required: [
                    'fieldId',
                    'operator',
                    'value',
                  ],
                  additionalProperties: false,
                  description: 'Checks if a multi-valued field contains all of the given values.',
                },
                {
                  type: 'object',
                  properties: {
                    fieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The ID of the field to filter on.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                    operator: {
                      type: 'string',
                      const: 'isAnyOf',
                    },
                    value: {
                      type: 'array',
                      items: {
                        type: 'string',
                      },
                      description: 'A list of string values. Each entry can be a choice ID, collaborator ID, email, linked record ID, or a name.',
                    },
                  },
                  required: [
                    'fieldId',
                    'operator',
                    'value',
                  ],
                  additionalProperties: false,
                  description: 'Checks if a single-valued field equals any of the given values.',
                },
                {
                  type: 'object',
                  properties: {
                    fieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The ID of the field to filter on.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                    operator: {
                      type: 'string',
                      const: 'isEmpty',
                    },
                    value: {
                      type: 'boolean',
                      description: 'If true, the field must be empty. If false, the field must not be empty.',
                    },
                  },
                  required: [
                    'fieldId',
                    'operator',
                    'value',
                  ],
                  additionalProperties: false,
                  description: 'Checks if a field is empty or not empty.',
                },
                {
                  type: 'object',
                  properties: {
                    fieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The ID of the field to filter on.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                    operator: {
                      type: 'string',
                      const: 'contains',
                    },
                    value: {
                      type: 'string',
                      description: 'The substring the field must contain.',
                    },
                  },
                  required: [
                    'fieldId',
                    'operator',
                    'value',
                  ],
                  additionalProperties: false,
                  description: 'Checks if a text field contains the given substring.',
                },
                {
                  type: 'object',
                  properties: {
                    fieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The ID of the field to filter on.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                    operator: {
                      type: 'string',
                      const: 'doesNotContain',
                    },
                    value: {
                      type: 'string',
                      description: 'The substring the field must not contain.',
                    },
                  },
                  required: [
                    'fieldId',
                    'operator',
                    'value',
                  ],
                  additionalProperties: false,
                  description: 'Checks if a text field does not contain the given substring.',
                },
              ],
              description: 'A filter to apply to the table before analysis.',
            },
            description: 'Filters to apply to the table. Only rows matching the filters are included in the analysis.',
          },
          filterOperator: {
            type: 'string',
            enum: [
              'and',
              'or',
            ],
            description: 'The logical top-level operator for combining multiple filters. Defaults to "and".',
          },
          groupByFields: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      const: 'field',
                      description: 'A field-based source. Use this type for existing fields in the table.',
                    },
                    fieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The ID of the field to use as the source.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                  },
                  required: [
                    'type',
                    'fieldId',
                  ],
                  additionalProperties: false,
                  description: 'An existing field in the table.',
                },
                {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      const: 'formula',
                      description: 'A formula-based source. Use this type to dynamically compute a value using an Airtable formula.',
                    },
                    name: {
                      type: 'string',
                      description: 'A display name for the field computed from the formula. This will be present in the output.',
                    },
                    formula: {
                      type: 'string',
                      maxLength: 500,
                      description: 'An Airtable formula. Reference fields using their field ID in curly braces, e.g. "{fldABC12345678xyz} - {fldXYZ12345678abc}".',
                    },
                  },
                  required: [
                    'type',
                    'name',
                    'formula',
                  ],
                  additionalProperties: false,
                  description: 'An ad-hoc formula computed from one or more fields in the table.',
                },
                {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      const: 'date',
                      description: 'A date-based source. Use this type to group rows into time buckets, e.g. to compute a value over time.',
                    },
                    name: {
                      type: 'string',
                      description: 'A display name for the computed date-based field. This will be present in the output.',
                    },
                    dependentFieldId: {
                      type: 'string',
                      pattern: '^fld[A-Za-z0-9]{14}$',
                      description: 'The ID of the date field used to compute time buckets.\nField IDs must start with "fld" and is 17 characters long.\nExample: "fldGlRtkBNWfYnPOV".\nDo not substitute user-facing names for IDs.\nTo get fieldId, use the list_tables_for_base tool.',
                    },
                    timeBucket: {
                      type: 'string',
                      enum: [
                        'year',
                        'yearMonth',
                        'yearWeek',
                        'yearMonthDate',
                      ],
                      description: 'The time bucket granularity for grouping dates.',
                    },
                  },
                  required: [
                    'type',
                    'name',
                    'dependentFieldId',
                    'timeBucket',
                  ],
                  additionalProperties: false,
                  description: 'A date field bucketed into time intervals, for grouping rows by time.',
                },
              ],
              description: 'A field to group by before aggregating.',
            },
            minItems: 1,
            description: 'Fields to group by before performing the operation. The operation runs independently on each group.',
          },
        },
        required: [
          'baseId',
          'tableId',
          'operation',
        ],
        additionalProperties: false,
      },
    ),
  ],
};
