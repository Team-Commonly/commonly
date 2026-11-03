#!/usr/bin/env node
/*
 * Repair File.originalName rows that multer stored latin1-decoded.
 *
 * Browsers send a multipart filename as raw UTF-8 with no charset parameter,
 * and multer 2 decodes such a parameter as latin1 unless `defParamCharset` is
 * set. routes/uploads.ts now sets it; this script fixes the rows saved before
 * that, which show on the Artifacts page as "2025å¹´æ\u008a¥å\u0091\u008a.doc" instead of
 * "2025年报告.doc".
 *
 * A row is repaired only when all of these hold, so a name that was stored
 * correctly is never touched:
 *   - every code point is ≤ U+00FF (a latin1 decode can produce nothing else),
 *     and at least one is ≥ U+0080 (pure ASCII is already right);
 *   - re-reading those bytes as UTF-8 is valid (no U+FFFD appears);
 *   - the repaired name encodes back to exactly the stored bytes.
 * A genuine latin1 name such as "café.png" stored correctly fails the second
 * test (a lone 0xE9 is not valid UTF-8) and is left alone.
 *
 * Usage:
 *   cd backend && node dist/scripts/repair-latin1-file-names.js          # dry run
 *   cd backend && node dist/scripts/repair-latin1-file-names.js --apply
 */

/* eslint-disable no-console */

// Returns the repaired name, or null when the stored name should stay as is.
const repairLatin1Name = (stored: unknown): string | null => {
  if (typeof stored !== 'string' || stored.length === 0) return null;
  let high = false;
  for (let i = 0; i < stored.length; i += 1) {
    const c = stored.charCodeAt(i);
    if (c > 0xff) return null;
    if (c >= 0x80) high = true;
  }
  if (!high) return null;
  const bytes = Buffer.from(stored, 'latin1');
  const repaired = bytes.toString('utf8');
  if (repaired.includes('�')) return null;
  if (!Buffer.from(repaired, 'utf8').equals(bytes)) return null;
  if (repaired === stored) return null;
  return repaired;
};

// Masks a name for the dry-run log: keeps the extension and the first two
// characters, so the output shows the repair works without listing what
// people named their files.
const maskName = (name: string): string => {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const chars = [...stem];
  return `${chars.slice(0, 2).join('')}${'•'.repeat(Math.max(0, chars.length - 2))}${ext}`;
};

type RepairReport = { scanned: number; repairable: number; repaired: number };

// The scan and the write, given the File model, so a test can run both
// against an in-memory database. Writes only when `apply` is true.
const repairFileNames = async (
  FileModel: any,
  { apply, log = console.log }: { apply: boolean; log?: (line: string) => void },
): Promise<RepairReport> => {
  // Only names with a code point in U+0080–U+00FF can be candidates. Written
  // as \x80-\xff because MongoDB's PCRE2 rejects a JavaScript \u escape
  // ("PCRE2 does not support \u"); in its UTF mode \xhh is the code point.
  const rows = await FileModel.find({ originalName: /[\x80-\xff]/ })
    .select('_id originalName')
    .lean();
  const candidates = rows
    .map((row: { _id: unknown; originalName: string }) => ({
      id: row._id,
      stored: row.originalName,
      repaired: repairLatin1Name(row.originalName),
    }))
    .filter((c: { repaired: string | null }) => c.repaired !== null);

  log(`rows with U+0080–U+00FF: ${rows.length}`);
  log(`repairable:              ${candidates.length}`);
  log(`left alone:              ${rows.length - candidates.length}`);
  candidates.slice(0, 5).forEach((c: { repaired: string }) => log(`  → ${maskName(c.repaired)}`));

  if (!apply) {
    log('DRY RUN: re-run with --apply to write.');
    return { scanned: rows.length, repairable: candidates.length, repaired: 0 };
  }

  let repaired = 0;
  for (const c of candidates) {
    // Matching on the stored value too means a row renamed since the scan is
    // skipped rather than overwritten.
    // eslint-disable-next-line no-await-in-loop
    const res = await FileModel.updateOne(
      { _id: c.id, originalName: c.stored },
      { $set: { originalName: c.repaired } },
    );
    // Count what the database changed, not what was intended.
    repaired += (res?.modifiedCount ?? res?.nModified ?? 0);
  }
  log(`repaired ${repaired} of ${candidates.length}.`);
  return { scanned: rows.length, repairable: candidates.length, repaired };
};

const main = async () => {
  // eslint-disable-next-line global-require
  const mongoose = require('mongoose');
  // eslint-disable-next-line global-require
  const File = require('../models/File');
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);
  await repairFileNames(File.default || File, { apply: process.argv.includes('--apply') });
  await mongoose.disconnect();
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { repairLatin1Name, maskName, repairFileNames };
