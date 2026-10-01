import type { HostedMcpEntry } from './hostedMcpEntryService';

export interface HostedMcpClientIdBackfillRow {
  _id: unknown;
  config?: {
    entryId?: string;
    clientId?: string | null;
    credentialRef?: string | null;
    refreshTokenRef?: string | null;
  };
}

export interface HostedMcpClientIdBackfillDeps {
  findLegacyRows: () => Promise<HostedMcpClientIdBackfillRow[]>;
  entryFor: (entryId: string) => HostedMcpEntry | undefined;
  clientIdFor: (entry: HostedMcpEntry) => string;
  /** Must update only while `config.clientId` is still absent or blank. */
  updateIfMissing: (row: HostedMcpClientIdBackfillRow, clientId: string) => Promise<number>;
}

export interface HostedMcpClientIdBackfillResult {
  scanned: number;
  candidates: number;
  updated: number;
}

/**
 * Backfill the client identity on legacy rows that still hold a token pair.
 * Resolve and validate every candidate before writing any of them, so an
 * unknown entry or missing instance credential cannot leave a half-migrated
 * set. The conditional writer makes the operation safe against a callback
 * completing while this scan is in flight.
 */
export const backfillHostedMcpClientIds = async (
  deps: HostedMcpClientIdBackfillDeps,
  apply = false,
): Promise<HostedMcpClientIdBackfillResult> => {
  const rows = await deps.findLegacyRows();
  const candidates = rows.flatMap((row) => {
    const config = row.config || {};
    if (config.clientId || (!config.credentialRef && !config.refreshTokenRef)) return [];
    const entryId = String(config.entryId || '');
    const entry = deps.entryFor(entryId);
    if (!entry) throw new Error(`hosted-mcp row ${String(row._id)} names unknown entry ${entryId}`);
    const clientId = deps.clientIdFor(entry);
    if (!clientId) throw new Error(`hosted-mcp row ${String(row._id)} resolved an empty client id`);
    return [{ row, clientId }];
  });

  let updated = 0;
  if (apply) {
    for (const { row, clientId } of candidates) {
      // Sequential by design: a migration is a bounded one-time write, and
      // knowing the exact modified count is more useful than parallel speed.
      // eslint-disable-next-line no-await-in-loop
      updated += await deps.updateIfMissing(row, clientId);
    }
  }

  return { scanned: rows.length, candidates: candidates.length, updated };
};
