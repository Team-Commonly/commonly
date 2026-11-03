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

// One instant, formatted the two ways the app can now format it. The zh-CN
// string is year-first ("2026/10/25 13:00:00" in UTC+8); the browser default in
// jest is en-US ("10/25/2026, 5:00:00 AM" in UTC). They must differ, or the
// assertions below could not tell the two paths apart.
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

describe('dates follow the app language (zh-CN batch 3)', () => {
  beforeAll(async () => { await i18nReady; });
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('en'); }); });

  test('the two formats are distinguishable', () => {
    expect(zhString).not.toBe(browserString);
    expect(zhString.startsWith('2026/10/2')).toBe(true);
  });

  test('V2RuntimeControls: zh-CN shows the zh date on the process, turn and last-spawn lines', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    const { container } = render(<Controls runtime={runtime as never} />);
    const status = container.querySelector('.v2-runtime-controls__status') as HTMLElement;
    expect(status.textContent?.split(zhString).length).toBe(4);
    expect(status.textContent).not.toContain(browserString);
  });

  test('V2RuntimeControls: English keeps the browser default, as on main', () => {
    const { container } = render(<Controls runtime={runtime as never} />);
    const status = container.querySelector('.v2-runtime-controls__status') as HTMLElement;
    expect(status.textContent?.split(browserString).length).toBe(4);
    expect(status.textContent).not.toContain(zhString);
  });

  test('cardViews SourceView: the fetched-at tooltip is zh in zh-CN and the browser default in English', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    const { unmount } = render(<SourceView connector="linear" fetchedAt={at} />);
    expect(screen.getByText(/fetched/).closest('time')).toHaveAttribute('title', zhString);
    unmount();
    await act(async () => { await i18n.changeLanguage('en'); });
    render(<SourceView connector="linear" fetchedAt={at} />);
    expect(screen.getByText(/fetched/).closest('time')).toHaveAttribute('title', browserString);
  });
});
