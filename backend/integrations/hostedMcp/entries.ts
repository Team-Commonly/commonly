/**
 * The hosted-MCP catalogue (TASK-172, scope §3). One module per vendor lives
 * beside this file and is listed here; an entry is server-owned data that
 * changes only by PR.
 *
 * v1 lists no vendor: the Linear entry is build-order step 7, pinned from a
 * real `tools/list` taken on a consenting account, and every other candidate
 * lists only once its own docs verify the URL, transport, auth mode, token
 * lifetime, refresh and revocation. The lookup and the invariant check ship
 * first so a vendor module cannot land half-wired.
 */
import type { HostedMcpEntry } from '../../services/hostedMcpEntryService';

export const HOSTED_MCP_ENTRIES: HostedMcpEntry[] = [];

/**
 * Five defects that would otherwise be silent, checked at module load:
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
 *
 * The consequence, stated because it is a cost and not an oversight: a read pin
 * now needs its vendor to keep saying `readOnlyHint: true`, since a vendor that
 * says nothing is read as a withdrawal of the claim. A tool whose vendor
 * annotates nothing gets no entry at all, not a write-only one: the class
 * records what a tool does, so a read tool is never pinned `write` to get past
 * a missing hint (75440, §3).
 */
export const assertHostedMcpEntries = (entries: HostedMcpEntry[]): void => {
  const seenEntries = new Set<string>();
  const seenTools = new Set<string>();
  for (const entry of entries) {
    if (!/^[a-z0-9-]+$/.test(entry.id)) {
      throw new Error(`hosted-mcp entry id is not a usable tool namespace: ${entry.id}`);
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
