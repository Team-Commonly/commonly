#!/usr/bin/env node
/*
 * Fork the shared Guide identity into per-user identities.
 *
 * Every Guide installed before this migration used (guide, 'default') —
 * ONE identity for every user. Identity is the join key for everything
 * (ADR-003: one memory envelope per (agentName, instanceId)), so all users'
 * Guides shared a single memory doc: user A's "my repo is X" would surface
 * in user B's workspace. Same leak class as the 2026-07-03 BYO incident.
 * Measured before writing this script: zero bytes had ever been written to
 * the shared envelope, so this is prevention, not remediation.
 *
 * For each active AgentInstallation { agentName:'guide', instanceId:'default' }:
 *   1. owner = installation.installedBy, falling back to pod.createdBy
 *   2. newInstanceId = `u${owner}` (matches the signup path post-fix)
 *   3. ensure the per-user bot User exists (getOrCreateAgentUser)
 *   4. swap pod membership: remove the shared guide bot, add the per-user bot
 *   5. re-key the installation's instanceId in place
 *
 * The shared (guide, 'default') bot User row is NEVER deleted (ADR-001
 * identity continuity — its historical messages keep their author); it is
 * only removed from pod membership. If a shared memory envelope exists with
 * content (it should not), it is QUARANTINED by re-keying its instanceId to
 * 'default-quarantined' — never copied to any user, never deleted.
 *
 * Idempotent: a second run finds zero 'default' guide installs.
 *
 * Usage:
 *   ts-node backend/scripts/migrate-guide-per-user-identity.ts          # apply
 *   ts-node backend/scripts/migrate-guide-per-user-identity.ts --dry    # report
 */

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

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  await mongoose.connect(uri);

  const sharedInstalls = await AgentInstallation.find({
    agentName: 'guide',
    instanceId: 'default',
    status: 'active',
  });
  console.log(`[guide-fork] ${sharedInstalls.length} shared-identity guide install(s)`);

  const sharedBot = await AgentIdentityService.getOrCreateAgentUser('guide', {
    instanceId: 'default',
    displayName: 'Guide',
  });

  for (const install of sharedInstalls) {
    const pod = await Pod.findById(install.podId);
    const owner = install.installedBy?.toString() || pod?.createdBy?.toString();
    if (!owner) {
      console.warn(`[guide-fork] SKIP install ${install._id}: no owner resolvable`);
      continue;
    }
    const newInstanceId = `u${owner.toLowerCase()}`;
    console.log(`[guide-fork] pod=${install.podId} owner=${owner} → instanceId=${newInstanceId}${DRY ? ' (dry)' : ''}`);
    if (DRY) continue;

    const perUserBot = await AgentIdentityService.getOrCreateAgentUser('guide', {
      instanceId: newInstanceId,
      displayName: 'Guide',
    });

    if (pod && sharedBot?._id) {
      await Pod.updateOne({ _id: pod._id }, { $pull: { members: sharedBot._id } });
    }
    if (pod && perUserBot?._id) {
      await Pod.updateOne(
        { _id: pod._id, members: { $ne: perUserBot._id } },
        { $push: { members: perUserBot._id } },
      );
    }

    install.instanceId = newInstanceId;
    await install.save();
  }

  // Quarantine, never copy: a shared envelope's writes are unattributable
  // mixtures across users by construction.
  const sharedEnvelope = await AgentMemory.findOne({ agentName: 'guide', instanceId: 'default' });
  if (sharedEnvelope) {
    const size = String(sharedEnvelope.content || '').length;
    console.log(`[guide-fork] shared envelope exists (${size} chars) — quarantining${DRY ? ' (dry)' : ''}`);
    if (!DRY) {
      sharedEnvelope.instanceId = 'default-quarantined';
      await sharedEnvelope.save();
    }
  } else {
    console.log('[guide-fork] no shared envelope — nothing to quarantine');
  }

  await mongoose.disconnect();
  console.log('[guide-fork] done');
}

main().catch((err) => {
  console.error('[guide-fork] failed:', err);
  process.exit(1);
});
