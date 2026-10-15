/**
 * Per-user daily spend alarm (TASK-263, ADR-023 amendment A3).
 *
 * Native and hosted turns run on our model account, and the hosted sandbox
 * (E2B, TASK-266) has no spending cap of its own, so this sweep is what
 * notices one person costing more than the plan assumes. It prices each
 * user's AgentRun turns for the current UTC day and, past
 * SPEND_ALARM_USD_PER_DAY (default 2), logs one structured line per user per
 * day. A log-based metric turns that line into a page (k8s/monitoring).
 *
 * It reports and never blocks. The per-user run ceiling and the per-install
 * cap are the enforcement; a guard here that failed closed would silence
 * agents over a pricing-table typo.
 *
 * Sandbox seconds join the sum when TASK-266 records them on the AgentRun.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentRun = require('../models/AgentRun');

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

// Cache-miss input prices, so the estimate errs high.
//   DeepSeek V4.1 Flash (what `deepseek-v4-flash` is served and billed as):
//     api-docs.deepseek.com/quick_start/pricing, last modified 2026-09-24.
//   Claude Sonnet 5: platform.claude.com/docs/en/about-claude/pricing,
//     read 2026-10-15.
const PRICES: { match: RegExp; price: ModelPrice }[] = [
  { match: /deepseek/i, price: { input: 0.3, output: 1.2 } },
  { match: /sonnet/i, price: { input: 2, output: 10 } },
];

// A model with no row is charged at a deliberately high rate, so a new route
// over-alarms instead of hiding behind a zero. 14 days of production turns
// (to 2026-10-15) recorded one model, deepseek-v4-flash, so this rate does
// not fire on today's traffic.
export const UNPRICED_MODEL: ModelPrice = { input: 15, output: 75 };

export const priceForModel = (model: string | null | undefined): ModelPrice => (
  PRICES.find((row) => row.match.test(String(model || '')))?.price || UNPRICED_MODEL
);

// The sandbox's price per second it runs. E2B bills by resource:
// $0.000014 per vCPU-second and $0.0000045 per GiB-second (e2b.dev/pricing,
// read 2026-10-15). The template is pinned (turnSandboxService
// SANDBOX_TEMPLATE); its shape is priced at 2 vCPU and 4 GiB, E2B's stated
// default and the larger of the shapes on record for it (Rhea cites 2 GiB for
// the code-interpreter build), so the alarm errs high. E2B has no spending cap,
// so the seconds each turn records (AgentRun.sandboxSeconds) are priced here.
const E2B_USD_PER_VCPU_SECOND = 0.000014;
const E2B_USD_PER_GIB_SECOND = 0.0000045;
const SANDBOX_SHAPE = { vcpu: 2, gib: 4 };
export const SANDBOX_USD_PER_SECOND = SANDBOX_SHAPE.vcpu * E2B_USD_PER_VCPU_SECOND
  + SANDBOX_SHAPE.gib * E2B_USD_PER_GIB_SECOND;

export const spendThresholdUsd = (): number => {
  const raw = Number(process.env.SPEND_ALARM_USD_PER_DAY);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
};

export interface UserSpend {
  userId: string;
  usd: number;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  sandboxSeconds: number;
}

const utcDayStart = (now: Date): Date => {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
};

/** Every user's priced model spend for the UTC day containing `now`. */
export const userSpendForDay = async (now: Date = new Date()): Promise<UserSpend[]> => {
  const rows = await AgentRun.aggregate([
    { $match: { startedAt: { $gte: utcDayStart(now), $lte: now }, userId: { $ne: null } } },
    { $unwind: '$turns' },
    {
      $group: {
        _id: { userId: '$userId', model: '$turns.model' },
        runs: { $addToSet: '$_id' },
        promptTokens: { $sum: { $ifNull: ['$turns.promptTokens', 0] } },
        completionTokens: { $sum: { $ifNull: ['$turns.completionTokens', 0] } },
        // A turn with no split is priced as all output, the expensive side.
        unsplitTokens: {
          $sum: {
            $cond: [
              { $and: [{ $eq: [{ $ifNull: ['$turns.promptTokens', null] }, null] },
                { $eq: [{ $ifNull: ['$turns.completionTokens', null] }, null] }] },
              { $ifNull: ['$turns.totalTokens', 0] },
              0,
            ],
          },
        },
      },
    },
  ]) as {
    _id: { userId: unknown; model?: string };
    runs: unknown[];
    promptTokens: number;
    completionTokens: number;
    unsplitTokens: number;
  }[];

  // Sandbox seconds sit on the run, not the turn, so they are summed apart from
  // the per-turn unwind above (which would count each run once per turn).
  const sandboxRows = await AgentRun.aggregate([
    {
      $match: {
        startedAt: { $gte: utcDayStart(now), $lte: now }, userId: { $ne: null }, sandboxSeconds: { $gt: 0 },
      },
    },
    { $group: { _id: '$userId', seconds: { $sum: '$sandboxSeconds' }, runs: { $addToSet: '$_id' } } },
  ]) as { _id: unknown; seconds: number; runs: unknown[] }[];

  const byUser = new Map<string, UserSpend & { runIds: Set<string> }>();
  for (const row of rows) {
    const userId = String(row._id.userId);
    const price = priceForModel(row._id.model);
    const completion = row.completionTokens + row.unsplitTokens;
    const usd = (row.promptTokens * price.input + completion * price.output) / 1_000_000;
    const entry = byUser.get(userId) || {
      userId, usd: 0, runs: 0, promptTokens: 0, completionTokens: 0, sandboxSeconds: 0, runIds: new Set<string>(),
    };
    entry.usd += usd;
    entry.promptTokens += row.promptTokens;
    entry.completionTokens += completion;
    row.runs.forEach((id) => entry.runIds.add(String(id)));
    byUser.set(userId, entry);
  }
  for (const row of sandboxRows) {
    const userId = String(row._id);
    const entry = byUser.get(userId) || {
      userId, usd: 0, runs: 0, promptTokens: 0, completionTokens: 0, sandboxSeconds: 0, runIds: new Set<string>(),
    };
    entry.sandboxSeconds += row.seconds;
    entry.usd += row.seconds * SANDBOX_USD_PER_SECOND;
    row.runs.forEach((id) => entry.runIds.add(String(id)));
    byUser.set(userId, entry);
  }
  return [...byUser.values()].map(({ runIds, ...spend }) => ({ ...spend, runs: runIds.size }));
};

