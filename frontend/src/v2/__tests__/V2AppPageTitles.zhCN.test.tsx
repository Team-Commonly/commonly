/* eslint-disable react/display-name */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import V2App from '../V2App';

// The frame is reduced to the one thing under test: the title V2App hands it.
// V2FeaturePage renders that title as the pane's aria-label, and as the visible
// heading only on routes that keep the header, so several of these titles are
// heard by a screen reader and never seen.
jest.mock('../components/V2FeaturePage', () => ({ title, children }: { title: string; children: React.ReactNode }) => (
  <main aria-label={title}>{children}</main>
));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, loading: false, currentUser: { _id: 'u1' } }),
}));
jest.mock('../hooks/useTimeZoneCapture', () => ({ useTimeZoneCapture: () => undefined }));
jest.mock('../components/V2EmailVerificationBanner', () => () => null);
jest.mock('../agents/V2AgentSettingsPage', () => () => <div />);
jest.mock('../agents/V2AgentMemory', () => () => <div />);
jest.mock('../components/V2ArtifactsPage', () => () => <div />);
jest.mock('../components/V2RunTrace', () => () => <div />);
jest.mock('../components/V2TaskRecord', () => () => <div />);
jest.mock('../components/V2ActivityPage', () => () => <div />);
jest.mock('../components/V2PersonProfile', () => () => <div />);
jest.mock('../agents/V2AgentProfile', () => ({ shell }: { shell?: (page: React.ReactNode) => React.ReactNode }) => (
  <>{shell ? shell(<div />) : null}</>
));

// route | English title as main shipped it | zh-CN
const ROUTES: Array<[string, string, string]> = [
  ['/v2/agents/openclaw/aria', 'Agent settings', '智能体设置'],
  ['/v2/agents/openclaw/aria/memory', 'Agent memory', '智能体记忆'],
  ['/v2/artifacts', 'Artifacts', '产物'],
  ['/v2/pods/p1/runs/r1', 'Run trace', '运行轨迹'],
  ['/v2/pods/p1/tasks/t1/record', 'Task record', '任务记录'],
  ['/v2/activity', 'Activity', '动态'],
  ['/v2/profile/u2', 'Profile', '资料页'],
  ['/v2/agent/openclaw/aria', 'Agent profile', '智能体资料页'],
];

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/v2/*" element={<V2App />} /></Routes>
  </MemoryRouter>,
);

describe('V2App page titles route through i18n', () => {
  beforeAll(async () => { await i18nReady; });
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('en'); }); });

  test.each(ROUTES)('%s keeps its English title "%s"', async (path, en) => {
    await act(async () => { await i18n.changeLanguage('en'); });
    renderAt(path);
    expect(await screen.findByRole('main', { name: en })).toBeInTheDocument();
  });

  test.each(ROUTES)('%s reads in Chinese in zh-CN', async (path, _en, zh) => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderAt(path);
    expect(await screen.findByRole('main', { name: zh })).toBeInTheDocument();
  });
});
