/**
 * TASK-263: the per-user daily spend alarm prices each user's AgentRun turns
 * for the UTC day, per model, and logs one `alarm: user_spend` line per user
 * per day past the threshold. Real AgentRun model on an in-memory Mongo, so
 * the aggregation itself is under test, not a mock of it.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let AgentRun;
let spend;

const NOW = new Date('2026-10-15T15:00:00Z');
const USER_A = new mongoose.Types.ObjectId();
const USER_B = new mongoose.Types.ObjectId();

const run = (userId, turns, startedAt = new Date('2026-10-15T10:00:00Z')) => ({
  podId: new mongoose.Types.ObjectId(),
  agentName: 'maya-agent',
  instanceId: 'default',
  userId,
  trigger: 'mention',
  status: 'succeeded',
  startedAt,
  totalTokens: turns.reduce((sum, t) => sum + (t.totalTokens || 0), 0),
  turns: turns.map((t, i) => ({ turnIndex: i, ...t })),
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentRun = require('../../../models/AgentRun');
  spend = require('../../../services/spendAlarmService');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AgentRun.deleteMany({});
  spend.resetSpendAlarmMemory();
  delete process.env.SPEND_ALARM_USD_PER_DAY;
  jest.restoreAllMocks();
});

describe('userSpendForDay', () => {
  test('prices each model separately and sums a user across runs, for today only', async () => {
    await AgentRun.create([
      // 1M in + 1M out on DeepSeek: $0.30 + $1.20
      run(USER_A, [{ model: 'deepseek-v4-flash', promptTokens: 1_000_000, completionTokens: 1_000_000 }]),
      // 1M out on Sonnet: $10
      run(USER_A, [{ model: 'claude-sonnet-5-5', promptTokens: 0, completionTokens: 1_000_000 }]),
      // yesterday, never counted
      run(USER_A, [{ model: 'deepseek-v4-flash', promptTokens: 9_000_000, completionTokens: 9_000_000 }],
        new Date('2026-10-14T23:59:00Z')),
      run(USER_B, [{ model: 'deepseek-v4-flash', promptTokens: 1000, completionTokens: 1000 }]),
    ]);

    const rows = await spend.userSpendForDay(NOW);
    const a = rows.find((r) => r.userId === String(USER_A));
    const b = rows.find((r) => r.userId === String(USER_B));

    expect(a.usd).toBeCloseTo(11.5, 6);
    expect(a.runs).toBe(2);
    expect(b.usd).toBeCloseTo(0.0015, 6);
  });

  test('an unpriced model is charged at the high rate, and an unsplit turn as all output', async () => {
    await AgentRun.create([
      run(USER_A, [{ model: 'some-new-route', promptTokens: 1_000_000, completionTokens: 0 }]),
      run(USER_B, [{ model: 'deepseek-v4-flash', totalTokens: 1_000_000 }]),
    ]);

    const rows = await spend.userSpendForDay(NOW);
    expect(rows.find((r) => r.userId === String(USER_A)).usd).toBeCloseTo(spend.UNPRICED_MODEL.input, 6);
    expect(rows.find((r) => r.userId === String(USER_B)).usd).toBeCloseTo(1.2, 6);
  });
});

describe('sandbox seconds (TASK-266)', () => {
  test('are priced per run, once, and alone can cross the line', async () => {
    const withSandbox = (userId, seconds, turns) => ({ ...run(userId, turns), sandboxSeconds: seconds });
    await AgentRun.create([
      // 100,000 s of sandbox and a 2-turn run: priced once, not once per turn.
      withSandbox(USER_A, 100_000, [
        { model: 'deepseek-v4-flash', promptTokens: 0, completionTokens: 0 },
        { model: 'deepseek-v4-flash', promptTokens: 0, completionTokens: 0 },
      ]),
      // A run with no turns still costs its sandbox seconds.
      withSandbox(USER_B, 10, []),
    ]);

    const rows = await spend.userSpendForDay(NOW);
    const a = rows.find((r) => r.userId === String(USER_A));
    expect(a.sandboxSeconds).toBe(100_000);
    // Literal, worked by hand: 100,000 s x (2 vCPU x $0.000014 + 4 GiB x $0.0000045).
    expect(a.usd).toBeCloseTo(4.6, 6);
    expect(a.runs).toBe(1);
    expect(rows.find((r) => r.userId === String(USER_B)).sandboxSeconds).toBe(10);
  });
});

describe('the $2 line with sandbox time in it (literal amounts, independent of the exported rate)', () => {
  const alarmLines = (warn) => warn.mock.calls
    .map(([line]) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter((line) => line && line.alarm === 'user_spend');
  const sonnetOut = (tokens) => [{ model: 'claude-sonnet-5-5', promptTokens: 0, completionTokens: tokens }];

  test.each([
    // $1.30 of model output + 20,000 s of sandbox ($0.92) = $2.22: over the line.
    [20_000, 2.22, 1],
    // $1.30 + 15,000 s ($0.69) = $1.99: under it.
    [15_000, 1.99, 0],
  ])('$1.30 of model spend plus %i sandbox seconds is $%f, %i alarm(s)', async (seconds, usd, alarms) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await AgentRun.create({ ...run(USER_A, sonnetOut(130_000)), sandboxSeconds: seconds });
    const [row] = await spend.userSpendForDay(NOW);
    expect(row.usd).toBeCloseTo(usd, 6);
    await spend.checkSpend(NOW);
    expect(alarmLines(warn)).toHaveLength(alarms);
  });
});

describe('checkSpend', () => {
  const alarmLines = (warn) => warn.mock.calls
    .map(([line]) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter((line) => line && line.alarm === 'user_spend');

  test('logs one structured line for a user over $2, once per day, and nothing for one under', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await AgentRun.create([
      run(USER_A, [{ model: 'deepseek-v4-flash', promptTokens: 2_000_000, completionTokens: 2_000_000 }]), // $3
      run(USER_B, [{ model: 'deepseek-v4-flash', promptTokens: 1_000_000, completionTokens: 1_000_000 }]), // $1.50
    ]);

    await spend.checkSpend(NOW);
    await spend.checkSpend(NOW);

    const lines = alarmLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      alarm: 'user_spend', day: '2026-10-15', userId: String(USER_A), usd: 3, thresholdUsd: 2, runs: 1, sandboxSeconds: 0,
    });
  });

  test('SPEND_ALARM_USD_PER_DAY moves the line, and a bad value falls back to $2', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await AgentRun.create(run(USER_B, [{ model: 'deepseek-v4-flash', promptTokens: 1_000_000, completionTokens: 1_000_000 }]));

    process.env.SPEND_ALARM_USD_PER_DAY = 'not-a-number';
    await spend.checkSpend(NOW);
    expect(alarmLines(warn)).toHaveLength(0);

    process.env.SPEND_ALARM_USD_PER_DAY = '1';
    await spend.checkSpend(NOW);
    expect(alarmLines(warn)).toEqual([expect.objectContaining({ userId: String(USER_B), thresholdUsd: 1 })]);
  });
});
