/**
 * Google Calendar — first pre-registered hosted-MCP entry (TASK-172 §10 step 8).
 *
 * Google's official MCP docs describe OAuth 2.0 over HTTP at
 * `https://calendarmcp.googleapis.com/mcp/v1` and require a Web application
 * OAuth client. The issuer and OAuth endpoints below match Google's OIDC
 * discovery document. Client credentials are instance configuration only
 * (`GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET`); neither is
 * part of this entry. Until both exist, readiness projects `not_configured` and
 * the Tools page offers no Connect action.
 *
 * Google documents the three requested Calendar read scopes below. This entry
 * pins only tools whose captured annotation has `readOnlyHint: true`, and keeps
 * all four writers out. The committed `tools/list` fixture was captured
 * unauthenticated; the first authenticated tools/list in the live walk is the
 * required drift check. Google currently labels Calendar MCP Developer Preview.
 * Google's web-server OAuth guide recommends `access_type=offline` so the
 * authorization-code flow can return a refresh token.
 *
 * Sources: https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server
 * https://developers.google.com/identity/openid-connect/reference
 */
import type { HostedMcpEntry, HostedMcpPinnedTool } from '../../services/hostedMcpEntryService';

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false };

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

export const GOOGLE_CALENDAR_ENTRY: HostedMcpEntry = {
  id: 'google-calendar',
  title: 'Google Calendar',
  description: 'Read calendars, events and availability in your Google account.',
  resource: 'https://calendarmcp.googleapis.com/mcp/v1',
  issuer: 'https://accounts.google.com',
  client: 'pre-registered',
  authorizationParams: { access_type: 'offline' },
  scopes: [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.freebusy',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ],
  revoke: {
    page: 'https://myaccount.google.com/permissions',
    endpoint: 'https://oauth2.googleapis.com/revoke',
  },
  tools: [
    readTool(
      'list_events',
      'List events from a calendar within the requested time range.',
      {
        description: 'Request message for ListEvents.',
        properties: {
          calendarId: {
            description: 'Optional. ID of the calendar containing the events. Email address - can be resolved using `list_calendars`. Default: primary calendar.',
            type: 'string',
          },
          endTime: {
            description: 'Optional. The upper bound of a time range. Must only be set when a specific timeframe or a time in the past is requested by the user. Must be an ISO 8601 timestamp greater than `start_time`. Default: `start_time` + 7 days.',
            type: 'string',
          },
          eventType: {
            description: 'Optional. The event types to return. If empty, only the following event types are returned: `DEFAULT`, `OUT_OF_OFFICE`, `FOCUS_TIME`, `FROM_GMAIL`',
            items: {
              enum: [
                'EVENT_TYPE_UNSPECIFIED',
                'DEFAULT',
                'OUT_OF_OFFICE',
                'FOCUS_TIME',
                'WORKING_LOCATION',
                'BIRTHDAY',
                'FROM_GMAIL',
              ],
              type: 'string',
              'x-google-enum-descriptions': [
                'Treated as `DEFAULT`.',
                'Regular event. Default value.',
                'Out-of-office event. Out-of-office events cannot be all-day.',
                'Focus-time event. Focus-time events cannot be all-day.',
                'Working location event.',
                'Special all-day event with an annual recurrence.',
                'Event from Gmail. This type of event cannot be created.',
              ],
            },
            type: 'array',
          },
          eventTypeFilter: {
            deprecated: true,
            description: 'Optional. Deprecated: use `event_type` instead.',
            items: {
              type: 'string',
            },
            type: 'array',
          },
          fullText: {
            description: 'Optional. Free-form case-insensitive search matching title, description, location, or attendees. Matches events containing all query terms verbatim (AND search).',
            type: 'string',
          },
          orderBy: {
            description: 'Optional. The order in which events should be returned. Possible values are: - `default` - Unspecified, but deterministic ordering (default). - `startTime` - Order by start time ascending. - `startTimeDesc` - Order by start time descending. - `lastModified` - Order by last modification time ascending. ',
            type: 'string',
          },
          pageSize: {
            description: 'Optional. Max events per page (default `100`, max `250`). Recommended: `10`.',
            format: 'int32',
            type: 'integer',
          },
          pageToken: {
            description: 'Optional. Next page token. Use the value from the previous page\'s `nextPageToken`.',
            type: 'string',
          },
          startTime: {
            description: 'Optional. The lower bound of a time range. Must only be set when a specific timeframe is requested by the user. Must be an ISO 8601 timestamp less than `end_time`. Default: now.',
            type: 'string',
          },
          timeZone: {
            description: 'Optional. Time zone (IANA ID, for example `Europe/Zurich`) used to resolve timezone-less dates. Default: calendar\'s timezone.',
            type: 'string',
          },
        },
        type: 'object',
      },
    ),
    readTool(
      'get_event',
      'Read one event by calendar ID and event ID.',
      {
        description: 'Request message for GetEvent.',
        properties: {
          calendarId: {
            description: 'Optional. ID of the calendar containing the event. Email address - can be resolved using `list_calendars`. Default: primary calendar.',
            type: 'string',
          },
          eventId: {
            description: 'Required. Event ID. Can be resolved using `list_events` or `search_events`.',
            type: 'string',
          },
        },
        required: [
          'eventId',
        ],
        type: 'object',
      },
    ),
    readTool(
      'list_calendars',
      'List calendars available to the connected Google account.',
      {
        description: 'Request message for ListCalendars.',
        properties: {
          pageSize: {
            description: 'Optional. Max results per page. Default `100`, max `250`.',
            format: 'int32',
            type: 'integer',
          },
          pageToken: {
            description: 'Optional. Token specifying which result page to return.',
            type: 'string',
          },
        },
        type: 'object',
      },
    ),
    readTool(
      'suggest_time',
      'Find times that work for the requested attendees and time window.',
      {
        $defs: {
          Preferences: {
            description: 'Preferences for suggested time slots.',
            properties: {
              endHour: {
                description: 'Preferred end hour as "HH:mm" (24-hour format).',
                type: 'string',
              },
              excludeWeekends: {
                description: 'Exclude weekends.',
                type: 'boolean',
              },
              pageSize: {
                description: 'Max number of slots to return. Default: `5`.',
                format: 'int32',
                type: 'integer',
              },
              startHour: {
                description: 'Preferred start hour as "HH:mm" (24-hour format).',
                type: 'string',
              },
            },
            type: 'object',
          },
        },
        description: 'Request message for SuggestTime.',
        properties: {
          attendeeEmails: {
            description: 'Required. Attendee emails to find free time for.',
            items: {
              type: 'string',
            },
            type: 'array',
          },
          durationMinutes: {
            description: 'Optional. Min duration of free slot in minutes. Default: `30`.',
            format: 'int32',
            type: 'integer',
          },
          endTime: {
            description: 'Required. Query interval end (ISO 8601).',
            type: 'string',
          },
          preferences: {
            $ref: '#/$defs/Preferences',
            description: 'Preferences to find suggested time.',
          },
          startTime: {
            description: 'Required. Query interval start (ISO 8601).',
            type: 'string',
          },
          timeZone: {
            description: 'Optional. Time zone for search times (IANA ID, for example `Europe/Zurich`). Default: the offset of `start_time`, if none then the user\'s primary time zone.',
            type: 'string',
          },
        },
        required: [
          'attendeeEmails',
          'startTime',
          'endTime',
        ],
        type: 'object',
      },
    ),
    readTool(
      'search_events',
      'Search events on the connected account’s primary calendar.',
      {
        description: 'Request message for SearchEvents.',
        properties: {
          pageSize: {
            description: 'Optional. Maximum number of entries returned on one result page.',
            format: 'int32',
            type: 'integer',
          },
          pageToken: {
            description: 'Optional. Token specifying which result page to return.',
            type: 'string',
          },
          query: {
            description: 'Required. Query string to search for events (case-insensitive).',
            type: 'string',
          },
        },
        required: [
          'query',
        ],
        type: 'object',
      },
    ),
  ],
};
