#!/usr/bin/env node
/*
 * Normalize Guide identities to the per-user-agent convention:
 * instanceId = `u` + sha256(userId).slice(0, 10).
 *
 * Two legacy forms exist:
 *   1. long form `u<24-hex-userId>` — the first per-user fork (#923) embedded
 *      the raw ObjectId into every identity tier (instanceId, username,
 *      collision-suffixed displayName). Sam rejected it as a convention the
 *      night it shipped; fleet review had independently measured the leak.
 *   2. shared 'default' — pre-#923 installs, if any remain.
 *
 * For each active guide install in either form:
 *   owner = installedBy (fallback pod.createdBy) → newInstanceId per the
 *   convention → ensure the per-user bot User → swap pod membership from the
 *   old bot user to the new → re-key the installation → MOVE the old
 *   identity's memory envelope to the new key (same owner, same single-user
 *   provenance — this is a rename, not the mixed-user quarantine case; a
 *   'default' envelope, unattributable by construction, is still quarantined
 *   never moved).
 *
 * Old bot User rows are never deleted (ADR-001); they leave pod membership
 * only. Idempotent: convention-form installs are skipped.
 *
 * Usage:
 *   ts-node backend/scripts/migrate-guide-identity-convention.ts          # apply
 *   ts-node backend/scripts/migrate-guide-identity-convention.ts --dry    # report
 */

import { createHash } from 'crypto';
import mongoose from 'mongoose';
import Pod from '../models/Pod';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentMemory = require('../models/AgentMemory');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('../services/agentIdentityService').default
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  || require('../services/agentIdentityService');

const DRY = process.argv.includes('--dry');

export const conventionInstanceId = (userId: string): string =>
  `u${createHash('sha256').update(String(userId)).digest('hex').slice(0, 10)}`;

const isConventionForm = (instanceId: string): boolean => /^u[a-f0-9]{10}$/.test(instanceId);
const isLongForm = (instanceId: string): boolean => /^u[a-f0-9]{24}$/.test(instanceId);

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  await mongoose.connect(uri);

  const installs = await AgentInstallation.find({ agentName: 'guide', status: 'active' });
  console.log(`[guide-convention] ${installs.length} active guide install(s)`);

  for (const install of installs) {
    const oldInstanceId = String(install.instanceId || 'default');
    if (isConventionForm(oldInstanceId)) {
      console.log(`[guide-convention] pod=${install.podId} already convention (${oldInstanceId}) — skip`);
      continue;
    }
    if (!isLongForm(oldInstanceId) && oldInstanceId !== 'default') {
      console.warn(`[guide-convention] pod=${install.podId} unrecognized instanceId '${oldInstanceId}' — SKIPPING, inspect manually`);
      continue;
    }

    const pod = await Pod.findById(install.podId);
    const owner = install.installedBy?.toString() || pod?.createdBy?.toString();
    if (!owner) {
      console.warn(`[guide-convention] SKIP install ${install._id}: no owner resolvable`);
      continue;
    }
    const newInstanceId = conventionInstanceId(owner);
    console.log(`[guide-convention] pod=${install.podId} ${oldInstanceId} → ${newInstanceId}${DRY ? ' (dry)' : ''}`);
    if (DRY) continue;

    const oldBot = await AgentIdentityService.getOrCreateAgentUser('guide', {
      instanceId: oldInstanceId,
      displayName: 'Guide',
    });
    const newBot = await AgentIdentityService.getOrCreateAgentUser('guide', {
      instanceId: newInstanceId,
      displayName: 'Guide',
    });

    if (pod && oldBot?._id) {
      await Pod.updateOne({ _id: pod._id }, { $pull: { members: oldBot._id } });
    }
    if (pod && newBot?._id) {
      await Pod.updateOne(
        { _id: pod._id, members: { $ne: newBot._id } },
        { $push: { members: newBot._id } },
      );
    }

    // Memory: a long-form envelope is single-owner by construction — rename
    // it to the new key. A 'default' envelope is a mixed-user artifact —
    // quarantine, never move (same rule as the fork migration).
    if (isLongForm(oldInstanceId)) {
      const envelope = await AgentMemory.findOne({ agentName: 'guide', instanceId: oldInstanceId });
      if (envelope) {
        envelope.instanceId = newInstanceId;
        await envelope.save();
        console.log(`[guide-convention]   memory envelope moved → ${newInstanceId}`);
      }
    } else {
      const shared = await AgentMemory.findOne({ agentName: 'guide', instanceId: 'default' });
      if (shared) {
        shared.instanceId = 'default-quarantined';
        await shared.save();
        console.log('[guide-convention]   shared envelope quarantined');
      }
    }

    install.instanceId = newInstanceId;
    await install.save();
  }

  await mongoose.disconnect();
  console.log('[guide-convention] done');
}

main().catch((err) => {
  console.error('[guide-convention] failed:', err);
  process.exit(1);
});
