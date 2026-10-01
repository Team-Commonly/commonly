#!/usr/bin/env node
/* eslint-disable no-console */
import mongoose from 'mongoose';
import Integration from '../models/Integration';
import { HOSTED_MCP_ENTRIES } from '../integrations/hostedMcp/entries';
import { resolvedClientId } from '../services/hostedMcpIntakeService';
import {
  backfillHostedMcpClientIds,
  type HostedMcpClientIdBackfillRow,
} from '../services/hostedMcpClientIdBackfill';

const APPLY = process.argv.includes('--apply');
const HOSTED_MCP_TYPE = 'hosted-mcp';
// This one-time backfill knows only the CIMD client that existed before the
// snapshot field shipped. A later catalogue entry needs its own migration
// ruling; its current client cannot safely be assumed to have minted old rows.
const LEGACY_ENTRY_IDS = new Set(['linear']);

const main = async (): Promise<void> => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');

  await mongoose.connect(uri);
  try {
    // A new OAuth client id is written at callback. This query is only the
    // historical half: rows still carrying material but no snapshot. Pending
    // rows without a credential are not pairs and are left for their callback.
    const rows = await Integration.find({
      type: HOSTED_MCP_TYPE,
      'config.clientId': { $in: [null, ''] },
      $or: [
        { 'config.credentialRef': { $exists: true, $nin: [null, ''] } },
        { 'config.refreshTokenRef': { $exists: true, $nin: [null, ''] } },
      ],
    })
      .select('_id config.entryId config.clientId config.credentialRef config.refreshTokenRef')
      .lean();

    const entries = new Map(HOSTED_MCP_ENTRIES.map((entry) => [entry.id, entry]));
    const result = await backfillHostedMcpClientIds({
      findLegacyRows: async () => rows as unknown as HostedMcpClientIdBackfillRow[],
      entryFor: (entryId) => (LEGACY_ENTRY_IDS.has(entryId) ? entries.get(entryId) : undefined),
      clientIdFor: resolvedClientId,
      updateIfMissing: async (row, clientId) => {
        const write = await Integration.updateOne(
          {
            _id: row._id,
            type: HOSTED_MCP_TYPE,
            'config.entryId': row.config?.entryId,
            'config.clientId': { $in: [null, ''] },
          },
          { $set: { 'config.clientId': clientId } },
        );
        return write.modifiedCount ?? 0;
      },
    }, APPLY);

    console.log(`legacy token-bearing rows scanned: ${result.scanned}`);
    console.log(`client ids to backfill:           ${result.candidates}`);
    if (APPLY) {
      console.log(`client ids backfilled:            ${result.updated}`);
    } else {
      console.log('DRY RUN — pass --apply to write.');
    }
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
