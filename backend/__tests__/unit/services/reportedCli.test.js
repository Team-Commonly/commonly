/**
 * TASK-317: runtime.reportedCli is a display-only, unverified self-report.
 * The write rules come first; the last block pins that no binding reads it,
 * because a seat running pi can report "claude".
 */
const mockUpdateMany = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { updateMany: (...args) => mockUpdateMany(...args) },
}));

const fs = require('fs');
const path = require('path');
const {
  REPORTED_CLI_VALUES, normalizeReportedCli, recordReportedCli, resetReportedCliForTest,
  reportedCliRecordSizeForTest,
} = require('../../../services/reportedCli');
const { grantBrokerRefusal, adapterForRuntimeBinding } = require('../../../services/grantBrokerConfinement');
const { configWriteRefusal } = require('../../../services/configWriteGuard');

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockUpdateMany.mockReset();
  mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
  resetReportedCliForTest();
});

describe('recording the reported CLI', () => {
  test('writes only on BYO rows without a declared adapter, and only the label', () => {
    recordReportedCli(['i1', 'i2'], 'Claude ');
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateMany.mock.calls[0];
    expect(filter).toEqual({
      _id: { $in: ['i1', 'i2'] },
      'config.runtime.host': 'byo',
      'config.runtime.adapter': null,
      'config.runtime.reportedCli': { $ne: 'claude' },
    });
    expect(update).toEqual({ $set: { 'config.runtime.reportedCli': 'claude' } });
  });

  test('an adapter-shaped runtimeType does not block the label, so a stale declaration shows the poller (TASK-704)', () => {
    recordReportedCli(['i1'], 'claude');
    const [filter, update] = mockUpdateMany.mock.calls[0];
    expect(filter).not.toHaveProperty('config.runtime.runtimeType');
    expect(update).toEqual({ $set: { 'config.runtime.reportedCli': 'claude' } });
    // Still a single write: the label never gets a second path that could bind.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  test('only the CLI adapter names are accepted', () => {
    expect([...REPORTED_CLI_VALUES].sort()).toEqual(['claude', 'codex', 'dsh', 'goose', 'opencode', 'pi', 'qwen']);
    ['webhook', 'hosted', 'native', 'claude-code', '', '<b>', 'x'.repeat(200)].forEach((value) => {
      expect(normalizeReportedCli(value)).toBeNull();
      recordReportedCli(['i1'], value);
    });
    recordReportedCli(['i1'], ['claude']);
    recordReportedCli(['i1'], { $ne: null });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  test('no installations, no write; one write per installation and value per ten minutes', () => {
    recordReportedCli([], 'codex');
    recordReportedCli([undefined, null], 'codex');
    expect(mockUpdateMany).not.toHaveBeenCalled();
    recordReportedCli(['i1'], 'codex');
    recordReportedCli(['i1'], 'codex');
    recordReportedCli(['i1', 'i2'], 'codex');
    expect(mockUpdateMany.mock.calls.map(([filter]) => filter._id.$in)).toEqual([['i1'], ['i2']]);
  });

  test('the record expires, so a row whose config was replaced regains the label', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      recordReportedCli(['i1'], 'codex');
      now.mockReturnValue(1_000_000 + 9 * 60 * 1000);
      recordReportedCli(['i1'], 'codex');
      expect(mockUpdateMany).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
      recordReportedCli(['i1'], 'codex');
      expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  test('expired entries are pruned once the record grows, so churn cannot grow it without bound', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      for (let i = 0; i < 1001; i += 1) recordReportedCli([`old-${i}`], 'codex');
      expect(reportedCliRecordSizeForTest()).toBe(1001);
      now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
      recordReportedCli(['fresh'], 'codex');
      expect(reportedCliRecordSizeForTest()).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  test('a failed write is retried on the next poll and never throws into it', async () => {
    mockUpdateMany.mockRejectedValueOnce(new Error('mongo down'));
    expect(() => recordReportedCli(['i1'], 'pi')).not.toThrow();
    await flush();
    recordReportedCli(['i1'], 'pi');
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    mockUpdateMany.mockImplementationOnce(() => { throw new Error('sync'); });
    resetReportedCliForTest();
    expect(() => recordReportedCli(['i1'], 'pi')).not.toThrow();
  });
});

describe('no binding reads reportedCli', () => {
  test('a pi seat reporting claude is still refused confinement', () => {
    const refusal = grantBrokerRefusal({ sandbox: { mode: 'workspace', trust: 'public' } },
      { runtimeType: 'pi', host: 'byo', reportedCli: 'claude' });
    expect(refusal).toEqual(expect.objectContaining({ reason: 'adapter_cannot_confine' }));
    expect(refusal.detail).toMatch(/'pi' adapter/);
  });

  test('the binding the installations route projects ignores it', () => {
    expect(adapterForRuntimeBinding({ runtimeType: 'webhook', host: 'byo', reportedCli: 'claude' })).toBeNull();
    expect(adapterForRuntimeBinding({ runtimeType: 'webhook', host: 'byo', reportedCli: 'pi' })).toBeNull();
    expect(adapterForRuntimeBinding({ runtimeType: 'pi', host: 'byo', reportedCli: 'claude' }))
      .toBe(adapterForRuntimeBinding({ runtimeType: 'pi', host: 'byo' }));
  });

  test('a stale codex runtimeType polling claude keeps its binding, and the report only labels it (TASK-704)', () => {
    const stale = { runtimeType: 'codex', host: 'byo' };
    expect(adapterForRuntimeBinding(stale)).toBe('codex');
    expect(adapterForRuntimeBinding({ ...stale, reportedCli: 'claude' })).toBe('codex');
  });

  test('the config write guard judges the same with or without it', () => {
    const hosted = { runtime: { runtimeType: 'hosted', adapter: 'claude' } };
    const cases = [
      { runtime: { adapter: 'pi' } },
      { runtime: { adapter: 'pi', reportedCli: 'claude' } },
      { runtime: { reportedCli: 'pi' } },
    ];
    const verdicts = cases.map((requested) => configWriteRefusal({ requested, targets: [hosted], isInstanceAdmin: false })?.code || null);
    expect(verdicts).toEqual(['kernel_run_field', 'kernel_run_field', null]);
  });

  test('neither the confinement predicate nor the write guard names the field', () => {
    ['grantBrokerConfinement.ts', 'configWriteGuard.ts'].forEach((file) => {
      const source = fs.readFileSync(path.join(__dirname, '../../../services', file), 'utf8');
      expect(source).not.toMatch(/reportedCli/);
    });
  });
});
