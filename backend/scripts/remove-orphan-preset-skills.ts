#!/usr/bin/env node
/*
 * Remove the pod skill assets that presets imported for skills no preset ships
 * any more (F415).
 *
 * #3895 and #3897 emptied every preset's defaultSkills, but applyPresetDefaultSkills
 * only ever upserts, so the assets it wrote earlier stay in their pods and keep
 * reaching agents' context. Reprovisioning cannot clear them: it adds, it does not
 * remove, and the presets that imported them have no active install left.
 *
 * The filter is exact and narrow: type 'skill', imported by 'preset.defaultSkills',
 * and one of the eight skill names below. A skill a person imported by hand, even
 * under the same name, is not touched.
 *
 * ACTION must be set, to 'dry-run' or 'delete'. Unset or anything else does nothing
 * and exits 2. A delete first copies every matched document, whole, into a backup
 * collection and checks the copy before deleting; a restore is one insertMany from
 * that collection. It deletes by the backed-up ids, not by re-running the filter.
 *
 * Self-contained (mongoose only) so it can run on ops-runner before it ships:
 *   ACTION=dry-run node dist/scripts/remove-orphan-preset-skills.js
 *   ACTION=delete  node dist/scripts/remove-orphan-preset-skills.js
 * Optional: BACKUP_COLLECTION (default podassets_backup_f415), BACKUP_FILE (also
 * write the matched documents as JSON to this path).
 */

import fs from 'fs';
import mongoose from 'mongoose';

export const ORPHAN_SKILLS = [
  'officecli', 'github', 'tmux', 'pdf', 'pandic-office', 'markdown-converter',
  'tavily', 'trello',
] as const;

export const orphanFilter = () => ({
  type: 'skill',
  'metadata.autoImportedBy': 'preset.defaultSkills',
  'metadata.skillName': { $in: [...ORPHAN_SKILLS] },
});

export const DEFAULT_BACKUP_COLLECTION = 'podassets_backup_f415';

type Doc = Record<string, unknown> & { _id: unknown; podId?: unknown; metadata?: { skillName?: string } };

interface Collection {
  find: (q: object) => { toArray: () => Promise<Doc[]> };
  countDocuments: (q: object) => Promise<number>;
  insertMany: (docs: Doc[], opts?: object) => Promise<unknown>;
  deleteMany: (q: object) => Promise<{ deletedCount?: number }>;
}
interface Db { collection: (name: string) => Collection }

export interface RemovalReport {
  action: 'dry-run' | 'delete' | 'refused';
  matched: number;
  perSkill: Record<string, number>;
  perPod: Record<string, number>;
  backupCollection: string | null;
  backedUp: number;
  backupFile: string | null;
  deleted: number;
  /** Matching rows left after a delete; null otherwise. */
  remaining: number | null;
  problem: string | null;
}

