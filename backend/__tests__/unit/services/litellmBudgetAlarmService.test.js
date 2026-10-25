/**
 * TASK-555: the LiteLLM key budget alarm lists every virtual key with the
 * master key, and at 80% of a key's max_budget logs one `alarm:
 * litellm_budget` line per key per budget period and pages SRE. It reports
 * and never blocks.
 */
jest.mock('axios', () => ({ get: jest.fn() }));
const mockPageSre = jest.fn();
jest.mock('../../../services/spendAlarmService', () => ({ pageSre: (...args) => mockPageSre(...args) }));

const axios = require('axios');
const budget = require('../../../services/litellmBudgetAlarmService');

const ENV_KEYS = ['LITELLM_BASE_URL', 'LITELLM_MASTER_KEY', 'SPEND_ALARM_MENTION'];
const savedEnv = {};

const key = (overrides) => ({
  token: 'aaaabbbbccccdddd',
  key_alias: 'svc-backend',
  spend: 0,
  max_budget: 40,
  budget_duration: '30d',
  budget_reset_at: '2026-11-24T00:00:00Z',
  ...overrides,
});

const page = (keys, totalPages = 1) => ({ data: { keys, total_pages: totalPages } });

let warn;

beforeEach(() => {
  ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });
  process.env.LITELLM_BASE_URL = 'http://litellm:4000/';
  process.env.LITELLM_MASTER_KEY = 'sk-master-test';
  delete process.env.SPEND_ALARM_MENTION;
  axios.get.mockReset();
  mockPageSre.mockReset().mockResolvedValue(undefined);
  budget.resetBudgetAlarmMemory();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
  warn.mockRestore();
});

const alarmLines = () => warn.mock.calls
  .map(([first]) => first)
  .filter((first) => typeof first === 'string' && first.startsWith('{'))
  .map((line) => JSON.parse(line))
  .filter((line) => line.alarm === 'litellm_budget');

describe('keysNearBudget', () => {
  test('flags a key at or past 80% of its budget and nothing below', () => {
    const alarms = budget.keysNearBudget([
      key({ key_alias: 'at-line', spend: 32 }),
      key({ key_alias: 'below', spend: 31.99 }),
      key({ key_alias: 'over', spend: 45 }),
    ]);
    expect(alarms.map((a) => a.keyAlias)).toEqual(['at-line', 'over']);
    expect(alarms[0]).toEqual({
      keyAlias: 'at-line',
      spendUsd: 32,
      maxBudgetUsd: 40,
      percent: 80,
      budgetDuration: '30d',
      resetsAt: '2026-11-24T00:00:00Z',
    });
  });

  test('ignores keys with no budget, a zero budget or no spend figure', () => {
    expect(budget.keysNearBudget([
      key({ max_budget: null, spend: 1000 }),
      key({ max_budget: 0, spend: 1000 }),
      key({ spend: null }),
    ])).toEqual([]);
  });

  test('names a key without an alias by its stored hash prefix, and strips the alias to an identifier', () => {
    const [noAlias, odd] = budget.keysNearBudget([
      key({ key_alias: null, spend: 39 }),
      key({ key_alias: 'svc bot\n@everyone <x>', spend: 39 }),
    ]);
    expect(noAlias.keyAlias).toBe('key:aaaabbbb');
    expect(odd.keyAlias).toBe('svcboteveryonex');
  });
});

