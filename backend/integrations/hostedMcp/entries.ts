/**
 * The hosted-MCP catalogue (TASK-172, scope §3). One module per vendor lives
 * beside this file and is listed here; an entry is server-owned data that
 * changes only by PR.
 *
 * Linear is the first entry (build-order step 7), pinned from a real
 * `tools/list` taken on a consenting account. Google Calendar is the next
 * entry: its official MCP and OAuth docs were checked, and its five read tools
 * are pinned from an unauthenticated capture with the first authenticated list
 * reserved as the drift check. Other candidates list only once their own docs
 * verify the URL, transport, auth mode, token lifetime, refresh and revocation,
 * and their pinned read tools claim `readOnlyHint: true` (§3, §11).
 */
import type { HostedMcpEntry } from '../../services/hostedMcpEntryService';
import { AIRTABLE_ENTRY } from './airtable';
import { ATLASSIAN_ENTRY } from './atlassian';
import { GOOGLE_CALENDAR_ENTRY } from './googleCalendar';
import { GITHUB_MCP_ENTRY } from './githubMcp';
import { GITLAB_ENTRY } from './gitlab';
import { LINEAR_ENTRY } from './linear';
import { NOTION_ENTRY } from './notion';
import { SENTRY_ENTRY } from './sentry';
import { SUPABASE_ENTRY } from './supabase';

export const HOSTED_MCP_ENTRIES: HostedMcpEntry[] = [
  LINEAR_ENTRY, GOOGLE_CALENDAR_ENTRY, ATLASSIAN_ENTRY, AIRTABLE_ENTRY, SENTRY_ENTRY,
  NOTION_ENTRY,
  GITLAB_ENTRY,
  SUPABASE_ENTRY,
  GITHUB_MCP_ENTRY,
];

/**
 * Seven entry-local defects that would otherwise be silent, checked at module
 * load. The collision with builtin tool Installable ids is checked by
 * `toolInstallables.ts` at the load site that owns both maps.
 *
 * - An entry `id` is a tool-name namespace, so `linear.x` must name one entry.
 *   An id carrying a dot would make two entries indistinguishable in the tool
 *   list, and a grant stores those names.
 * - Two entries may not pin the same namespaced name, because a grant's
 *   allowlist and the trail are matched on it.
 * - A tool name carrying the `.` the namespace is built from would make
 *   `linear.a.b` name two things, and the segment is what a seat reads, so the
 *   charset is checked rather than the assembled name. `_` is in it because
 *   every name this broker already offers carries one (`github.list_issues`,
 *   `github.list_pull_request_files`, and the other six in
 *   `toolBrokerService.getToolDefinitions`), so the character to exclude is the
 *   separator, not the one 8 of 8 shipped names are spelled with.
 * - A pin whose class is `read` while its own annotations say `destructiveHint:
 *   true` or `readOnlyHint: false` is a contradiction with a reader: the class
 *   is what `writeModeFor` turns into `read`, so the call runs unparked, and it
 *   is what the drift comparison reads, so `movedTowardWrite` can no longer
 *   report the vendor moving — the pin has already recorded the move §3 says
 *   has to be a PR. Both directions are refused separately, so the refusal a
 *   reviewer reads names the annotation it found.
 * - A read pin has to CLAIM read-only, not merely avoid denying it. The first
 *   direction of `movedTowardWrite` is keyed on the pin's own claim
 *   (`pinned.readOnlyHint === true`), so a read pin carrying no annotation can
 *   never be told the vendor withdrew the claim: `assessEntryTools` answers
 *   `ok` while the vendor says `readOnlyHint: false`, and a read grant stands
 *   against an explicit upstream denial. Requiring the claim keeps that
 *   direction live for every read pin in the catalogue.
 * - A separate OAuth audience must cover the tools/call endpoint on the same
 *   origin and a path-segment boundary. Otherwise we present a bearer token to
 *   an endpoint outside the resource for which the vendor minted it.
 * - `revoke` has to name its KIND and be an absolute https URL. The kind is
 *   what decides whether removal calls the vendor: a `page` is for a person to
 *   visit, and a page that answered our POST with 200 would read as a revoke
 *   that never happened — a 200 proves no more at a real endpoint either, since
 *   RFC 7009 §2.2 answers it for an invalid token too. This is the one
 *   entry-time refusal whose absence is not a refusal at call time but a
 *   permanent one: a relative, cleartext or kind-less `revoke` fails inside
 *   `upstreamFetch` or is skipped, so every removal of that entry's rows
 *   answers `provider_revoke_failed`, and each one leaves a person holding an
 *   authorization at the vendor that nobody can revoke.
 *
 * The consequence, stated because it is a cost and not an oversight: a read pin
 * now needs its vendor to keep saying `readOnlyHint: true`, since a vendor that
 * says nothing is read as a withdrawal of the claim. A tool whose vendor
 * annotates nothing gets no entry at all, not a write-only one: the class
 * records what a tool does, so a read tool is never pinned `write` to get past
 * a missing hint (75440, §3).
 */
