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
 * The two collisions that would otherwise be silent, checked at module load:
 *
 * - An entry `id` is a tool-name namespace, so `linear.x` must name one entry.
 *   An id carrying a dot would make two entries indistinguishable in the tool
 *   list, and a grant stores those names.
 * - Two entries may not pin the same namespaced name, because a grant's
 *   allowlist and the trail are matched on it.
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
