import { Types } from 'mongoose';
import AgentDigestState from '../models/AgentDigestState';
import {
  createDualStore, pgTableAdapter, storeMode, type DualStore,
} from './dualStore';

type Doc = Record<string, unknown>;

/** One seat in one pod: the model's unique key. */
export type DigestScope = { agentName: string; instanceId: string; podId: unknown };
export type DigestConversation = { label: string; count: number };

/** What the fold needs to compute its next change. */
export type FoldState = {
  foldedThroughId: unknown;
  unreadCount: number;
  conversations: DigestConversation[];
  otherCount: number;
};

/** The unread summary a wake carries. */
export type UnreadDigest = {
  unreadCount: number;
  lastEventIds: string[];
  revision: number;
  conversations: DigestConversation[];
  otherCount: number;
};

/** One fold step: the event folded in, and the fold's recomputed fields. */
export type FoldChange = {
  foldedThroughId: unknown;
  eventId: string;
  conversations: DigestConversation[];
  otherCount: number;
  /** Set only when the state had nothing unread; otherwise left as it is. */
  unreadSince?: Date;
  /** lastEventIds keeps only this many, newest last. */
  keepLastIds: number;
};

const NAME = 'AgentDigestState';

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('agent_digest_states: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

const conversationsOf = (value: unknown): DigestConversation[] => (Array.isArray(value) ? value : [])
  .map((item: { label?: string; count?: number }) => ({ label: item?.label ?? null, count: item?.count ?? null }) as
    unknown as DigestConversation);
const objectIdOrNull = (value: unknown): Types.ObjectId | null => (
  value == null ? null : new Types.ObjectId(String(value)));

let store: DualStore | undefined;

/**
 * ADR-034 step 2 for the folded digest state, selected by
 * STORE_MODE_AGENT_DIGEST_STATE. Table: config/migrations/0018_agent_digest_states.sql.
 * Built on first use outside mongo, so mongo mode loads nothing new.
 */
export function digestStateStore(): DualStore {
  store ??= createDualStore({
    name: NAME,
    model: AgentDigestState,
    pg: pgTableAdapter({
      pool: lazyPool,
      table: 'agent_digest_states',
      idColumn: 'id',
      columns: ['agent_name', 'instance_id', 'pod_id', 'unread_count', 'revision', 'last_event_ids',
        'conversations', 'other_count', 'unread_since', 'folded_through_id', 'created_at', 'updated_at'],
      jsonColumns: ['last_event_ids', 'conversations'],
    }),
    filterColumns: {
      _id: 'id',
      agentName: 'agent_name',
      instanceId: 'instance_id',
      podId: 'pod_id',
      unreadCount: 'unread_count',
      revision: 'revision',
      unreadSince: 'unread_since',
      foldedThroughId: 'folded_through_id',
    },
    toRow: (doc) => ({
      id: String(doc._id),
      agent_name: doc.agentName,
      instance_id: doc.instanceId,
      pod_id: String(doc.podId),
      unread_count: doc.unreadCount ?? 0,
      revision: doc.revision ?? 0,
      last_event_ids: Array.isArray(doc.lastEventIds) ? doc.lastEventIds.map(String) : [],
      conversations: conversationsOf(doc.conversations),
      other_count: doc.otherCount ?? 0,
      unread_since: doc.unreadSince ?? null,
      folded_through_id: doc.foldedThroughId == null ? null : String(doc.foldedThroughId),
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    }),
    // The plain shape a lean Mongo read returns: ObjectIds, Dates, null where Mongo keeps null.
    fromRow: (row) => ({
      _id: new Types.ObjectId(String(row.id)),
      agentName: row.agent_name,
      instanceId: row.instance_id,
      podId: new Types.ObjectId(String(row.pod_id)),
      unreadCount: Number(row.unread_count),
      revision: Number(row.revision),
      lastEventIds: Array.isArray(row.last_event_ids) ? row.last_event_ids.map(String) : [],
      conversations: conversationsOf(row.conversations),
      otherCount: Number(row.other_count),
      unreadSince: row.unread_since == null ? null : new Date(row.unread_since as string),
      foldedThroughId: objectIdOrNull(row.folded_through_id),
      ...(row.created_at == null ? {} : { createdAt: new Date(row.created_at as string) }),
      ...(row.updated_at == null ? {} : { updatedAt: new Date(row.updated_at as string) }),
    }),
  });
  return store;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number })?.code === 11000;

// Writes the helper has no single-statement Postgres form for yet.
const refuseInPg = (operation: string): void => {
  if (storeMode(NAME) === 'pg') {
    throw new Error(`dual-store: ${NAME} ${operation} is not supported in pg mode until step 4`
      + ' (docs/runbooks/adr-034-model-move.md)');
  }
};

/** The fold's read of a scope's state, or null when the scope has none. */
export async function getFoldState(scope: DigestScope): Promise<FoldState | null> {
  const state = storeMode(NAME) === 'mongo'
    ? await AgentDigestState.findOne(scope)
      .select('foldedThroughId unreadCount conversations otherCount').lean() as Doc | null
    : await digestStateStore().findOneWhere(scope);
  if (!state) return null;
  return {
    foldedThroughId: state.foldedThroughId ?? null,
    unreadCount: state.unreadCount as number,
    conversations: (state.conversations as DigestConversation[] | undefined) || [],
    otherCount: (state.otherCount as number | undefined) || 0,
  };
}

