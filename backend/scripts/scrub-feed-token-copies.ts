#!/usr/bin/env node
/**
 * TASK-537: redact legacy X/Instagram token copies after #2692 is deployed.
 * Default dry run. SRE runs --apply only after reviewing the counts.
 * No token values (or row identifiers) are read or logged. Existing encrypted
 * refs are authoritative and must never be replaced with an older plaintext copy.
 */
/* eslint-disable no-console */
import mongoose from 'mongoose';

const FEED_TYPES = ['x', 'instagram'] as const;
const ACCESS = 'config.accessToken';
const REFRESH = 'config.refreshToken';

interface Counts {
  candidates: number;
  accessFields: number;
  refreshFields: number;
  cleared: number;
  remaining: number;
}

type Report = Record<typeof FEED_TYPES[number], Counts>;

export const scrubFeedTokenCopies = async (
  { apply = false }: { apply?: boolean } = {},
): Promise<Report> => {
  // Raw collection deliberately reaches historical keys regardless of the
  // current Mongoose schema or toJSON redactor. $exists includes blank/null
  // residue: all copies of these retired fields should disappear.
  const collection = mongoose.connection.collection('integrations');
  const report = {} as Report;
  for (const type of FEED_TYPES) {
    const filter = {
      type,
      $or: [{ [ACCESS]: { $exists: true } }, { [REFRESH]: { $exists: true } }],
    };
    // Sequential per-type writes keep failures fail-stop; reruns are safe.
    // eslint-disable-next-line no-await-in-loop
    const [candidates, accessFields, refreshFields] = await Promise.all([
      collection.countDocuments(filter),
      collection.countDocuments({ type, [ACCESS]: { $exists: true } }),
      collection.countDocuments({ type, [REFRESH]: { $exists: true } }),
    ]);
    // eslint-disable-next-line no-await-in-loop
    const cleared = apply ? (await collection.updateMany(filter, {
      $unset: { [ACCESS]: '', [REFRESH]: '' },
    })).modifiedCount : 0;
    // eslint-disable-next-line no-await-in-loop
    const remaining = apply ? await collection.countDocuments(filter) : candidates;
    report[type] = { candidates, accessFields, refreshFields, cleared, remaining };
  }
  return report;
};

export const formatReport = (report: Report, apply: boolean): string[] => [
  `[scrub-feed-token-copies] ${apply ? 'APPLY' : 'DRY-RUN'}`,
  ...FEED_TYPES.map((type) => {
    const counts = report[type];
    return `${type}: candidates=${counts.candidates} accessFields=${counts.accessFields} `
      + `refreshFields=${counts.refreshFields} cleared=${counts.cleared} remaining=${counts.remaining}`;
  }),
  ...(apply ? [] : ['DRY RUN: nothing written. Review counts before --apply.']),
];

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply')) throw new Error('invalid arguments');
  if (!process.env.MONGO_URI) throw new Error('missing configuration');
  const apply = args.includes('--apply');
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const report = await scrubFeedTokenCopies({ apply });
    formatReport(report, apply).forEach((line) => console.log(line));
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch(() => {
    // Database/driver errors may contain connection strings or command values.
    // Never echo the exception, its message, the URI, or command-line input.
    console.error('[scrub-feed-token-copies] Failed. No values logged; rerun dry-run to inspect counts.');
    process.exitCode = 1;
  });
}
