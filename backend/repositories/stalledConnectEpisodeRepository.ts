import { Types } from 'mongoose';
import StalledConnectEpisode from '../models/StalledConnectEpisode';
import { createDualStore, pgTableAdapter, storeMode, type DualStore } from './dualStore';

const NAME = 'StalledConnectEpisode';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('stalled_connect_episodes: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

type Doc = Record<string, unknown>;

const dateOrNull = (value: unknown): Date | null => (value == null ? null : new Date(value as string));
const hexOrNull = (value: unknown): string | null => (value == null ? null : String(value));
const idOrNull = (value: unknown): Types.ObjectId | null => (value == null ? null : new Types.ObjectId(String(value)));

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for stalled-connect episodes, selected by
 * STORE_MODE_STALLED_CONNECT_EPISODE. Table:
 * config/migrations/0029_stalled_connect_episodes.sql. Built on first use
 * outside mongo, so mongo mode loads nothing new.
 *
 * installationId and installedBy are ObjectIds in Mongo and hex text in
 * Postgres. installerUsername is the installer's handle, copied as Mongo holds
 * it. No path is `select: false`, and no caller deletes an episode.
 *
 * Every read stays on Mongo in dual and pg-read (findPageMongo): each decides
 * what a person is told, in the pod or by email (a nudge, a resolution post,
 * a digest line, a waiting-owner email), and a Postgres row lagging another
 * process's claim, close or digest mark would say a line twice.
 */
export function stalledConnectEpisodeStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: StalledConnectEpisode,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'stalled_connect_episodes',
      idColumn: 'id',
      columns: ['installation_id', 'pod_id', 'installed_by', 'installer_username', 'agent_name', 'instance_id',
        'display_name', 'token_issued_at', 'token_source', 'producer', 'nudged_at', 'nudge_message_id',
        'resolved_at', 'resolution_message_id', 'digested_at', 'digested_again_at', 'status', 'created_at',
        'updated_at'],
    }),
    toRow: (doc) => ({
      id: String(doc._id),
      installation_id: hexOrNull(doc.installationId),
      pod_id: doc.podId ?? null,
      installed_by: hexOrNull(doc.installedBy),
      installer_username: doc.installerUsername ?? null,
      agent_name: doc.agentName ?? null,
      instance_id: doc.instanceId ?? null,
      display_name: doc.displayName ?? null,
      token_issued_at: doc.tokenIssuedAt ?? null,
      token_source: doc.tokenSource ?? null,
      producer: doc.producer ?? null,
      nudged_at: doc.nudgedAt ?? null,
      nudge_message_id: doc.nudgeMessageId ?? null,
      resolved_at: doc.resolvedAt ?? null,
      resolution_message_id: doc.resolutionMessageId ?? null,
      digested_at: doc.digestedAt ?? null,
      digested_again_at: doc.digestedAgainAt ?? null,
      status: doc.status ?? null,
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: schema defaults present, and
    // no optional field until it is set.
    fromRow: (row) => {
      const optional = (key: string, value: unknown) => (value == null ? {} : { [key]: value });
      return {
        _id: new Types.ObjectId(String(row.id)),
        installationId: idOrNull(row.installation_id),
        podId: row.pod_id,
        installedBy: idOrNull(row.installed_by),
        ...optional('installerUsername', row.installer_username),
        agentName: row.agent_name,
        instanceId: row.instance_id ?? 'default',
        ...optional('displayName', row.display_name),
        tokenIssuedAt: dateOrNull(row.token_issued_at),
        tokenSource: row.token_source ?? null,
        producer: row.producer ?? 'timer',
        nudgedAt: dateOrNull(row.nudged_at),
        ...optional('nudgeMessageId', row.nudge_message_id),
        ...optional('resolvedAt', dateOrNull(row.resolved_at)),
        ...optional('resolutionMessageId', row.resolution_message_id),
        ...optional('digestedAt', dateOrNull(row.digested_at)),
        ...optional('digestedAgainAt', dateOrNull(row.digested_again_at)),
        status: row.status ?? 'open',
        ...optional('createdAt', dateOrNull(row.created_at)),
        ...optional('updatedAt', dateOrNull(row.updated_at)),
      };
    },
  });
  return store;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

const notYetInPg = (method: string) => new Error(`dual-store: ${NAME} ${method} is not supported in pg mode`
  + ' until step 4 (docs/runbooks/adr-034-model-move.md)');

const fieldList = (fields: string): string[] => fields.split(/\s+/).filter(Boolean);

/** The page size of a Mongo read that mongo mode makes in one unbounded query. */
export const MONGO_READ_PAGE = 500;

/**
 * Every document `filter` matches, read from Mongo in pages in `_id` order
 * (findPageMongo needs a limit). mongo mode makes one unbounded `find` instead,
 * whose order is Mongo's natural order. Order only matters on ties: the
 * explained-tokens read keeps the last episode per token key, and the digest
 * reads keep the first episode on a nudgedAt tie, so on a tie the chosen
 * episode can differ from mongo mode's: here it is the highest _id for the
 * first and the lowest for the second, deterministically.
 */
