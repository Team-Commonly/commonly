#!/usr/bin/env node
/*
 * Grant the GitHub issue-write capability to the established configured
 * OpenClaw dev seats that predate TASK-023's default-off field.
 *
 * GitHub issue writes spend Commonly's server credential. The capability is
 * therefore derived only from server-owned runtime/configuration state; it
 * must never be inferred from installation.config or an agent request.
 *
 * This is deliberately a one-shot migration rather than runtime middleware:
 * request authentication must stay read-only apart from token/last-active
 * bookkeeping, otherwise every shared agent route inherits an unbounded
 * database-write flow. New installations receive the same grant in
 * routes/registry/install.ts.
 *
 * Only rows where githubIssueWrite is ABSENT are eligible. That makes the
 * migration idempotent and, crucially, preserves a later explicit false
 * value as a revocation rather than turning a rerun into a re-grant.
 *
 * Run:
 *   MONGO_URI=... node --import tsx backend/scripts/migrate-github-issue-write-capability.ts --dry
 *   MONGO_URI=... node --import tsx backend/scripts/migrate-github-issue-write-capability.ts
 */

import mongoose from 'mongoose';
import { AgentInstallation } from '../models/AgentRegistry';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isConfiguredDevTierGitHubIssueWriter } = require('../services/githubIssueWriteCapability') as typeof import('../services/githubIssueWriteCapability');

interface InstallationIdentity {
  agentName: string;
  instanceId: string;
  installationCount: number;
}

export interface MigrationResult {
  legacyInstallations: number;
  identitiesChecked: number;
  identitiesGranted: number;
  installationsGranted: number;
  skippedMalformed: number;
  dryRun: boolean;
}

const normalizeIdentityPart = (value: unknown): string => String(value || '').trim().toLowerCase();

/**
 * Backfill only database rows created before githubIssueWrite existed. The
 * server-owned resolver fails closed on a missing/invalid runtime config.
 */
export async function migrateGitHubIssueWriteCapability(
  options: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const dryRun = options.dryRun === true;
  const result: MigrationResult = {
    legacyInstallations: 0,
    identitiesChecked: 0,
    identitiesGranted: 0,
    installationsGranted: 0,
    skippedMalformed: 0,
    dryRun,
  };

  const legacyInstallations = await AgentInstallation.find({
    status: 'active',
    githubIssueWrite: { $exists: false },
  }).select('agentName instanceId').lean() as Array<{ agentName?: unknown; instanceId?: unknown }>;

  result.legacyInstallations = legacyInstallations.length;
  const identities = new Map<string, InstallationIdentity>();
  for (const installation of legacyInstallations) {
    const agentName = normalizeIdentityPart(installation.agentName);
    const instanceId = normalizeIdentityPart(installation.instanceId) || 'default';
    if (!agentName) {
      result.skippedMalformed += 1;
      continue;
    }

    const key = `${agentName}\u0000${instanceId}`;
    const identity = identities.get(key);
    if (identity) {
      identity.installationCount += 1;
    } else {
      identities.set(key, { agentName, instanceId, installationCount: 1 });
    }
  }

  for (const identity of identities.values()) {
    result.identitiesChecked += 1;
    const shouldGrant = await isConfiguredDevTierGitHubIssueWriter(identity);
    if (!shouldGrant) continue;

    result.identitiesGranted += 1;
    if (dryRun) {
      result.installationsGranted += identity.installationCount;
      continue;
    }

    const update = await AgentInstallation.updateMany(
      {
        agentName: identity.agentName,
        // Current rows always have the schema default, but include historical
        // absent instanceId values in the canonical default identity so this
        // one-shot repair does not strand the oldest install records.
        instanceId: identity.instanceId === 'default'
          ? { $in: ['default', null] }
          : identity.instanceId,
        status: 'active',
        githubIssueWrite: { $exists: false },
      },
      { $set: { githubIssueWrite: true } },
    );
    result.installationsGranted += update.modifiedCount;
  }

  return result;
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  try {
    const result = await migrateGitHubIssueWriteCapability({
      dryRun: process.argv.includes('--dry'),
    });
    console.log(`[github-issue-write-capability] ${result.dryRun ? 'DRY-RUN' : 'APPLIED'}`);
    console.log(`  legacy installations : ${result.legacyInstallations}`);
    console.log(`  identities checked   : ${result.identitiesChecked}`);
    console.log(`  identities granted   : ${result.identitiesGranted}`);
    console.log(`  installs granted     : ${result.installationsGranted}`);
    console.log(`  malformed skipped    : ${result.skippedMalformed}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('GitHub issue-write capability migration failed:', err);
    process.exit(1);
  });
}
