import { Types } from 'mongoose';
import DiscordSummaryHistory from '../models/DiscordSummaryHistory';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'DiscordSummaryHistory';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('discord_summary_histories: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

/** A Date (or a value Mongo stored as one) as its ISO string; null when absent. */
const iso = (value: unknown): string | null => (value == null ? null : new Date(value as string).toISOString());

/** The embedded { start, end } as JSON with ISO strings, which is what the JSONB column holds. */
const timeRangeRow = (value: unknown): { start: string | null; end: string | null } | null => {
  if (value == null) return null;
  const { start, end } = value as { start?: unknown; end?: unknown };
  return { start: iso(start), end: iso(end) };
};

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for the history of Discord summaries queued for Commonly Bot,
 * selected by STORE_MODE_DISCORD_SUMMARY_HISTORY. Table:
 * config/migrations/0023_discord_summary_histories.sql. Built on first use
 * outside mongo, so mongo mode loads nothing new.
 *
 * The model is insert-only and nothing reads it, so the store declares no
 * filterColumns. `toRow` only reads fields and maps a missing one to null; a
 * throw (a stored date that is not a date) is a failed copy for repair, never
 * a failed insert, because the helper maps inside the copy's try.
 */
export function discordSummaryHistoryStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: DiscordSummaryHistory,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'discord_summary_histories',
      idColumn: 'id',
      columns: ['integration_id', 'summary_type', 'content', 'message_count', 'time_range',
        'posted_to_discord', 'posted_to_commonly', 'created_at', 'updated_at'],
      jsonColumns: ['time_range'],
    }),
    toRow: (doc) => ({
      id: String(doc._id),
      integration_id: doc.integrationId == null ? null : String(doc.integrationId),
      summary_type: doc.summaryType ?? null,
      content: doc.content ?? null,
      message_count: doc.messageCount ?? null,
      time_range: timeRangeRow(doc.timeRange),
      posted_to_discord: doc.postedToDiscord ?? null,
      posted_to_commonly: doc.postedToCommonly ?? null,
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: ObjectIds, Dates, and no field that was never set.
    fromRow: (row) => {
      const range = row.time_range as { start?: string | null; end?: string | null } | null;
      return {
        _id: new Types.ObjectId(String(row.id)),
        ...(row.integration_id == null ? {} : { integrationId: new Types.ObjectId(String(row.integration_id)) }),
        ...(row.summary_type == null ? {} : { summaryType: row.summary_type }),
        ...(row.content == null ? {} : { content: row.content }),
        ...(row.message_count == null ? {} : { messageCount: Number(row.message_count) }),
        ...(range == null ? {} : {
          timeRange: {
            ...(range.start == null ? {} : { start: new Date(range.start) }),
            ...(range.end == null ? {} : { end: new Date(range.end) }),
          },
        }),
        ...(row.posted_to_discord == null ? {} : { postedToDiscord: Boolean(row.posted_to_discord) }),
        ...(row.posted_to_commonly == null ? {} : { postedToCommonly: Boolean(row.posted_to_commonly) }),
        ...(row.created_at == null ? {} : { createdAt: new Date(row.created_at as string) }),
        ...(row.updated_at == null ? {} : { updatedAt: new Date(row.updated_at as string) }),
      };
    },
  });
  return store;
}

export interface DiscordSummaryFields {
  integrationId: unknown;
  summaryType: string;
  content: unknown;
  messageCount: unknown;
  timeRange: unknown;
  postedToCommonly?: boolean;
  postedToDiscord?: boolean;
}

/**
 * Records one Discord summary queued for Commonly Bot. Resolves when stored;
 * rejects as `save()` does (a ValidationError for a missing field), so each
 * caller's error handling is unchanged.
 *
 * mongo makes the pre-step-2 `new DiscordSummaryHistory(fields).save()`, with
 * no Postgres call. dual and pg-read insert through the helper's `create`,
 * which is `Model.create` (the same validation, defaults and timestamps) with
 * the version and the marker; a copy that fails after the insert never fails
 * the caller, and the marker stays for `repair`. pg refuses until step 4,
 * before any write: the helper's pg-only `create` builds the row from
 * `new Model(doc)` without `save()`, so it runs no validation and sets no
 * updatedAt.
 */
export async function recordDiscordSummary(fields: DiscordSummaryFields): Promise<void> {
  const mode = storeMode(NAME);
  if (mode === 'pg') {
    throw new Error(`dual-store: ${NAME} recordDiscordSummary is not supported in pg mode`
      + ' until step 4 (docs/runbooks/adr-034-model-move.md)');
  }
  if (mode === 'mongo') {
    await new DiscordSummaryHistory(fields).save();
    return;
  }
  await discordSummaryHistoryStore().create(fields as unknown as Record<string, unknown>);
}