/**
 * The ONE place that reads the shape of `revoke` (§3), so that the load-time
 * refusal and the removal sequence cannot disagree about what an entry says.
 * `removeConnection` acts on `endpoint`'s presence and never parses a URL.
 *
 * A `page` is always there — where a person revokes by hand, and where a
 * removal that cannot revoke at the vendor sends them (§3) — and an `endpoint`
 * is there only when the AS's metadata advertises an RFC 7009 revocation
 * endpoint. Presence is the whole decision, so no URL is ever read to infer a
 * kind, and both URLs are checked because both are handed to a person.
 */
export interface HostedMcpRevokeTarget {
  page: string;
  endpoint?: string;
}

/** Why this entry's `revoke` is unusable, or null. */
export const hostedMcpRevokeRefusal = (entry: HostedMcpEntry): string | null => {
  const revoke = (entry as { revoke?: unknown })?.revoke;
  if (!revoke || typeof revoke !== 'object' || Array.isArray(revoke)) {
    return 'names no page (every entry names one, and an `endpoint` only when the AS advertises one)';
  }
  const named = revoke as Record<string, unknown>;
  const extra = Object.keys(named).find((key) => key !== 'page' && key !== 'endpoint');
  if (extra) return `names a key that is neither \`page\` nor \`endpoint\` (${extra})`;
  if (typeof named.page !== 'string') {
    return 'names no page (every entry names one, and an `endpoint` only when the AS advertises one)';
  }
  // Every URL present, not just the first: both are handed to a person, and a
  // two-key entry used to be refused outright, so this loop could not run.
  for (const key of Object.keys(named)) {
    const url = named[key];
    if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) {
      return `is not an absolute https URL (${key})`;
    }
  }
  return null;
};

/** The resolved target, or null when the entry is not loadable. */
export const hostedMcpRevokeTarget = (entry: HostedMcpEntry): HostedMcpRevokeTarget | null => {
  if (hostedMcpRevokeRefusal(entry)) return null;
  const named = (entry as { revoke: HostedMcpRevokeTarget }).revoke;
  return { page: named.page, ...(named.endpoint ? { endpoint: named.endpoint } : {}) };
};

const ALLOWED_AUTHORIZATION_PARAMS = new Set(['access_type', 'prompt']);

