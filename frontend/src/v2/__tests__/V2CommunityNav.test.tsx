// @ts-nocheck
import React from 'react';
import {
  act, fireEvent, render, screen,
} from '@testing-library/react';
import {
  MemoryRouter, Route, Routes, useLocation,
} from 'react-router-dom';
import axios from 'axios';
import V2CommunityRedirect from '../components/V2CommunityRedirect';
import V2NavRail from '../components/V2NavRail';
import i18n, { i18nReady } from '../../i18n';
import { FIRST_RUN_REOPEN_EVENT } from '../firstRunGuide';

const mockLogout = jest.fn();
const mockAxiosGet = axios.get as jest.Mock;

jest.mock('axios');
jest.mock('../components/V2Avatar', () => {
  const MockV2Avatar = () => <span data-testid="avatar" />;
  MockV2Avatar.displayName = 'MockV2Avatar';
  return MockV2Avatar;
});
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    currentUser: { _id: 'user-1', username: 'Sam' },
    logout: mockLogout,
  }),
}));

const COMMUNITY_POD_ID = '6a5fe677306155f677c26abf';
const COMMUNITY_INVITE_TOKEN = '7b91255f18ae3c0ae3721707a6613731';

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

const renderRail = () => render(
  <MemoryRouter initialEntries={['/v2/agents']}>
    <div className="v2-root">
      <V2NavRail />
    </div>
  </MemoryRouter>,
);

const renderRedirect = () => render(
  <MemoryRouter initialEntries={['/v2/community']}>
    <CurrentPath />
    <Routes>
      <Route path="/v2/community" element={<V2CommunityRedirect />} />
      <Route path="/v2/pods/:podId" element={<div>Community pod</div>} />
      <Route path="/v2/invite/:token" element={<div>Community invite</div>} />
    </Routes>
  </MemoryRouter>,
);

describe('Community navigation', () => {
  const originalPodId = process.env.REACT_APP_COMMUNITY_POD_ID;
  const originalInviteToken = process.env.REACT_APP_COMMUNITY_INVITE_TOKEN;

  beforeAll(async () => {
    await i18nReady;
  });

  beforeEach(() => {
    process.env.REACT_APP_COMMUNITY_POD_ID = COMMUNITY_POD_ID;
    process.env.REACT_APP_COMMUNITY_INVITE_TOKEN = COMMUNITY_INVITE_TOKEN;
    jest.clearAllMocks();
    return act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  afterAll(async () => {
    if (originalPodId === undefined) {
      delete process.env.REACT_APP_COMMUNITY_POD_ID;
    } else {
      process.env.REACT_APP_COMMUNITY_POD_ID = originalPodId;
    }
    if (originalInviteToken === undefined) {
      delete process.env.REACT_APP_COMMUNITY_INVITE_TOKEN;
    } else {
      process.env.REACT_APP_COMMUNITY_INVITE_TOKEN = originalInviteToken;
    }
    await i18n.changeLanguage('en');
  });

  test('always shows Activity in the third rail slot and keeps Community off the rail', () => {
    const { unmount } = renderRail();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Community' })).not.toBeInTheDocument();
    unmount();

    delete process.env.REACT_APP_COMMUNITY_POD_ID;
    renderRail();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument();
  });

  test('reopens the first-run guide from the feedback menu', async () => {
    const reopen = jest.fn();
    window.addEventListener(FIRST_RUN_REOPEN_EVENT, reopen);
    renderRail();

    // Guide now lives inside the feedback menu, beside report-a-bug / request-a-feature.
    // MUI's modal aria-hides the rail ancestor in jsdom, so menu items need { hidden: true }.
    fireEvent.click(screen.getByRole('button', { name: 'Feedback', hidden: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Guide', hidden: true }));
    expect(reopen).toHaveBeenCalledTimes(1);

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    fireEvent.click(screen.getByRole('button', { name: '反馈', hidden: true }));
    expect(await screen.findByRole('button', { name: '指南', hidden: true })).toBeInTheDocument();
    window.removeEventListener(FIRST_RUN_REOPEN_EVENT, reopen);
  });

  test('sends members to the Community pod', async () => {
    mockAxiosGet.mockResolvedValue({ data: { _id: COMMUNITY_POD_ID } });
    renderRedirect();

    expect(await screen.findByText('Community pod')).toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent(`/v2/pods/${COMMUNITY_POD_ID}`);
    expect(mockAxiosGet).toHaveBeenCalledWith(`/api/pods/${COMMUNITY_POD_ID}`);
  });

  test('sends non-members to the invite redeem route', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });
    renderRedirect();

    expect(await screen.findByText('Community invite')).toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent(`/v2/invite/${COMMUNITY_INVITE_TOKEN}`);
    expect(mockAxiosGet).toHaveBeenCalledWith(`/api/pods/${COMMUNITY_POD_ID}`);
  });
});
