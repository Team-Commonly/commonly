#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * The DCR client each hosted-MCP entry gives new starts, and an admin's hand
 * to retire one (F14). A client the vendor deleted fails on the vendor's own
 * authorize page, which never reaches this instance. A member's retry finds it
 * on its own (hostedMcpDcrRegistry.retireDcrClientIfUnknown). This is for an
 * admin who knows sooner, or a vendor whose token endpoint doesn't answer
 * invalid_client.
 *
 *   (no flags)        list each entry's current client and the rows it minted
 *   --ask             also ask each vendor whether it still knows its client
 *   --retire <entry>  retire that entry's current client
 *   --ask --apply     retire every client its vendor says it no longer knows
 *
 * Nothing is written without --apply. A retired client's rows keep using it.
 */
import mongoose from 'mongoose';
import Integration from '../models/Integration';
import HostedMcpDcrRegistration from '../models/HostedMcpDcrRegistration';
import { HOSTED_MCP_ENTRIES } from '../integrations/hostedMcp/entries';
import { isOAuthEntry } from '../services/hostedMcpEntryService';
import { discoverAuthorizationServer } from '../services/hostedMcpIntakeService';
import {
  askVendorAboutDcrClient, dcrClientForRow, retireCurrentDcrClient, type DcrClientAnswer,
} from '../services/hostedMcpDcrRegistry';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ASK = args.includes('--ask');
const retireFlag = args.indexOf('--retire');
const RETIRE = retireFlag >= 0 ? args[retireFlag + 1] : undefined;

const short = (clientId: string): string => `${clientId.slice(0, 8)}…`;

const main = async (): Promise<void> => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  if (retireFlag >= 0 && (!RETIRE || RETIRE.startsWith('--'))) throw new Error('--retire needs an entry id');
  const entries = new Map(HOSTED_MCP_ENTRIES
    .filter(isOAuthEntry)
    .filter((entry) => entry.client === 'dcr')
    .map((entry) => [entry.id, entry]));
  if (RETIRE && !entries.has(RETIRE)) throw new Error(`${RETIRE} is not a DCR entry in this catalogue`);

  await mongoose.connect(uri);
  try {
    const current = await HostedMcpDcrRegistration.find({ current: true }).sort({ entryId: 1 }).lean();
    for (const registration of current) {
      const entry = entries.get(registration.entryId);
      if (!entry || entry.issuer !== registration.issuer) {
        console.log(`${registration.entryId}: not a DCR entry at this issuer in the catalogue; left alone`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const rows = await Integration.countDocuments({
        type: 'hosted-mcp', 'config.entryId': entry.id, 'config.clientId': registration.clientId,
      });
      let answer: DcrClientAnswer | undefined;
      if (ASK) {
        // eslint-disable-next-line no-await-in-loop
        const client = await dcrClientForRow(entry, registration.clientId);
        try {
          // eslint-disable-next-line no-await-in-loop
          const metadata = client ? await discoverAuthorizationServer(entry.issuer) : null;
          answer = client && metadata
            // eslint-disable-next-line no-await-in-loop
            ? await askVendorAboutDcrClient(entry, metadata, client, registration.redirectUri)
            : 'unclear';
        } catch {
          answer = 'unclear';
        }
      }
      const since = new Date(registration.createdAt).toISOString();
      console.log(`${entry.id}: client ${short(registration.clientId)} since ${since}, `
        + `${rows} row(s)${answer ? `, vendor: ${answer}` : ''}`);
      const retire = RETIRE ? RETIRE === entry.id : answer === 'unknown_client';
      if (!retire) continue;
      if (!APPLY) {
        console.log('  would retire it');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const retired = await retireCurrentDcrClient(entry, registration.clientId);
      console.log(retired ? '  retired; the next start registers a new client' : '  no longer current; left alone');
    }
    if (RETIRE && !current.some((registration) => registration.entryId === RETIRE)) {
      console.log(`${RETIRE}: no current client; the next start registers one`);
    }
    if (!APPLY) console.log('DRY RUN — pass --apply to write.');
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
