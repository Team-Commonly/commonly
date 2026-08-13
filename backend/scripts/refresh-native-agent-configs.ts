#!/usr/bin/env node
/*
 * Re-project native-agent manifests onto their existing installations.
 *
 * ADR-001: one manifest, N runtime projections, and UPDATES PROPAGATE. The
 * signup path stamps buildInstallationConfig(manifest) at install time, so a
 * manifest change (new tool grant, prompt change, cap change) reaches new
 * users only — every existing install keeps the config frozen at its signup
 * moment. This script closes that gap: for each first-party native agent, it
 * rewrites config on all active installations from the CURRENT manifest.
 *
 * Deliberately config-only: never touches identity (agentName/instanceId/
 * User rows), membership, memory, or status — a manifest refresh must never
 * be able to become an identity migration by accident.
 *
 * Idempotent. `--dry` prints the plan.
 *
 * Usage:
 *   ts-node backend/scripts/refresh-native-agent-configs.ts          # apply
 *   ts-node backend/scripts/refresh-native-agent-configs.ts --dry    # report
 */

import mongoose from 'mongoose';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildInstallationConfig } = require('./seed-native-agents');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FIRST_PARTY_APPS } = require('../config/native-agents/apps');

const DRY = process.argv.includes('--dry');

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  await mongoose.connect(uri);

  for (const app of FIRST_PARTY_APPS) {
    const installs = await AgentInstallation.find({
      agentName: app.agentName,
      status: 'active',
    });
    console.log(`[config-refresh] ${app.agentName}: ${installs.length} active install(s)`);
    if (DRY) continue;
    const config = buildInstallationConfig(app);
    for (const install of installs) {
      install.config = config;
      // eslint-disable-next-line no-await-in-loop
      await install.save();
    }
    console.log(`[config-refresh] ${app.agentName}: refreshed`);
  }

  await mongoose.disconnect();
  console.log('[config-refresh] done');
}

main().catch((err) => {
  console.error('[config-refresh] failed:', err);
  process.exit(1);
});
