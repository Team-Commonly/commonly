import { listeningIntroFrom } from './installIntroCopy';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MongoMessage = require('../models/Message');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');

/**
 * F576: the install intro of a seat nothing runs yet says so, "As I post this,
 * nothing is running me yet ... it never updates". On a BYO seat the agent
 * connects a minute later, and its first turn read that sentence in the pod
 * and opened by correcting it. So the first time the seat listens, its
 * state-scoped intro in each of its pods is rewritten, in place, to the
 * composer's listening arm, and every open client gets the new text over
 * `messageUpdated`.
 *
 * Ordering: the caller awaits this before the check-in that is the seat's
 * first listen returns (the events poll, a renew, or the WebSocket connect),
 * so the first event the seat can claim is delivered after the rewrite and
 * its turn reads the new text. A plain MCP seat never polls, so its intro
 * stays as posted, which is true for it.
 *
 * Best-effort and bounded: a failure or a slow database logs and lets the
 * check-in through. A listen is never refused over its intro.
 */

export const INTRO_SETTLE_TIMEOUT_MS = 2000;
const INTRO_KIND = 'install-intro';
const LISTENING = 'listening';
// One intro per install, so a seat has about as many as it has pods.
const INTRO_SCAN_LIMIT = 200;

type TokenRecord = { tokenHash?: unknown; lastListenedAt?: unknown };

/**
 * Whether this check-in is the token's first listen, read from the records
 * already loaded to authenticate it: the token is on file and no copy of it
 * has a `lastListenedAt`. A token on no list (a spawn child) is never first,
 * and once the stamp lands every later check-in answers false for free.
 */
export const isFirstListen = (tokenHash: unknown, tokenLists: unknown[]): boolean => {
  if (typeof tokenHash !== 'string' || !tokenHash) return false;
  const records = tokenLists
    .flatMap((list) => (Array.isArray(list) ? list as TokenRecord[] : []))
    .filter((record) => record?.tokenHash === tokenHash);
  return records.length > 0 && records.every((record) => !record.lastListenedAt);
};

type Rewrite = { messageId: string; podId: string; content: string; payload: Record<string, unknown> };

const emitUpdated = (rewrite: Rewrite): void => {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const io = require('../config/socket').getIO();
    io?.to(`pod_${rewrite.podId}`).emit('messageUpdated', rewrite);
  } catch (err) {
    console.warn('[install-intro] messageUpdated emit failed:', (err as Error).message);
  }
};

const asPayload = (payload: unknown): Record<string, unknown> => {
  if (typeof payload === 'string') {
    try { return JSON.parse(payload) || {}; } catch { return {}; }
  }
  return payload && typeof payload === 'object' ? { ...(payload as Record<string, unknown>) } : {};
};

const rewritePg = async (pool: any, agentUserId: string, podIds: string[]): Promise<Rewrite[]> => {
  const placeholders = podIds.map((_, i) => `$${i + 2}`).join(', ');
  const found = await pool.query(
    `SELECT id, pod_id, content, payload FROM messages
     WHERE user_id = $1 AND author_kind = 'kernel' AND payload->>'kind' = '${INTRO_KIND}'
       AND pod_id IN (${placeholders})
     ORDER BY id DESC LIMIT ${INTRO_SCAN_LIMIT}`,
    [agentUserId, ...podIds],
  );
  const done: Rewrite[] = [];
  for (const row of found.rows || []) {
    const payload = asPayload(row.payload);
    if (payload.kind !== INTRO_KIND || payload.introState === LISTENING) continue;
    const content = listeningIntroFrom(row.content);
    if (!content) continue;
    const next = { ...payload, introState: LISTENING };
    // Guarded on the marker, so two replicas settling at once write it once.
    // eslint-disable-next-line no-await-in-loop
    const updated = await pool.query(
      `UPDATE messages SET content = $1, payload = $2, summary = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND content = $4 RETURNING id`,
      [content, JSON.stringify(next), row.id, row.content],
    );
    if (updated.rows?.length) {
      done.push({ messageId: String(row.id), podId: String(row.pod_id), content, payload: next });
    }
  }
  return done;
};

const rewriteMongo = async (agentUserId: string, podIds: string[]): Promise<Rewrite[]> => {
  const rows = await MongoMessage.find({
    userId: agentUserId, authorKind: 'kernel', 'payload.kind': INTRO_KIND, podId: { $in: podIds },
  }).select('_id podId content payload').lean();
  const done: Rewrite[] = [];
  for (const row of rows || []) {
    const payload = asPayload(row.payload);
    if (payload.introState === LISTENING) continue;
    const content = listeningIntroFrom(row.content);
    if (!content) continue;
    const next = { ...payload, introState: LISTENING };
    // eslint-disable-next-line no-await-in-loop
    const result = await MongoMessage.updateOne(
      { _id: row._id, content: row.content },
      { $set: { content, payload: next } },
    );
    if (result?.modifiedCount) {
      done.push({ messageId: String(row._id), podId: String(row.podId), content, payload: next });
    }
  }
  return done;
};

const settle = async ({ agentUserId, agentName, instanceId, podIds }: SettleOptions): Promise<number> => {
  const pods = [...new Set((podIds || []).map((id) => String(id || '')).filter(Boolean))];
  if (!pods.length) return 0;
  let userId = agentUserId ? String(agentUserId) : '';
  if (!userId && agentName) {
    const bot = await User.findOne({
      isBot: true, 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId || 'default',
    }).select('_id').lean();
    userId = bot?._id ? String(bot._id) : '';
  }
  if (!userId) return 0;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg');
  const rewrites = pool && process.env.PG_HOST
    ? await rewritePg(pool, userId, pods)
    : await rewriteMongo(userId, pods);
  rewrites.forEach(emitUpdated);
  return rewrites.length;
};

type SettleOptions = {
  agentUserId?: unknown;
  agentName?: string;
  instanceId?: string;
  podIds: unknown[];
};

/**
 * The HTTP check-in's half: first listen read from what `agentRuntimeAuth`
 * loaded (the bot's token list, and every active install's), then the
 * rewrite across the seat's installed pods. Awaited by the caller.
 */
export async function settleIntroOnRequestCheckIn(req: any): Promise<void> {
  const installs = Array.isArray(req?.agentInstallations) ? req.agentInstallations : [];
  const lists = [req?.agentUser?.agentRuntimeTokens, ...installs.map((i: any) => i?.runtimeTokens)];
  if (!isFirstListen(req?.agentTokenHash, lists)) return;
  await settleInstallIntroOnFirstListen({
    agentUserId: req?.agentUser?._id,
    agentName: req?.agentInstallation?.agentName,
    instanceId: req?.agentInstallation?.instanceId,
    podIds: installs.map((i: any) => i?.podId),
  });
}

/** Rewrite the seat's state-scoped intros; never throws, never waits past the bound. */
export async function settleInstallIntroOnFirstListen(options: SettleOptions): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settle(options),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          console.warn('[install-intro] first-listen rewrite timed out; the check-in continues');
          resolve(0);
        }, INTRO_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn('[install-intro] first-listen rewrite failed:', (err as Error).message);
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
