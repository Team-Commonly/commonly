/**
 * ADR-037 §3 (F654): the hand-back record store (0029_hand_backs.sql).
 * Domain operations only, returning plain records; callers never see SQL.
 *
 * Every state change goes through `transition`, one compare-and-set:
 * `UPDATE hand_backs SET ... WHERE id = $1 AND status = $expected RETURNING *`.
 * No row back means another writer won, and the service answers stale_state.
 * Without a pool (no PG_HOST) there is no store: writes refuse with
 * `hand_back_store_unavailable` and reads find nothing.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

const loadPool = (): PgPool | null => (require('../config/db-pg') as { pool: PgPool | null }).pool;

export type HandBackStatus =
  | 'plan_sent' | 'plan_accepted' | 'plan_refused' | 'handed_back' | 'accepted' | 'refused' | 'withdrawn';

export const OPEN_STATUSES: HandBackStatus[] = ['plan_sent', 'plan_accepted', 'handed_back'];

export interface HandBackRuling {
  verdict: 'Accept' | 'Refuse';
  reason: string;
  byUserId: string;
  at: string;
}

export interface HandBackRecord {
  id: string;
  podId: string;
  threadRootId: string | null;
  taskId: string | null;
  authorAgentUserId: string;
  agentName: string;
  instanceId: string;
  ownerInstalledBy: string | null;
  ownerUserId: string | null;
  asked: {
    text: string;
    requesterUserId: string;
    requesterAgentUserId?: string;
    provenance: 'message' | 'task' | 'owner';
    sourceMessageId?: string;
  };
  reviewerUserId: string;
  plan: { text: string };
  planDecisionId: string | null;
  planRuling: HandBackRuling | null;
  next: { agentUserId: string | null; agentName: string; instanceId: string } | null;
  changed: Array<{ kind: string; ref: string; note?: string }> | null;
  checked: Array<{ what: string; how: string }> | null;
  unverified: Array<{ what: string; why?: string }> | null;
  handbackDecisionId: string | null;
  handbackRuling: HandBackRuling | null;
  supersedes: string | null;
  status: HandBackStatus;
  withdrawnBy: { kind: 'agent' | 'owner'; userId: string; reason?: string } | null;
  createdAt: Date;
  updatedAt: Date;
  planRuledAt: Date | null;
  handedBackAt: Date | null;
  ruledAt: Date | null;
  withdrawnAt: Date | null;
  receivedEnqueuedAt: Date | null;
}

const json = (value: unknown): unknown => {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
};
const date = (value: unknown): Date | null => (value == null ? null : new Date(value as string));

const toRecord = (row: any): HandBackRecord => ({
  id: row.id,
  podId: row.pod_id,
  threadRootId: row.thread_root_id ?? null,
  taskId: row.task_id ?? null,
  authorAgentUserId: row.author_agent_user_id,
  agentName: row.agent_name,
  instanceId: row.instance_id,
  ownerInstalledBy: row.owner_installed_by ?? null,
  ownerUserId: row.owner_user_id ?? null,
  asked: json(row.asked) as HandBackRecord['asked'],
  reviewerUserId: row.reviewer_user_id,
  plan: json(row.plan) as HandBackRecord['plan'],
  planDecisionId: row.plan_decision_id ?? null,
  planRuling: json(row.plan_ruling) as HandBackRuling | null,
  next: json(row.next) as HandBackRecord['next'],
  changed: json(row.changed) as HandBackRecord['changed'],
  checked: json(row.checked) as HandBackRecord['checked'],
  unverified: json(row.unverified) as HandBackRecord['unverified'],
  handbackDecisionId: row.handback_decision_id ?? null,
  handbackRuling: json(row.handback_ruling) as HandBackRuling | null,
  supersedes: row.supersedes ?? null,
  status: row.status,
  withdrawnBy: json(row.withdrawn_by) as HandBackRecord['withdrawnBy'],
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  planRuledAt: date(row.plan_ruled_at),
  handedBackAt: date(row.handed_back_at),
  ruledAt: date(row.ruled_at),
  withdrawnAt: date(row.withdrawn_at),
  receivedEnqueuedAt: date(row.received_enqueued_at),
});

export const isAvailable = (): boolean => Boolean(loadPool());

const requirePool = (): PgPool => {
  const pool = loadPool();
  if (!pool) {
    throw Object.assign(new Error('Hand-backs need PostgreSQL'), { code: 'hand_back_store_unavailable', status: 503 });
  }
  return pool;
};

/** The plan-send insert. Status is always plan_sent; the card id comes after. */
export const insertPlan = async (row: {
  id: string; podId: string; threadRootId: string | null; taskId: string | null;
  authorAgentUserId: string; agentName: string; instanceId: string;
  ownerInstalledBy: string | null; ownerUserId: string | null;
  asked: HandBackRecord['asked']; reviewerUserId: string; plan: { text: string };
  next: HandBackRecord['next']; supersedes: string | null; now: Date;
}): Promise<HandBackRecord> => {
  const { rows } = await requirePool().query(
    `INSERT INTO hand_backs (id, pod_id, thread_root_id, task_id, author_agent_user_id, agent_name, instance_id,
       owner_installed_by, owner_user_id, asked, reviewer_user_id, plan, next, supersedes, status,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'plan_sent', $15, $15)
     RETURNING *`,
    [row.id, row.podId, row.threadRootId, row.taskId, row.authorAgentUserId, row.agentName, row.instanceId,
      row.ownerInstalledBy, row.ownerUserId, JSON.stringify(row.asked), row.reviewerUserId,
      JSON.stringify(row.plan), row.next ? JSON.stringify(row.next) : null, row.supersedes, row.now],
  );
  return toRecord(rows[0]);
};

