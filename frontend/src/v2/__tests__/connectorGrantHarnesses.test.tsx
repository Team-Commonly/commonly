// @ts-nocheck
// F175a: one list names the harnesses a connector grant can reach, and the
// harnesses that can't be sandboxed get a plain line instead of silence.
import { act } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import {
  GRANT_HARNESS_IDS, connectorGrantBlock, grantHarnessNames, KNOWN_HARNESS_IDS,
} from '../utils/harnessCatalog';

const t = (key, values) => i18n.t(key, values);

describe('the harnesses a connector grant can reach', () => {
  beforeAll(async () => { await i18nReady; });
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('en'); }); });

  test('mirrors the server\'s confining adapters: Claude Code, Codex and OpenCode', () => {
    expect([...GRANT_HARNESS_IDS]).toEqual(['claude', 'codex', 'opencode']);
    for (const id of GRANT_HARNESS_IDS) expect(KNOWN_HARNESS_IDS).toContain(id);
  });

  test('names the full set in English and Chinese', async () => {
    expect(grantHarnessNames(t)).toBe('Claude Code, Codex or OpenCode');
    expect(t('tools.byo.reasonAdapterUnsupported', { harnesses: grantHarnessNames(t) }))
      .toBe('Connectors need a sandboxed harness: only Claude Code, Codex or OpenCode agents can be named.');
    expect(t('tools.byo.errors.adapterUnsupported', { harnesses: grantHarnessNames(t) }))
      .toBe('Only a Claude Code, Codex or OpenCode agent can be named on a grant.');
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(grantHarnessNames(t)).toBe('Claude Code、Codex 或 OpenCode');
    expect(t('tools.byo.reasonAdapterUnsupported', { harnesses: grantHarnessNames(t) }))
      .toBe('连接器需要带沙箱的运行器：只能指定 Claude Code、Codex 或 OpenCode 智能体。');
    expect(t('tools.byo.errors.adapterUnsupported', { harnesses: grantHarnessNames(t) }))
      .toBe('授权中只能指定 Claude Code、Codex 或 OpenCode 智能体。');
  });

  // Two honest states: no sandbox at all (dsh, Hermes), or not on the grant
  // list yet (everything else outside GRANT_HARNESS_IDS). No "on a Mac" hint:
  // pi can't take a connector on any computer.
  test.each([
    ['dsh', 'never'], ['hermes', 'never'],
    ['pi', 'notYet'], ['goose', 'notYet'], ['qwen', 'notYet'],
    ['claude', null], ['codex', null], ['opencode', null], ['', null],
  ])('%s: %s', (id, expected) => {
    expect(connectorGrantBlock(id)).toBe(expected);
    expect(connectorGrantBlock(id, 'mac')).toBe(expected);
    expect(connectorGrantBlock(id, 'linux')).toBe(expected);
  });

  // The CLI withholds grant brokers from every seat on native Windows, so a
  // harness on the grant list says so there; the others keep their own line.
  test.each([
    ['claude', 'windows'], ['codex', 'windows'], ['opencode', 'windows'],
    ['dsh', 'never'], ['pi', 'notYet'], ['', null],
  ])('%s on Windows: %s', (id, expected) => {
    expect(connectorGrantBlock(id, 'windows')).toBe(expected);
  });

  test('a harness on the grant list never gets a line, whatever else it is', () => {
    for (const id of KNOWN_HARNESS_IDS) {
      expect(connectorGrantBlock(id) === null).toBe(GRANT_HARNESS_IDS.includes(id));
    }
  });

  test('English lines read plainly', () => {
    expect(t('harness.noConnectorsYet', { tool: 'Goose' })).toBe('Connectors don’t work with Goose yet.');
    expect(t('harness.noConnectorsWindows')).toBe('Connectors don’t work on Windows yet.');
  });

  test('zh-CN calls a harness 运行器, as agentManage.controls.harness does', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(t('agentManage.controls.harness')).toBe('运行器');
    expect(t('harness.noConnectors', { tool: 'Hermes' }))
      .toBe('连接器需要带沙箱的运行器。Hermes 运行时没有沙箱，所以用不了连接器。');
    expect(t('harness.noConnectorsYet', { tool: 'pi' })).toBe('pi 暂时还用不了连接器。');
    expect(t('harness.noConnectorsWindows')).toBe('Windows 上暂时还用不了连接器。');
    for (const key of ['harness.noConnectors', 'harness.noConnectorsYet', 'harness.noConnectorsWindows']) {
      expect(t(key, { tool: 'X' })).not.toContain('运行环境');
    }
  });
});
