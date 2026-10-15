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
  for (const spend of fresh) {
    alarmed.add(`${day}:${spend.userId}`);
    console.warn(JSON.stringify({
      alarm: 'user_spend',
      day,
      userId: spend.userId,
      usd: Number(spend.usd.toFixed(4)),
      thresholdUsd: threshold,
      runs: spend.runs,
      promptTokens: spend.promptTokens,
      completionTokens: spend.completionTokens,
      sandboxSeconds: spend.sandboxSeconds,
    }));
  }
  return fresh;
};

/** Test seam: forget which users were already logged. */
export const resetSpendAlarmMemory = (): void => { alarmed.clear(); };
