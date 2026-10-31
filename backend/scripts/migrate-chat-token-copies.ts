#!/usr/bin/env node
/**
 * TASK-539: move GroupMe access tokens into connectorSecrets and scrub the
 * GroupMe and Slack `config.accessToken` / `config.refreshToken` copies the
 * generic connector routes used to store (from the #2719 review).
 *
 * Default dry run. SRE runs --apply only after reviewing the counts, and after
 * the build carrying `services/chatConnectorTokens` is live, because that build
 * is the one whose agent reader takes the ref instead of the row's copy.
 *
 * GroupMe: a row with a plaintext token and no `accessTokenRef` has the token
 * encrypted under its id and the ref set in the same update that unsets the
 * plaintext. A row that already has a ref keeps it: the ref is authoritative and
 * is never replaced with an older plaintext copy. The import is insert-only, so
 * a token a live edit stores between this script's read and its write is kept. `refreshToken` has no reader
 * (GroupMe issues none) and is unset.
 * Slack: the bot token is `config.botTokenRef`, written by the OAuth bind, and no
 * code reads a row's own `accessToken` or `refreshToken`, so both are unset.
 *
 * The report counts the other credential-shaped fields on these rows too
 * (`botToken`, `signingSecret`, `appToken`), so the inventory is whole. It never
 * writes them.
 *
 * No token value, ref or row identifier is logged.
 */
/* eslint-disable no-console */
import mongoose from 'mongoose';

// eslint-disable-next-line global-require
const connectorSecrets = require('../services/connectorSecrets');
// eslint-disable-next-line global-require
const { GROUPME_ACCESS_TOKEN } = require('../services/connectorSecretKinds');

const CHAT_TYPES = ['groupme', 'slack'] as const;
type ChatType = typeof CHAT_TYPES[number];
const ACCESS = 'config.accessToken';
const REFRESH = 'config.refreshToken';
const INVENTORY_ONLY = ['botToken', 'signingSecret', 'appToken'] as const;

export interface Counts {
  candidates: number;
  accessFields: number;
  refreshFields: number;
  toMove: number;
  moved: number;
  cleared: number;
  remaining: number;
  inventory: Record<typeof INVENTORY_ONLY[number], number>;
}

export type Report = Record<ChatType, Counts>;

const material = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const hasRef = (config: Record<string, unknown> | undefined): boolean => Boolean(
  material(config?.accessTokenRef),
);

export const migrateChatTokenCopies = async (
  { apply = false }: { apply?: boolean } = {},
): Promise<Report> => {
  // The raw collection reaches historical keys whatever the current schema or
  // toJSON redactor says. $exists includes blank and null residue.
  const collection = mongoose.connection.collection('integrations');
  const report = {} as Report;
  for (const type of CHAT_TYPES) {
    const filter = {
      type,
      $or: [{ [ACCESS]: { $exists: true } }, { [REFRESH]: { $exists: true } }],
    };
    // Sequential per type and per row: a failure stops the run, and a rerun is safe.
    /* eslint-disable no-await-in-loop */
    const [candidates, accessFields, refreshFields, ...inventoryCounts] = await Promise.all([
      collection.countDocuments(filter),
      collection.countDocuments({ type, [ACCESS]: { $exists: true } }),
      collection.countDocuments({ type, [REFRESH]: { $exists: true } }),
      ...INVENTORY_ONLY.map((field) => collection.countDocuments({ type, [`config.${field}`]: { $exists: true } })),
    ]);
    const inventory = Object.fromEntries(
      INVENTORY_ONLY.map((field, i) => [field, inventoryCounts[i]]),
    ) as Counts['inventory'];

    let toMove = 0;
    let moved = 0;
    let cleared = 0;
    if (type === 'groupme') {
      const rows = await collection
        .find(filter, { projection: { [ACCESS]: 1, 'config.accessTokenRef': 1 } })
        .toArray();
      for (const row of rows) {
        const config = row.config as Record<string, unknown> | undefined;
        const token = material(config?.accessToken);
        const move = Boolean(token) && !hasRef(config);
        if (move) toMove += 1;
        if (apply) {
          const $set: Record<string, unknown> = {};
          let created = false;
          if (move) {
            // Encrypt first: if the key ring is missing this throws before the
            // plaintext is unset, so no row loses its only copy. Insert-only: if
            // a live edit stored a token after the read above, that newer secret
            // wins and this older copy is dropped, never written over it.
            const stored = await connectorSecrets.putIfAbsent(
              String(row._id), GROUPME_ACCESS_TOKEN, token,
            );
            $set['config.accessTokenRef'] = stored.ref;
            ({ created } = stored);
          }
          const result = await collection.updateOne(
            { _id: row._id },
            { ...(move ? { $set } : {}), $unset: { [ACCESS]: '', [REFRESH]: '' } },
          );
          if (result.modifiedCount) {
            cleared += 1;
            if (created) moved += 1;
          }
        }
      }
    } else if (apply) {
      cleared = (await collection.updateMany(filter, {
        $unset: { [ACCESS]: '', [REFRESH]: '' },
      })).modifiedCount;
    }
    const remaining = apply ? await collection.countDocuments(filter) : candidates;
    /* eslint-enable no-await-in-loop */
    report[type] = {
      candidates, accessFields, refreshFields, toMove, moved, cleared, remaining, inventory,
    };
  }
  return report;
};

export const formatReport = (report: Report, apply: boolean): string[] => [
  `[migrate-chat-token-copies] ${apply ? 'APPLY' : 'DRY-RUN'}`,
  ...CHAT_TYPES.map((type) => {
    const c = report[type];
    const inventory = INVENTORY_ONLY.map((field) => `${field}=${c.inventory[field]}`).join(' ');
    return `${type}: candidates=${c.candidates} accessFields=${c.accessFields} `
      + `refreshFields=${c.refreshFields} toMove=${c.toMove} moved=${c.moved} `
      + `cleared=${c.cleared} remaining=${c.remaining} | not written: ${inventory}`;
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
    const report = await migrateChatTokenCopies({ apply });
    formatReport(report, apply).forEach((line) => console.log(line));
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch(() => {
    // Database and driver errors may carry connection strings or command
    // values. Never echo the exception, the URI or command-line input.
    console.error('[migrate-chat-token-copies] Failed. No values logged; rerun dry-run to inspect counts.');
    process.exitCode = 1;
  });
}