describe('listLiteLLMKeys', () => {
  test('returns null without the master key, and makes no call', async () => {
    delete process.env.LITELLM_MASTER_KEY;
    expect(await budget.listLiteLLMKeys()).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('pages through /key/list with the master key until total_pages', async () => {
    axios.get
      .mockResolvedValueOnce(page([key({ key_alias: 'a' })], 2))
      .mockResolvedValueOnce(page([key({ key_alias: 'b' })], 2));
    const { rows, incomplete } = await budget.listLiteLLMKeys();
    expect(rows.map((r) => r.key_alias)).toEqual(['a', 'b']);
    expect(incomplete).toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(2);
    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toBe('http://litellm:4000/key/list');
    expect(opts.headers.Authorization).toBe('Bearer sk-master-test');
    expect(opts.params).toEqual({ return_full_object: true, page: 1, size: 100 });
    expect(axios.get.mock.calls[1][1].params.page).toBe(2);
  });

  test('stops at the page bound and reports the scan as truncated', async () => {
    axios.get.mockResolvedValue(page([key()], 9999));
    const { incomplete } = await budget.listLiteLLMKeys();
    expect(axios.get).toHaveBeenCalledTimes(20);
    expect(incomplete).toEqual({ reason: 'truncated', pagesRead: 20, totalPages: 9999 });
  });
});

describe('checkLiteLLMBudgets', () => {
  test('logs and pages once per key per budget period', async () => {
    process.env.SPEND_ALARM_MENTION = 'sre-ops';
    axios.get.mockResolvedValue(page([key({ spend: 36 }), key({ key_alias: 'svc-commonly-bot', max_budget: 20, spend: 3 })]));

    const first = await budget.checkLiteLLMBudgets();
    expect(first.map((a) => a.keyAlias)).toEqual(['svc-backend']);
    expect(alarmLines()).toEqual([expect.objectContaining({
      alarm: 'litellm_budget', thresholdFraction: 0.8, keyAlias: 'svc-backend', spendUsd: 36, maxBudgetUsd: 40, percent: 90,
    })]);
    expect(mockPageSre).toHaveBeenCalledTimes(1);
    expect(mockPageSre.mock.calls[0][0]).toBe(
      '[budget alarm] LiteLLM key svc-backend has spent $36.00 of its $40 budget (90%). '
      + 'At 100% its calls fail. It resets 2026-11-24T00:00:00Z. @sre-ops',
    );

    expect(await budget.checkLiteLLMBudgets()).toEqual([]);
    expect(mockPageSre).toHaveBeenCalledTimes(1);

    // A new budget period is a new alarm.
    axios.get.mockResolvedValue(page([key({ spend: 36, budget_reset_at: '2026-12-24T00:00:00Z' })]));
    expect((await budget.checkLiteLLMBudgets()).map((a) => a.resetsAt)).toEqual(['2026-12-24T00:00:00Z']);
    expect(mockPageSre).toHaveBeenCalledTimes(2);
  });

  test('two keys whose labels sanitise alike each alarm', async () => {
    axios.get.mockResolvedValue(page([
      key({ token: 'aaaa1111', key_alias: 'svc bot', spend: 39 }),
      key({ token: 'bbbb2222', key_alias: 'svcbot', spend: 39 }),
    ]));
    expect((await budget.checkLiteLLMBudgets()).map((a) => a.keyAlias)).toEqual(['svcbot', 'svcbot']);
    expect(mockPageSre).toHaveBeenCalledTimes(2);
  });

  test('a failed page keeps the log line and is retried next sweep without a second line', async () => {
    mockPageSre.mockRejectedValueOnce(new Error('pod gone'));
    axios.get.mockResolvedValue(page([key({ spend: 40 })]));
    expect((await budget.checkLiteLLMBudgets()).length).toBe(1);
    expect(alarmLines().length).toBe(1);
    expect(mockPageSre).toHaveBeenCalledTimes(1);

    expect(await budget.checkLiteLLMBudgets()).toEqual([]);
    expect(mockPageSre).toHaveBeenCalledTimes(2);
    expect(alarmLines().length).toBe(1);

    await budget.checkLiteLLMBudgets();
    expect(mockPageSre).toHaveBeenCalledTimes(2);
  });

  test('a truncated scan alarms once, still checks the keys it read', async () => {
    axios.get.mockResolvedValue(page([key({ spend: 39 })], 9999));
    await budget.checkLiteLLMBudgets();
    expect(alarmLines()).toEqual([
      { alarm: 'litellm_budget', scanIncomplete: 'truncated', pagesRead: 20, totalPages: 9999 },
      expect.objectContaining({ keyAlias: 'svc-backend' }),
    ]);
    expect(mockPageSre.mock.calls[0][0]).toMatch(/stopped at 20 of 9999 pages/);
    await budget.checkLiteLLMBudgets();
    expect(alarmLines().filter((l) => l.scanIncomplete).length).toBe(1);
  });

  test('a failed later page keeps the keys already read and alarms the incomplete scan', async () => {
    axios.get
      .mockResolvedValueOnce(page([key({ spend: 39 })], 3))
      .mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'));
    const fresh = await budget.checkLiteLLMBudgets();
    expect(fresh.map((a) => a.keyAlias)).toEqual(['svc-backend']);
    expect(alarmLines()[0]).toEqual({ alarm: 'litellm_budget', scanIncomplete: 'failed', pagesRead: 1, totalPages: 3 });
    expect(mockPageSre.mock.calls[0][0]).toMatch(/failed after 1 page,/);
    expect(mockPageSre).toHaveBeenCalledTimes(2);
  });

  test('an incomplete scan alarms again only after a complete one in between', async () => {
    axios.get.mockRejectedValueOnce(new Error('down'));
    await budget.checkLiteLLMBudgets();
    axios.get.mockRejectedValueOnce(new Error('down'));
    await budget.checkLiteLLMBudgets();
    expect(alarmLines().filter((l) => l.scanIncomplete).length).toBe(1);
    axios.get.mockResolvedValueOnce(page([]));
    await budget.checkLiteLLMBudgets();
    axios.get.mockRejectedValueOnce(new Error('down'));
    await budget.checkLiteLLMBudgets();
    expect(alarmLines().filter((l) => l.scanIncomplete).length).toBe(2);
  });

  test('does nothing without the master key', async () => {
    delete process.env.LITELLM_MASTER_KEY;
    expect(await budget.checkLiteLLMBudgets()).toEqual([]);
    expect(mockPageSre).not.toHaveBeenCalled();
  });
});