export async function removeOrphanPresetSkills(
  db: Db,
  opts: { action?: string; backupCollection?: string; backupFile?: string } = {},
): Promise<RemovalReport> {
  const report: RemovalReport = {
    action: 'refused',
    matched: 0,
    perSkill: {},
    perPod: {},
    backupCollection: null,
    backedUp: 0,
    backupFile: null,
    deleted: 0,
    remaining: null,
    problem: null,
  };
  if (opts.action !== 'dry-run' && opts.action !== 'delete') {
    const got = opts.action === undefined ? 'nothing' : `'${opts.action}'`;
    report.problem = `ACTION must be 'dry-run' or 'delete', got ${got}`;
    return report;
  }

  const assets = db.collection('podassets');
  const docs = await assets.find(orphanFilter()).toArray();
  report.matched = docs.length;
  for (const d of docs) {
    const skill = String(d.metadata?.skillName);
    const pod = String(d.podId);
    report.perSkill[skill] = (report.perSkill[skill] || 0) + 1;
    report.perPod[pod] = (report.perPod[pod] || 0) + 1;
  }
  const counted = tally(report);
  if (!counted.reconciles) {
    report.action = opts.action;
    report.problem = `per-skill ${counted.skillRows} / per-pod ${counted.podRows} do not both equal matched ${docs.length}; nothing deleted`;
    return report;
  }
  if (opts.action === 'dry-run') {
    report.action = 'dry-run';
    return report;
  }
  if (docs.length === 0) {
    report.action = 'delete';
    report.remaining = 0;
    return report;
  }

  const backupName = opts.backupCollection || DEFAULT_BACKUP_COLLECTION;
  const backup = db.collection(backupName);
  const ids = docs.map((d) => d._id);
  if (opts.backupFile) {
    fs.writeFileSync(opts.backupFile, JSON.stringify(docs, null, 2));
    report.backupFile = opts.backupFile;
  }
  // Same _ids, so a rerun that would back up a row twice fails here, before any delete.
  await backup.insertMany(docs, { ordered: true });
  report.backupCollection = backupName;
  report.backedUp = await backup.countDocuments({ _id: { $in: ids } });
  if (report.backedUp !== docs.length) {
    report.problem = `backup holds ${report.backedUp} of ${docs.length} matched rows; nothing deleted`;
    return report;
  }

  report.action = 'delete';
  const res = await assets.deleteMany({ _id: { $in: ids } });
  report.deleted = res.deletedCount || 0;
  report.remaining = await assets.countDocuments(orphanFilter());
  if (report.deleted !== docs.length || report.remaining !== 0) {
    report.problem = `deleted ${report.deleted} of ${docs.length}; ${report.remaining} matching rows remain`;
  }
  return report;
}

/** rows-per-pod -> number of pods, and whether both breakdowns sum to `matched`. */
export function tally(report: RemovalReport) {
  const histogram: Record<string, number> = {};
  for (const n of Object.values(report.perPod)) histogram[n] = (histogram[n] || 0) + 1;
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const podRows = sum(report.perPod);
  const skillRows = sum(report.perSkill);
  return {
    histogram,
    pods: Object.keys(report.perPod).length,
    podRows,
    skillRows,
    reconciles: podRows === report.matched && skillRows === report.matched,
  };
}

export function exitCodeFor(report: RemovalReport): number {
  if (report.action === 'refused') return 2;
  if (report.problem) return 3;
  return 0;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await mongoose.connect(env.MONGO_URI ?? '');
  const r = await removeOrphanPresetSkills(mongoose.connection.db as unknown as Db, {
    action: env.ACTION,
    backupCollection: env.BACKUP_COLLECTION,
    backupFile: env.BACKUP_FILE,
  });
  const tag = '[orphan-preset-skills]';
  console.log(`${tag} action  : ${r.action}`);
  console.log(`${tag} matched : ${r.matched}`);
  console.log(`${tag} per skill: ${JSON.stringify(r.perSkill)}`);
  const t = tally(r);
  console.log(`${tag} pods    : ${t.pods}`);
  console.log(`${tag} per pod : ${JSON.stringify(r.perPod)}`);
  console.log(`${tag} histogram (rows per pod: pods): ${JSON.stringify(t.histogram)}`);
  console.log(`${tag} sums    : per-skill ${t.skillRows}, per-pod ${t.podRows}, matched ${r.matched}, reconciles ${t.reconciles}`);
  if (r.backupCollection) console.log(`${tag} backup  : ${r.backedUp} rows in collection ${r.backupCollection}`);
  if (r.backupFile) console.log(`${tag} backup  : ${r.matched} rows in file ${r.backupFile}`);
  if (r.action === 'delete') console.log(`${tag} deleted : ${r.deleted}, remaining ${r.remaining}`);
  if (r.problem) console.error(`${tag} ${r.action === 'refused' ? 'REFUSED' : 'PROBLEM'}: ${r.problem}`);
  process.exitCode = exitCodeFor(r);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[orphan-preset-skills] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      mongoose.connection.close().catch(() => {});
    });
}
