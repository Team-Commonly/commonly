#!/usr/bin/env node
/*
 * ADR-003 Phase 1 backfill. For each AgentMemory record that has v1 `content`
 * but no `sections`, parse the content into `sections.long_term` +
 * `sections.dedup_state` and save. Idempotent: records already carrying
 * sections are skipped. Dry-run with `--dry`. Safe to run multiple times.
 */

import mongoose from 'mongoose';
import AgentMemory from '../models/AgentMemory';
import { buildSectionsFromLegacyContent } from '../services/agentMemoryService';

interface BackfillResult {
  total: number;
  migrated: number;
  skipped: number;
  empty: number;
}

export async function backfillAgentMemorySections(
  options: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const dryRun = options.dryRun === true;
  const result: BackfillResult = { total: 0, migrated: 0, skipped: 0, empty: 0 };

  const cursor = AgentMemory.find({}).cursor();
  for await (const doc of cursor) {
    result.total += 1;

    // A record is considered already-migrated if any concrete section exists.
    // Checking `Object.keys(sections).length > 0` misclassifies a stray empty
    // `sections: {}` sub-doc as migrated; check specific section fields instead.
    const s = doc.sections;
    const alreadyMigrated = !!(
      s && (
        s.long_term || s.dedup_state || s.soul || s.shared || s.runtime_meta
        || (Array.isArray(s.daily) && s.daily.length > 0)
        || (Array.isArray(s.relationships) && s.relationships.length > 0)
      )
    );
    if (alreadyMigrated) {
      result.skipped += 1;
      continue;
    }

    if (!doc.content || !doc.content.trim()) {
      result.empty += 1;
      continue;
    }

    const sections = buildSectionsFromLegacyContent(doc.content, doc.updatedAt || new Date());
    if (Object.keys(sections).length === 0) {
      result.empty += 1;
      continue;
    }

    if (!dryRun) {
      doc.sections = sections;
      // Leave `sourceRuntime` unset — the first real post-migration write
      // will populate it with the driver's own identifier (ADR-003 §Runtime
      // driver expectations). `'legacy'` is not an ADR-recognized runtime.
      doc.schemaVersion = doc.schemaVersion ?? 2;
      await doc.save();
    }
    result.migrated += 1;
  }

  return result;
}

// Only run when invoked directly (node/ts-node), not when imported by tests.
if (require.main === module) {
  const dryRun = process.argv.includes('--dry');
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required.');
    process.exit(1);
  }
  (async () => {
    await mongoose.connect(uri);
    try {
      const r = await backfillAgentMemorySections({ dryRun });
      console.log(
        `AgentMemory backfill ${dryRun ? '(dry-run) ' : ''}`
        + `total=${r.total} migrated=${r.migrated} skipped=${r.skipped} empty=${r.empty}`,
      );
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