const readAllMongo = async (filter: Doc, fields: string[]): Promise<Doc[]> => {
  const out: Doc[] = [];
  let after: unknown = null;
  for (;;) {
    const pageFilter = after == null ? filter : { $and: [filter, { _id: { $gt: after } }] };
    // eslint-disable-next-line no-await-in-loop -- keyset paging
    const page = await stalledConnectEpisodeStore().findPageMongo(pageFilter, {
      sort: { _id: 1 }, limit: MONGO_READ_PAGE, fields,
    });
    out.push(...page);
    if (page.length < MONGO_READ_PAGE) return out;
    after = page[page.length - 1]._id;
  }
};

const EXPLAINED_FIELDS = 'agentName instanceId installedBy tokenIssuedAt installationId podId';

/**
 * Episodes of these agents whose nudge actually posted, for the scan's
 * one-line-per-token rule. mongo makes the pre-step-2 `find(..).select(..)
 * .lean()`. dual and pg-read read Mongo: the answer decides whether a nudge
 * is posted. pg refuses until step 4 (findPageMongo does).
 */
export async function findExplainedEpisodes(agentNames: string[]): Promise<Doc[]> {
  const filter = { agentName: { $in: [...new Set(agentNames)] }, nudgeMessageId: { $nin: [null, ''] } };
  if (storeMode(NAME) === 'mongo') {
    return StalledConnectEpisode.find(filter).select(EXPLAINED_FIELDS).lean() as unknown as Promise<Doc[]>;
  }
  return readAllMongo(filter, fieldList(EXPLAINED_FIELDS));
}

export type StalledConnectEpisodeInsert = {
  installationId: unknown; podId: string; installedBy: unknown; installerUsername: string; agentName: string;
  instanceId: string; displayName: string; tokenIssuedAt: Date; tokenSource: 'installation' | 'user' | null;
  producer: 'timer' | 'reactive'; nudgedAt: Date; status: 'open';
};

/**
 * Claims one token-episode before the nudge posts: the created episode, or
 * null when (installationId, tokenIssuedAt) was already claimed (by an earlier
 * pass or the other producer), which means "already explained". Any other
 * error propagates.
 *
 * The lock is Mongo's unique index in every mode that runs today. mongo makes
 * the pre-step-2 `create`. dual and pg-read insert through the helper's
 * `create`, whose duplicate key (11000) comes from Mongo before any copy; a
 * copy that fails after the insert never fails the claim (the marker stays for
 * `repair`). pg refuses until step 4, before any write.
 */
export async function claimStalledConnectEpisode(fields: StalledConnectEpisodeInsert): Promise<Doc | null> {
  const mode = storeMode(NAME);
  if (mode === 'pg') throw notYetInPg('claimStalledConnectEpisode');
  try {
    if (mode === 'mongo') return await StalledConnectEpisode.create(fields) as unknown as Doc;
    return await stalledConnectEpisodeStore().create(fields as unknown as Doc);
  } catch (error) {
    if (isDuplicateKey(error)) return null;
    throw error;
  }
}

/**
 * Records the nudge's message id on its episode. mongo makes the pre-step-2
 * `updateOne({ _id }, { $set })`; dual and pg-read the helper's `setWhere` on
 * `_id`. pg refuses until step 4 (setWhere does).
 */
export async function recordNudgeMessage(episodeId: unknown, nudgeMessageId: string): Promise<void> {
  if (storeMode(NAME) === 'mongo') {
    await StalledConnectEpisode.updateOne({ _id: episodeId }, { $set: { nudgeMessageId } });
    return;
  }
  await stalledConnectEpisodeStore().setWhere({ _id: episodeId }, { nudgeMessageId });
}

export type StalledConnectResolution = { status: 'resolved'; resolvedAt: Date; resolutionMessageId?: string };

/**
 * Closes an episode that is still open. mongo makes the pre-step-2
 * `updateOne({ _id, status: 'open' }, { $set })`; dual and pg-read the helper's
 * `setWhere` on the same filter, so an episode another pass closed first is
 * left as it is. pg refuses until step 4.
 */
export async function resolveStalledConnectEpisode(
  episodeId: unknown, fields: StalledConnectResolution,
): Promise<void> {
  if (storeMode(NAME) === 'mongo') {
    await StalledConnectEpisode.updateOne({ _id: episodeId, status: 'open' }, { $set: fields });
    return;
  }
  await stalledConnectEpisodeStore().setWhere({ _id: episodeId, status: 'open' }, fields as unknown as Doc);
}

/**
 * One page of open episodes in `_id` order, after `after` (null: from the
 * start), for the resolution sweep. mongo makes the pre-step-2
 * `find(..).sort({ _id: 1 }).limit().lean()`. dual and pg-read read Mongo
 * (findPageMongo): each episode read decides a resolution post. pg refuses.
 */
export async function findOpenEpisodesPage(after: unknown, limit: number): Promise<Doc[]> {
  const filter: Doc = { status: 'open', ...(after ? { _id: { $gt: after } } : {}) };
  if (storeMode(NAME) === 'mongo') {
    return StalledConnectEpisode.find(filter).sort({ _id: 1 }).limit(limit).lean() as unknown as Promise<Doc[]>;
  }
  return stalledConnectEpisodeStore().findPageMongo(filter, { sort: { _id: 1 }, limit });
}

