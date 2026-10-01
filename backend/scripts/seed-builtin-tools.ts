// The first-party tool Installables are catalogue entries, not installs: the
// row is what the Tools page draws as the not-yet row and what the mint reads
// its broker and allow-list from. Re-seeded on every boot so `enabledTools`
// tracks the broker's definitions (tools plan §2).
//
// One row per VENDOR, and the hosted-MCP rows come from the catalogue entries
// themselves (scope §7): an entry is server-owned data that changes only by PR,
// so the row that offers it and the row that enables its tools are built from
// one source and cannot disagree.

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Installable = require('../models/Installable');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { builtinToolInstallables } = require('../services/installable/toolInstallables');

// The upsert is keyed on `{ installableId, source: 'builtin' }`, never on the
// id alone (Vera 67821): a row another source published under the same id is
// not ours to overwrite. `installableId` is unique, so the seed checks who
// holds the id first and stands down rather than trip the index.
export const seedBuiltinTools = async (): Promise<void> => {
  for (const installable of builtinToolInstallables()) {
    try {
      const holder = await Installable.findOne({ installableId: installable.installableId })
        .select('source').lean() as { source?: string } | null;
      if (holder && holder.source !== 'builtin') {
        const id = installable.installableId;
        console.warn(`[builtin-tools] installableId '${id}' is held by a '${holder.source}' row;`
          + ' the builtin seed leaves it alone');
        continue;
      }
      await Installable.findOneAndUpdate(
        { installableId: installable.installableId, source: 'builtin' },
        {
          $set: installable,
          $setOnInsert: { stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 } },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      const { enabledTools } = installable.components[0];
      console.log(`[builtin-tools] ${installable.name} tool Installable ready (${enabledTools.length} tools)`);
    } catch (error) {
      // One vendor's row failing must not stop the others: the loop is over
      // rows that share a schema but not a vendor, and the previous shape (one
      // row, one try) could not tell that apart.
      console.error(`[builtin-tools] seed failed for '${installable.installableId}':`, (error as Error).message);
    }
  }
};

module.exports = { seedBuiltinTools };
