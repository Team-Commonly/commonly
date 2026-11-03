import React from 'react';
import { act, render, screen } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import Controls from '../components/V2RuntimeControls';
import { SourceView } from '../cards/cardViews';

jest.mock('../connectors/ConnectorLogo', () => {
  const MockLogo = () => <span />;
  MockLogo.displayName = 'MockLogo';
  return { __esModule: true, default: MockLogo, connectorName: (type: string) => type };
});

// One instant, formatted the two ways the app can now format it. The host's
// default locale could itself be zh-CN, so the tests never require the two
// strings to differ: they check the output and which locale each call passed.
const at = '2026-10-25T05:00:00Z';
const zhString = new Date(at).toLocaleString('zh-CN');
const browserString = new Date(at).toLocaleString();

const runtime = {
  runtimeType: 'wrapper', managed: false, adapter: 'claude', model: 'm', effort: '',
  inventory: [],
  observation: {
    connectedAt: at, lastSeenAt: at, turnRunning: false, lastTurnAt: at,
    lastSpawn: { harness: 'claude', version: null, model: 'm', effort: null, at }, confirmed: null,
  },
  processConnected: true,
};

// The locale argument of every toLocaleString call made while a test renders.
let locales: unknown[] = [];
let spy: jest.SpyInstance;
const realToLocaleString = Date.prototype.toLocaleString;

describe('dates follow the app language (zh-CN batch 3)', () => {
  beforeAll(async () => { await i18nReady; });
  beforeEach(() => {
    locales = [];
    spy = jest.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date, ...args: unknown[]) {
      locales.push(args[0]);
      return realToLocaleString.apply(this, args as Parameters<Date['toLocaleString']>);
    });
  });
  afterEach(async () => {
    spy.mockRestore();
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('the zh-CN format is year-first', () => {
    expect(zhString.startsWith('2026/10/2')).toBe(true);
  });

  test('V2RuntimeControls: zh-CN shows the zh date on the process, turn and last-spawn lines', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    const { container } = render(<Controls runtime={runtime as never} />);
    const status = container.querySelector('.v2-runtime-controls__status') as HTMLElement;
    expect(status.textContent?.split(zhString).length).toBe(4);
    expect(locales.filter((l) => l === 'zh-CN').length).toBeGreaterThanOrEqual(3);
    expect(locales).not.toContain(undefined);
  });

  test('V2RuntimeControls: English keeps the browser default, as on main', () => {
    const { container } = render(<Controls runtime={runtime as never} />);
    const status = container.querySelector('.v2-runtime-controls__status') as HTMLElement;
    expect(status.textContent?.split(browserString).length).toBe(4);
    expect(locales.length).toBeGreaterThanOrEqual(3);
    expect(locales.every((l) => l === undefined)).toBe(true);
  });

  test('cardViews SourceView: the fetched-at tooltip is zh in zh-CN and the browser default in English', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    const { unmount } = render(<SourceView connector="linear" fetchedAt={at} />);
    expect(screen.getByText(/fetched/).closest('time')).toHaveAttribute('title', zhString);
    expect(locales).toContain('zh-CN');
    unmount();
    locales = [];
    await act(async () => { await i18n.changeLanguage('en'); });
    render(<SourceView connector="linear" fetchedAt={at} />);
    expect(screen.getByText(/fetched/).closest('time')).toHaveAttribute('title', browserString);
    expect(locales.length).toBeGreaterThan(0);
    expect(locales.every((l) => l === undefined)).toBe(true);
  });
});