// The alarm also pages SRE in a pod, alongside Sam's email from the log-based
// policy (Cofounder, 2026-10-15). One system message per fresh alarm goes to
// SPEND_ALARM_POD_ID, a private invite-only pod with no agent members, and
// names SPEND_ALARM_MENTION so it lands in that account's inbox. It is posted
// as the dedicated commonly-bot/spend-alarm identity through
// AgentMessageService._postToTarget, which does not join the poster to the
// pod; postMessage would (ensureAgentInPod). getOrCreateAgentUser refuses a
// username a person holds (TASK-133), so the post cannot appear as someone
// else. Unset pod id means no post. The page never blocks the log line or
// another user's alarm.
const PAGE_IDENTITY = { agentName: 'commonly-bot', instanceId: 'spend-alarm', displayName: 'Spend alarm' };

export const composeSpendPage = (
  { spend, username, day, threshold, mention }:
  { spend: UserSpend; username?: string; day: string; threshold: number; mention?: string },
): string => {
  // A username is user-chosen with no charset or length limit, and this text
  // lands in an inbox an SRE model session reads. Render it as an identifier
  // only, so a name cannot carry a newline, an @mention or instructions into
  // a trusted alarm. The userId stays the key either way.
  const name = String(username || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  const who = name ? `${name} (${spend.userId})` : spend.userId;
  const handle = mention ? ` @${mention}` : '';
  return `[spend alarm] ${who} spent $${spend.usd.toFixed(2)} on ${day} UTC, over the $${threshold} daily line, `
    + `across ${spend.runs} run${spend.runs === 1 ? '' : 's'}.${handle}`;
};

const pageSre = async (content: string): Promise<void> => {
  const podId = String(process.env.SPEND_ALARM_POD_ID || '').trim();
  if (!podId) return;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentIdentityService = require('./agentIdentityService');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  const agentUser = await AgentIdentityService.getOrCreateAgentUser(PAGE_IDENTITY.agentName, {
    instanceId: PAGE_IDENTITY.instanceId,
    displayName: PAGE_IDENTITY.displayName,
  });
  await AgentMessageService._postToTarget({
    ...PAGE_IDENTITY,
    podId,
    content,
    messageType: 'system',
    metadata: { source: 'spend-alarm' },
    agentUser,
    skipDeliveryUpdate: true,
    skipSummaryPersistence: true,
  });
};

// One line per user per UTC day. In memory only: after a restart a user still
// over the line is logged once more, which pages nothing new (the alert is
// already open for that day) and costs one log line.
const alarmed = new Set<string>();

/**
 * Logs `{ alarm: 'user_spend', ... }` for each user over the threshold today,
 * once per user per day. Returns the users it logged this pass.
 */
export const checkSpend = async (now: Date = new Date()): Promise<UserSpend[]> => {
  const threshold = spendThresholdUsd();
  const day = utcDayStart(now).toISOString().slice(0, 10);
  const over = (await userSpendForDay(now)).filter((spend) => spend.usd >= threshold);
  const fresh = over.filter((spend) => !alarmed.has(`${day}:${spend.userId}`));
  // Name each user in the line, so whoever is paged sees who without a lookup
  // (Cofounder, 2026-10-15). A failed lookup still logs the id.
  const usernames = new Map<string, string>();
  if (fresh.length) {
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const User = require('../models/User');
      const ids = fresh.map((spend) => spend.userId).filter((id) => /^[a-f\d]{24}$/i.test(id));
      const users = await User.find({ _id: { $in: ids } }).select('username').lean();
      users.forEach((user: { _id: unknown; username?: string }) => {
        if (user.username) usernames.set(String(user._id), user.username);
      });
    } catch (error) {
      console.warn('[spend-alarm] username lookup failed; logging ids only:', (error as Error).message);
    }
  }
  for (const spend of fresh) {
    alarmed.add(`${day}:${spend.userId}`);
    console.warn(JSON.stringify({
      alarm: 'user_spend',
      day,
      userId: spend.userId,
      ...(usernames.has(spend.userId) ? { username: usernames.get(spend.userId) } : {}),
      usd: Number(spend.usd.toFixed(4)),
      thresholdUsd: threshold,
      runs: spend.runs,
      promptTokens: spend.promptTokens,
      completionTokens: spend.completionTokens,
      sandboxSeconds: spend.sandboxSeconds,
    }));
    try {
      await pageSre(composeSpendPage({
        spend,
        username: usernames.get(spend.userId),
        day,
        threshold,
        mention: String(process.env.SPEND_ALARM_MENTION || '').trim() || undefined,
      }));
    } catch (error) {
      console.warn(`[spend-alarm] SRE page failed for ${spend.userId}; the log line stands:`, (error as Error).message);
    }
  }
  return fresh;
};

/** Test seam: forget which users were already logged. */
export const resetSpendAlarmMemory = (): void => { alarmed.clear(); };