export const assertHostedMcpEntries = (
  entries: HostedMcpEntry[],
  reservedIds: ReadonlySet<string> = new Set(),
): void => {
  const seenEntries = new Set<string>();
  const seenTools = new Set<string>();
  for (const entry of entries) {
    if (!/^[a-z0-9-]+$/.test(entry.id)) {
      throw new Error(`hosted-mcp entry id is not a usable tool namespace: ${entry.id}`);
    }
    if (entry.audience !== undefined) {
      let audience: URL;
      let endpoint: URL;
      try {
        if (typeof entry.audience !== 'string') throw new Error('invalid audience');
        audience = new URL(entry.audience);
        endpoint = new URL(entry.resource);
      } catch {
        throw new Error(`hosted-mcp entry audience is not an absolute https URL: ${entry.id}`);
      }
      if (audience.protocol !== 'https:' || endpoint.protocol !== 'https:'
        || audience.username || audience.password || audience.search || audience.hash) {
        throw new Error(`hosted-mcp entry audience is not an absolute https resource URL: ${entry.id}`);
      }
      // This is a token-delivery boundary: the bearer minted for `audience`
      // reaches `resource` only when the endpoint is within that resource's
      // origin and path, with the path ending on a segment boundary.
      const audiencePath = audience.pathname;
      const coversPath = audiencePath === '/'
        || endpoint.pathname === audiencePath
        || endpoint.pathname.startsWith(
          audiencePath.endsWith('/') ? audiencePath : `${audiencePath}/`,
        );
      if (audience.origin !== endpoint.origin || !coversPath) {
        throw new Error(`hosted-mcp entry audience does not cover its endpoint: ${entry.id}`);
      }
    }
    if (reservedIds.has(entry.id)) {
      throw new Error(`hosted-mcp entry id collides with a builtin tool installable: ${entry.id}`);
    }
    if (entry.authorizationParams !== undefined) {
      if (!entry.authorizationParams || typeof entry.authorizationParams !== 'object'
        || Array.isArray(entry.authorizationParams)) {
        throw new Error(`hosted-mcp entry authorization parameters are not an object: ${entry.id}`);
      }
      const invalidParam = Object.entries(entry.authorizationParams).find(([key, value]) => (
        !ALLOWED_AUTHORIZATION_PARAMS.has(key) || typeof value !== 'string' || value.length === 0
      ));
      if (invalidParam) {
        throw new Error(
          `hosted-mcp entry authorization parameter outside the closed set: ${entry.id}.${invalidParam[0]}`,
        );
      }
    }
    // What removal will do with this entry
    // (services/connectionRemovalService.ts). A `revoke` that names no kind,
    // both, or a URL that is not https is not a refusal at call time — the
    // removal would either POST to a page that answers 200 for a token it never
    // saw, or fail inside `upstreamFetch` — and every removal of that entry's
    // rows would end in a person holding an authorization nobody can revoke.
    // Refusing the entry at module load is the only place this can be caught
    // before that happens.
    if (entry.accessPage !== undefined
      && (typeof entry.accessPage !== 'string' || !/^https:\/\/[^\s]+$/.test(entry.accessPage))) {
      throw new Error(`hosted-mcp entry access page is not an absolute https URL: ${entry.id}`);
    }
    const revokeRefusal = hostedMcpRevokeRefusal(entry);
    if (revokeRefusal) {
      throw new Error(`hosted-mcp entry revoke ${revokeRefusal}: ${entry.id}`);
    }
    if (seenEntries.has(entry.id)) throw new Error(`duplicate hosted-mcp entry id: ${entry.id}`);
    seenEntries.add(entry.id);
    for (const tool of entry.tools) {
      const name = `${entry.id}.${tool.name}`;
      if (!/^[a-z0-9_-]+$/.test(tool.name)) {
        throw new Error(`hosted-mcp tool name is not a usable namespace segment: ${name}`);
      }
      if (tool.class === 'read' && tool.annotations?.destructiveHint === true) {
        throw new Error(`hosted-mcp read tool is pinned against its own destructiveHint: ${name}`);
      }
      if (tool.class === 'read' && tool.annotations?.readOnlyHint === false) {
        throw new Error(`hosted-mcp read tool is pinned against its own readOnlyHint: ${name}`);
      }
      if (tool.class === 'read' && tool.annotations?.readOnlyHint !== true) {
        throw new Error(`hosted-mcp read tool does not claim readOnlyHint: ${name}`);
      }
      if (seenTools.has(name)) throw new Error(`duplicate hosted-mcp tool name: ${name}`);
      seenTools.add(name);
    }
  }
};

assertHostedMcpEntries(HOSTED_MCP_ENTRIES);

/** Pure so a caller's lookup is testable against a fixture catalogue. */
export const findHostedMcpEntry = (
  entries: HostedMcpEntry[],
  entryId: string,
): HostedMcpEntry | undefined => entries.find((entry) => entry.id === entryId);
