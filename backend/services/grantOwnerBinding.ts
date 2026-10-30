import { Types } from 'mongoose';
import RoomGrant from '../models/RoomGrant';
import Integration from '../models/Integration';

/**
 * Binds a room grant to the connection row it was minted against, and to that
 * row's owner at mint. A grant's `connectionId` may be a row `_id` or an
 * installation id. An installation id is reusable: once its row is removed, a
 * new row can carry the same id under another owner. Reading the owner from
 * whoever holds the id now would hand the old grant to the new holder.
 *
 * So the binding is taken from the rows as they stood at mint, and a grant
 * whose binding cannot be proven is left unbound. Revoke and seat-grant read
 * refuse unbound grants.
 */
export interface GrantBindingGrant {
  connectionId: string;
  createdAt: Date | string;
}

export interface GrantBindingRow {
  _id: unknown;
  installationId?: string | null;
  config?: { installationId?: string | null; linkedUserId?: unknown } | null;
  createdBy?: unknown;
  createdAt: Date | string;
}

export interface GrantBinding {
  connectionRowId: string;
  ownerId: string;
}

export const connectionOwnerOf = (row: GrantBindingRow | null | undefined): string => String(
  row?.createdBy || row?.config?.linkedUserId || '',
);

const carriesInstallationId = (row: GrantBindingRow, installationId: string): boolean => (
  String(row.installationId || '') === installationId
  || String(row.config?.installationId || '') === installationId
);

/**
 * Pure: the binding for `grant` given every row that could be its connection.
 * `rows` must include all rows matching the grant's `connectionId` as a row
 * `_id` or as an installation id; rows that match neither are ignored.
 */
export const resolveGrantBinding = (
  grant: GrantBindingGrant,
  rows: GrantBindingRow[],
): GrantBinding | null => {
  const connectionId = String(grant.connectionId || '');
  // A row `_id` is never reused, so a grant that names one binds to that row.
  const byRowId = rows.find((row) => String(row._id) === connectionId);
  if (byRowId) {
    const ownerId = connectionOwnerOf(byRowId);
    return ownerId ? { connectionRowId: String(byRowId._id), ownerId } : null;
  }

  // An installation id binds only when exactly one row carries it and that row
  // existed when the grant was minted. Two rows is ambiguous; a row created
  // after the mint is a later holder, not the one the grant was given to.
  const matches = rows.filter((row) => carriesInstallationId(row, connectionId));
  if (matches.length !== 1) return null;
  const [row] = matches;
  if (new Date(row.createdAt).getTime() > new Date(grant.createdAt).getTime()) return null;
  const ownerId = connectionOwnerOf(row);
  return ownerId ? { connectionRowId: String(row._id), ownerId } : null;
};

export interface GrantOwnerBackfillResult {
  scanned: number;
  bound: number;
  unbound: number;
}

/**
 * Binds every grant still missing an owner. Idempotent: a bound grant is never
 * matched again, and the conditional update never overwrites a binding that
 * landed between the read and the write.
 */
export const backfillGrantOwners = async (): Promise<GrantOwnerBackfillResult> => {
  const grants = await RoomGrant.find({ ownerId: null })
    .select('grantId connectionId createdAt')
    .lean();
  const result: GrantOwnerBackfillResult = { scanned: grants.length, bound: 0, unbound: 0 };

  for (const grant of grants) {
    const connectionId = String(grant.connectionId || '');
    const or: Record<string, unknown>[] = [
      { installationId: connectionId },
      { 'config.installationId': connectionId },
    ];
    if (Types.ObjectId.isValid(connectionId)) or.push({ _id: new Types.ObjectId(connectionId) });
    const rows = await Integration.find({ $or: or })
      .select('_id installationId config.installationId config.linkedUserId createdBy createdAt')
      .lean();

    const binding = resolveGrantBinding(grant as unknown as GrantBindingGrant, rows as unknown as GrantBindingRow[]);
    if (!binding) {
      result.unbound += 1;
      continue;
    }
    await RoomGrant.updateOne(
      { grantId: grant.grantId, ownerId: null },
      { $set: { connectionRowId: binding.connectionRowId, ownerId: binding.ownerId } },
    );
    result.bound += 1;
  }
  return result;
};
