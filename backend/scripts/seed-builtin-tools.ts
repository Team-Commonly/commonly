// The first-party tool Installables are catalogue entries, not installs: the
// row is what the Tools page draws as the not-yet row and what the mint reads
// its broker and allow-list from. Re-seeded on every boot so `enabledTools`
// tracks the broker's definitions (tools plan §2).

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Installable = require('../models/Installable');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { buildGithubToolInstallable } = require('../services/installable/toolInstallables');

export const seedBuiltinTools = async (): Promise<void> => {
  try {
    const github = buildGithubToolInstallable();
    await Installable.findOneAndUpdate(
      { installableId: github.installableId },
      {
        $set: github,
        $setOnInsert: { stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 } },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log(`[builtin-tools] GitHub tool Installable ready (${github.components[0].enabledTools.length} tools)`);
  } catch (error) {
    console.error('[builtin-tools] seed failed:', (error as Error).message);
  }
};

module.exports = { seedBuiltinTools };
