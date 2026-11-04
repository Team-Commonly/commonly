/**
 * F84 — AgentRun content window. Real Mongo (tier 1): the redaction is an
 * aggregation-pipeline update, which an in-process fake can't evaluate.
 *
 * After 30 days a run loses the model's text, each tool call's args, result
 * and error, and its own errorMessage. The row and its metadata stay; nothing
 * is deleted; a dry run changes nothing.
 */
const mongoose = require('mongoose');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const AgentRun = require('../../models/AgentRun');
const { redactExpiredRunContent, RUN_CONTENT_WINDOW_DAYS } = require('../../services/agentRunContentWindow');

jest.setTimeout(60_000);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-04T04:23:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * DAY);

const runAt = (startedAt, extra = {}) => ({
  podId: new mongoose.Types.ObjectId(),
  agentName: 'scout',
  instanceId: 'default',
  trigger: 'mention',
  status: 'failed',
  errorKind: 'tool_error',
  errorMessage: 'calendar_list_events failed: Dentist at 3pm',
  totalTokens: 1200,
  startedAt,
  turns: [
    {
      turnIndex: 0,
      model: 'deepseek-chat',
      servedModel: 'deepseek-chat',
      totalTokens: 1200,
      elapsedMs: 900,
      llmResponseText: 'Your 3pm with the dentist moved to Friday.',
      toolCalls: [
        {
          name: 'calendar_list_events',
          args: { calendarId: 'primary' },
          result: { items: [{ summary: 'Dentist' }] },
          error: 'upstream echoed: Dentist',
          elapsedMs: 300,
        },
        { name: 'commonly_post_message', callId: 'call-1', outcome: 'ok', elapsedMs: 40 },
      ],
    },
    { turnIndex: 1, model: 'deepseek-chat', elapsedMs: 100 },
  ],
  ...extra,
});

describe('AgentRun content window', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => { await AgentRun.deleteMany({}); });

  test('the window is 30 days', () => {
    expect(RUN_CONTENT_WINDOW_DAYS).toBe(30);
  });

  test('a dry run counts the expired runs and changes nothing', async () => {
    await AgentRun.create([runAt(daysAgo(45)), runAt(daysAgo(31)), runAt(daysAgo(29))]);

    const report = await redactExpiredRunContent({ now: NOW });

    expect(report).toMatchObject({ matched: 2, redacted: 0 });
    expect(report.cutoff.toISOString()).toBe(daysAgo(30).toISOString());
    const withText = await AgentRun.countDocuments({ 'turns.llmResponseText': { $exists: true } });
    expect(withText).toBe(3);
  });

  test('an expired run loses its text, tool args/results/errors and errorMessage, and keeps everything else', async () => {
    const [old] = await AgentRun.create([runAt(daysAgo(45))]);

    const report = await redactExpiredRunContent({ apply: true, now: NOW });
    expect(report).toMatchObject({ matched: 1, redacted: 1 });

    const row = await AgentRun.collection.findOne({ _id: old._id });
    expect(row.contentRedactedAt.toISOString()).toBe(NOW.toISOString());
    expect(row.turns[0]).not.toHaveProperty('llmResponseText');
    expect(row.turns[0].toolCalls[0]).not.toHaveProperty('args');
    expect(row.turns[0].toolCalls[0]).not.toHaveProperty('result');
    expect(row.turns[0].toolCalls[0]).not.toHaveProperty('error');
    expect(row).not.toHaveProperty('errorMessage');
    expect(JSON.stringify(row)).not.toMatch(/Dentist|dentist|primary/);

    // Metadata stays: what proof of life, activity, traces and spend read.
    expect(row).toMatchObject({
      agentName: 'scout', trigger: 'mention', status: 'failed', errorKind: 'tool_error', totalTokens: 1200,
    });
    expect(row.startedAt.toISOString()).toBe(daysAgo(45).toISOString());
    expect(row.turns).toHaveLength(2);
    expect(row.turns[0]).toMatchObject({
      turnIndex: 0, model: 'deepseek-chat', servedModel: 'deepseek-chat', totalTokens: 1200, elapsedMs: 900,
    });
    expect(row.turns[0].toolCalls).toEqual([
      { name: 'calendar_list_events', elapsedMs: 300 },
      { name: 'commonly_post_message', callId: 'call-1', outcome: 'ok', elapsedMs: 40 },
    ]);
    expect(row.turns[1]).toMatchObject({ turnIndex: 1, model: 'deepseek-chat', toolCalls: [] });
  });

  test('runs inside the window are untouched and no row is deleted', async () => {
    const [, recent] = await AgentRun.create([runAt(daysAgo(60)), runAt(daysAgo(29))]);

    await redactExpiredRunContent({ apply: true, now: NOW });

    expect(await AgentRun.countDocuments({})).toBe(2);
    const row = await AgentRun.collection.findOne({ _id: recent._id });
    expect(row).not.toHaveProperty('contentRedactedAt');
    expect(row.turns[0].llmResponseText).toBe('Your 3pm with the dentist moved to Friday.');
    expect(row.turns[0].toolCalls[0].result).toEqual({ items: [{ summary: 'Dentist' }] });
    expect(row.turns[0].toolCalls[0].error).toBe('upstream echoed: Dentist');
    expect(row.errorMessage).toBe('calendar_list_events failed: Dentist at 3pm');
  });

  test('a second pass finds nothing left to redact', async () => {
    await AgentRun.create([runAt(daysAgo(45))]);
    await redactExpiredRunContent({ apply: true, now: NOW });

    const again = await redactExpiredRunContent({ apply: true, now: new Date(NOW.getTime() + DAY) });

    expect(again).toMatchObject({ matched: 0, redacted: 0 });
  });

  test('an old row with no turns array is stamped without an error', async () => {
    const { insertedId } = await AgentRun.collection.insertOne({
      podId: new mongoose.Types.ObjectId(), agentName: 'scout', trigger: 'heartbeat', startedAt: daysAgo(90),
    });

    const report = await redactExpiredRunContent({ apply: true, now: NOW });

    expect(report).toMatchObject({ matched: 1, redacted: 1 });
    const row = await AgentRun.collection.findOne({ _id: insertedId });
    expect(row.turns).toEqual([]);
    expect(row.contentRedactedAt).toBeInstanceOf(Date);
  });
});