/** Undo a plan-send whose card was never posted. Only a card-less plan_sent row. */
export const deleteUnposted = async (id: string): Promise<void> => {
  await requirePool().query(
    "DELETE FROM hand_backs WHERE id = $1 AND status = 'plan_sent' AND plan_decision_id IS NULL",
    [id],
  );
};

export const findById = async (id: string): Promise<HandBackRecord | null> => {
  const pool = loadPool();
  if (!pool || typeof id !== 'string' || !id) return null;
  const { rows } = await pool.query('SELECT * FROM hand_backs WHERE id = $1', [id]);
  return rows[0] ? toRecord(rows[0]) : null;
};

/** Several records of one pod by id (a card whose record is past the newest page). */
export const findByIds = async (podId: string, ids: string[]): Promise<HandBackRecord[]> => {
  const pool = loadPool();
  const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id))].slice(0, 100);
  if (!pool || !wanted.length) return [];
  const { rows } = await pool.query(
    'SELECT * FROM hand_backs WHERE pod_id = $1 AND id = ANY($2::text[]) ORDER BY created_at DESC',
    [podId, wanted],
  );
  return rows.map(toRecord);
};

export const listForPod = async (podId: string, limit = 50): Promise<HandBackRecord[]> => {
  const pool = loadPool();
  if (!pool) return [];
  const { rows } = await pool.query(
    'SELECT * FROM hand_backs WHERE pod_id = $1 ORDER BY created_at DESC LIMIT $2',
    [podId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(toRecord);
};

/**
 * What the reconcile sweep reads: records waiting on a card, and records
 * withdrawn recently enough that their card might still be pending.
 */
export const listForReconcile = async (withdrawnSince: Date, limit = 200): Promise<HandBackRecord[]> => {
  const pool = loadPool();
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT * FROM hand_backs
      WHERE status IN ('plan_sent', 'handed_back')
         OR (status = 'withdrawn' AND withdrawn_at >= $1)
      ORDER BY updated_at ASC LIMIT $2`,
    [withdrawnSince, limit],
  );
  return rows.map(toRecord);
};

/**
 * Accepted records whose next agent was never told: handback.received was not
 * stamped as queued. Only records ruled before `ruledBefore`, so the sweep
 * leaves the ruling's own writer time to stamp its enqueue.
 */
export const listReceivedPending = async (ruledBefore: Date, limit = 100): Promise<HandBackRecord[]> => {
  const pool = loadPool();
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT * FROM hand_backs
      WHERE status = 'accepted' AND next IS NOT NULL AND received_enqueued_at IS NULL AND ruled_at < $1
      ORDER BY ruled_at ASC LIMIT $2`,
    [ruledBefore, limit],
  );
  return rows.map(toRecord);
};

/** Stamp handback.received as queued, once. False when it was already stamped. */
export const markReceivedEnqueued = async (id: string, now: Date): Promise<boolean> => {
  const { rows } = await requirePool().query(
    `UPDATE hand_backs SET received_enqueued_at = $2
      WHERE id = $1 AND received_enqueued_at IS NULL RETURNING id`,
    [id, now],
  );
  return rows.length > 0;
};

// The columns a transition may set, and how each is written.
const SETTABLE: Record<string, 'text' | 'json' | 'time'> = {
  plan_decision_id: 'text',
  plan_ruling: 'json',
  plan_ruled_at: 'time',
  changed: 'json',
  checked: 'json',
  unverified: 'json',
  handback_decision_id: 'text',
  handed_back_at: 'time',
  handback_ruling: 'json',
  ruled_at: 'time',
  withdrawn_by: 'json',
  withdrawn_at: 'time',
};

/**
 * The one way a record changes: a compare-and-set on its status, and
 * optionally on a column still being NULL or equal to a value (a ruling's
 * copy names its card). Null means another writer got there first.
 */
export const transition = async (input: {
  id: string;
  from: HandBackStatus | HandBackStatus[];
  to: HandBackStatus;
  set?: Record<string, unknown>;
  where?: Record<string, string | null>;
  now: Date;
}): Promise<HandBackRecord | null> => {
  const values: unknown[] = [input.id, input.to, input.now];
  const sets = ['status = $2', 'updated_at = $3'];
  Object.entries(input.set || {}).forEach(([column, value]) => {
    const kind = SETTABLE[column];
    if (!kind) throw new Error(`hand_backs.${column} is not settable`);
    values.push(kind === 'json' && value != null ? JSON.stringify(value) : value);
    sets.push(`${column} = $${values.length}`);
  });
  const from = Array.isArray(input.from) ? input.from : [input.from];
  const fromParams = from.map((status) => { values.push(status); return `$${values.length}`; });
  const conditions = ['id = $1', `status IN (${fromParams.join(', ')})`];
  Object.entries(input.where || {}).forEach(([column, value]) => {
    if (!['plan_decision_id', 'handback_decision_id'].includes(column)) {
      throw new Error(`hand_backs.${column} is not a transition condition`);
    }
    if (value === null) {
      conditions.push(`${column} IS NULL`);
    } else {
      values.push(value);
      conditions.push(`${column} = $${values.length}`);
    }
  });
  const { rows } = await requirePool().query(
    `UPDATE hand_backs SET ${sets.join(', ')} WHERE ${conditions.join(' AND ')} RETURNING *`,
    values,
  );
  return rows[0] ? toRecord(rows[0]) : null;
};

/**
 * Attach the plan card to a just-sent record, whatever its status: a record
 * withdrawn while its card was being posted still learns the card, so the
 * card can be closed. Null only when a card is already attached.
 */
export const attachPlanDecision = async (id: string, decisionId: string, now: Date): Promise<HandBackRecord | null> => {
  const { rows } = await requirePool().query(
    `UPDATE hand_backs SET plan_decision_id = $2, updated_at = $3
      WHERE id = $1 AND plan_decision_id IS NULL RETURNING *`,
    [id, decisionId, now],
  );
  return rows[0] ? toRecord(rows[0]) : null;
};

/** Attach the result card to a just-handed-back record; a withdrawn one too (as above). */
export const attachHandbackDecision = async (
  id: string, decisionId: string, now: Date,
): Promise<HandBackRecord | null> => {
  const { rows } = await requirePool().query(
    `UPDATE hand_backs SET handback_decision_id = $2, updated_at = $3
      WHERE id = $1 AND handback_decision_id IS NULL RETURNING *`,
    [id, decisionId, now],
  );
  return rows[0] ? toRecord(rows[0]) : null;
};

export default {
  isAvailable, insertPlan, deleteUnposted, findById, findByIds, listForPod, listForReconcile, listReceivedPending,
  markReceivedEnqueued, transition, attachPlanDecision, attachHandbackDecision, OPEN_STATUSES,
};
module.exports = {
  isAvailable, insertPlan, deleteUnposted, findById, findByIds, listForPod, listForReconcile, listReceivedPending,
  markReceivedEnqueued, transition, attachPlanDecision, attachHandbackDecision, OPEN_STATUSES,
};