const DUE_FIELDS = 'installationId installedBy podId nudgedAt digestedAt digestedAgainAt';

/**
 * Open episodes nudged at or before `cutoff`, for the digest's choice of who
 * gets one. mongo makes the pre-step-2 `find(..).select(..).lean()`. dual and
 * pg-read read Mongo: the answer decides who is emailed. pg refuses.
 */
export async function findDueStalledEpisodes(cutoff: Date): Promise<Doc[]> {
  const filter = { status: 'open', nudgedAt: { $lte: cutoff } };
  if (storeMode(NAME) === 'mongo') {
    return StalledConnectEpisode.find(filter).select(DUE_FIELDS).lean() as unknown as Promise<Doc[]>;
  }
  return readAllMongo(filter, fieldList(DUE_FIELDS));
}

const LINE_FIELDS = 'installationId podId installedBy agentName instanceId displayName tokenIssuedAt nudgedAt '
  + 'digestedAt digestedAgainAt';

/**
 * One installer's open episodes nudged at or before `cutoff`, for their digest
 * lines. mongo makes the pre-step-2 `find(..).select(..).lean()`. dual and
 * pg-read read Mongo: the answer decides which lines the email says, and a
 * Postgres row lagging yesterday's mark would say one twice. pg refuses.
 */
export async function findInstallerStalledEpisodes(installedBy: unknown, cutoff: Date): Promise<Doc[]> {
  const filter = { installedBy, status: 'open', nudgedAt: { $lte: cutoff } };
  if (storeMode(NAME) === 'mongo') {
    return StalledConnectEpisode.find(filter).select(LINE_FIELDS).lean() as unknown as Promise<Doc[]>;
  }
  return readAllMongo(filter, fieldList(LINE_FIELDS));
}

export type StalledDigestMarkFields = Partial<Record<'digestedAt' | 'digestedAgainAt', Date>>;

/**
 * Marks a delivered digest line on its episode, if it is still open. mongo
 * makes the pre-step-2 `updateOne({ _id, status: 'open' }, { $set })`. dual
 * and pg-read make the helper's `setWhere` on the same filter; a mark with no
 * field writes nothing there (mongo mode's empty `$set` would only bump
 * updatedAt). pg refuses until step 4.
 */
export async function markStalledEpisodeDigested(episodeId: unknown, fields: StalledDigestMarkFields): Promise<void> {
  if (storeMode(NAME) === 'mongo') {
    await StalledConnectEpisode.updateOne({ _id: episodeId, status: 'open' }, { $set: fields });
    return;
  }
  if (!Object.keys(fields).length) {
    if (storeMode(NAME) === 'pg') throw notYetInPg('markStalledEpisodeDigested');
    return;
  }
  await stalledConnectEpisodeStore().setWhere({ _id: episodeId, status: 'open' }, fields as Doc);
}

const WAITING_FIELDS = 'installationId podId installedBy agentName instanceId displayName tokenIssuedAt nudgedAt';

/**
 * The newest open episodes, at most `limit`, for the waiting-owner email.
 * mongo makes the pre-step-2 `find(..).select(..).sort({ nudgedAt: -1 })
 * .limit().lean()`. dual and pg-read read Mongo (findPageMongo, ties on
 * nudgedAt broken by _id): the answer decides who is emailed. pg refuses.
 */
export async function findNewestOpenEpisodes(limit: number): Promise<Doc[]> {
  if (storeMode(NAME) === 'mongo') {
    return StalledConnectEpisode.find({ status: 'open' }).select(WAITING_FIELDS)
      .sort({ nudgedAt: -1 }).limit(limit).lean() as unknown as Promise<Doc[]>;
  }
  return stalledConnectEpisodeStore().findPageMongo({ status: 'open' }, {
    sort: { nudgedAt: -1 }, limit, fields: fieldList(WAITING_FIELDS),
  });
}

/**
 * The message-id fields of every episode that has one set as a non-empty
 * string, for the author-kind backfill script. mongo makes the pre-step-2
 * `find(mongoFilter).select(fields).lean()`, with the script's own filter (a
 * `$type: 'string'` test per field). dual and pg-read read Mongo, still the
 * system of record, but the helper's Mongo filters have no `$type`: they read
 * every episode where a field is neither missing, null nor '' (`$nin`), a
 * superset, and keep the rows where one is a non-empty string, which is the
 * same set. pg refuses.
 */
export async function findEpisodeMessageFields(
  mongoFilter: Doc, fields: readonly string[],
): Promise<Doc[]> {
  if (storeMode(NAME) === 'mongo') {
    return StalledConnectEpisode.find(mongoFilter).select(fields.join(' ')).lean() as unknown as Promise<Doc[]>;
  }
  const rows = await readAllMongo({ $or: fields.map((field) => ({ [field]: { $nin: [null, ''] } })) }, [...fields]);
  return rows.filter((row) => fields.some((field) => typeof row[field] === 'string' && row[field] !== ''));
}