/**
 * The scope's first fold: creates its state. True when this call created it,
 * false when the scope already had one (a duplicate key: another worker won).
 */
export async function startFoldState(scope: DigestScope, fields: {
  unreadCount: number; revision: number; lastEventIds: string[]; conversations: DigestConversation[];
  otherCount: number; unreadSince: Date; foldedThroughId: unknown;
}): Promise<boolean> {
  refuseInPg('startFoldState');
  try {
    if (storeMode(NAME) === 'mongo') await AgentDigestState.create({ ...scope, ...fields });
    else await digestStateStore().create({ ...scope, ...fields });
    return true;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return false;
  }
}

/**
 * One fold step, applied only if the scope is still at `expected` (its cursor
 * and unread count): adds one unread, bumps the revision, appends the event id
 * keeping the newest `keepLastIds`, and sets the recomputed fields. True when
 * it applied; false means another writer moved the state first.
 */
export async function advanceFold(
  scope: DigestScope,
  expected: { foldedThroughId: unknown; unreadCount: number },
  change: FoldChange,
): Promise<boolean> {
  const filter = { ...scope, foldedThroughId: expected.foldedThroughId ?? null, unreadCount: expected.unreadCount };
  if (storeMode(NAME) === 'mongo') {
    const result = await AgentDigestState.updateOne(
      filter,
      {
        $inc: { unreadCount: 1, revision: 1 },
        $set: {
          foldedThroughId: change.foldedThroughId,
          conversations: change.conversations,
          otherCount: change.otherCount,
          ...(change.unreadSince !== undefined ? { unreadSince: change.unreadSince } : {}),
        },
        $push: { lastEventIds: { $each: [change.eventId], $slice: -change.keepLastIds } },
      },
    );
    return result.modifiedCount === 1;
  }
  // The same change as update-pipeline stages, whose values the schema does
  // not cast: $inc as $add, the capped $push as $slice over $concatArrays.
  const conversations = change.conversations
    .map(({ label, count }) => ({ label: String(label), count: Number(count) }));
  return digestStateStore().updateWhere(filter, [{
    $set: {
      unreadCount: { $add: [{ $ifNull: ['$unreadCount', 0] }, 1] },
      revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
      foldedThroughId: { $literal: objectIdOrNull(change.foldedThroughId) },
      conversations: { $literal: conversations },
      otherCount: { $literal: Number(change.otherCount) },
      ...(change.unreadSince !== undefined ? { unreadSince: { $literal: new Date(change.unreadSince) } } : {}),
      lastEventIds: {
        $slice: [
          { $concatArrays: [{ $ifNull: ['$lastEventIds', []] }, { $literal: [String(change.eventId)] }] },
          -change.keepLastIds,
        ],
      },
    },
  }]);
}

/** The scope's unread summary, or null when nothing is unread. */
export async function readUnreadDigest(scope: DigestScope): Promise<UnreadDigest | null> {
  const filter = { ...scope, unreadCount: { $gt: 0 } };
  const state = storeMode(NAME) === 'mongo'
    ? await AgentDigestState.findOne(filter)
      .select('unreadCount lastEventIds revision conversations otherCount').lean() as Doc | null
    : await digestStateStore().findOneWhere(filter);
  if (!state) return null;
  return {
    unreadCount: state.unreadCount as number,
    lastEventIds: state.lastEventIds as string[],
    revision: state.revision as number,
    conversations: state.conversations as DigestConversation[],
    otherCount: state.otherCount as number,
  };
}

/**
 * Clears the unread summary a wake has seen, only if the state is still at
 * `revision`, and bumps the revision. A newer fold leaves it in place.
 * The row is zeroed, never deleted.
 */
export async function settleDigest(scope: DigestScope, revision: number): Promise<void> {
  if (storeMode(NAME) === 'mongo') {
    await AgentDigestState.updateOne(
      { ...scope, revision },
      { $set: { unreadCount: 0, lastEventIds: [], conversations: [], otherCount: 0, unreadSince: null },
        $inc: { revision: 1 } },
    );
    return;
  }
  await digestStateStore().updateWhere({ ...scope, revision }, [{
    $set: {
      unreadCount: { $literal: 0 },
      lastEventIds: { $literal: [] },
      conversations: { $literal: [] },
      otherCount: { $literal: 0 },
      unreadSince: { $literal: null },
      revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
    },
  }]);
}

/** Every scope with unread digest since `threshold` or earlier: the unread-digest wake's candidates. */
export async function listDueForWake(threshold: Date): Promise<Array<{
  agentName: string; instanceId: string; podId: unknown; unreadSince: Date;
}>> {
  const filter = { unreadCount: { $gt: 0 }, unreadSince: { $lte: threshold } };
  const states = storeMode(NAME) === 'mongo'
    ? await AgentDigestState.find(filter).select('agentName instanceId podId unreadSince').lean() as Doc[]
    : await digestStateStore().findWhere(filter);
  return states.map((state) => ({
    agentName: state.agentName as string,
    instanceId: state.instanceId as string,
    podId: state.podId,
    unreadSince: state.unreadSince as Date,
  }));
}
