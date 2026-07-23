// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import V2PodsSidebar from '../components/V2PodsSidebar';

const COMMUNITY_POD_ID = 'community-pod';
const mockJoinPod = jest.fn();
const mockSeedFromExisting = jest.fn();
const mockRefresh = jest.fn();
const mockApiGet = jest.fn();
const mockApi = {
  get: mockApiGet,
  post: jest.fn(),
  patch: jest.fn(),
  del: jest.fn(),
};

jest.mock('../hooks/useV2Pods', () => ({
  useV2Pods: () => ({
    pods: [],
    loading: false,
    error: null,
    refresh: mockRefresh,
    createPod: jest.fn(),
    deletePod: jest.fn(),
    patchLastMessage: jest.fn(),
  }),
}));

jest.mock('../hooks/useV2Pinned', () => ({
  useV2Pinned: () => ({
    pinned: new Set(),
    toggle: jest.fn(),
    isPinned: () => false,
  }),
}));

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => mockApi,
}));

jest.mock('../hooks/useV2Unread', () => ({
  useV2Unread: () => ({
    isUnread: () => false,
    bumpLatest: jest.fn(),
    seedFromExisting: mockSeedFromExisting,
  }),
}));

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false, joinPod: mockJoinPod }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1', username: 'new-human' } }),
}));

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

const makePod = (id: string, memberIds: string[], overrides = {}) => ({
  _id: id,
  name: id === COMMUNITY_POD_ID ? 'Commonly HQ' : 'My Workspace',
  type: 'team',
  members: memberIds.map((_id) => ({ _id, username: _id, isBot: false })),
  createdAt: '2026-07-21T12:00:00.000Z',
  updatedAt: '2026-07-21T12:00:00.000Z',
  ...overrides,
});

const renderSidebar = (pods) => {
  const podsState = {
    pods,
    loading: false,
    error: null,
    refresh: mockRefresh,
    createPod: jest.fn(),
    deletePod: jest.fn(),
    patchLastMessage: jest.fn(),
  };
  return render(
    <MemoryRouter initialEntries={['/v2/pods/workspace']}>
      <V2PodsSidebar selectedPodId="workspace" podsState={podsState} />
      <CurrentPath />
    </MemoryRouter>,
  );
};

describe('V2PodsSidebar Community offer', () => {
  const originalCommunityPodId = process.env.REACT_APP_COMMUNITY_POD_ID;

  beforeAll(async () => {
    await i18nReady;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockApiGet.mockReset();
    mockApi.post.mockReset();
    mockApiGet.mockResolvedValue([]);
    mockApi.post.mockResolvedValue(null);
    mockRefresh.mockResolvedValue(undefined);
    process.env.REACT_APP_COMMUNITY_POD_ID = COMMUNITY_POD_ID;
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  afterAll(async () => {
    if (originalCommunityPodId === undefined) {
      delete process.env.REACT_APP_COMMUNITY_POD_ID;
    } else {
      process.env.REACT_APP_COMMUNITY_POD_ID = originalCommunityPodId;
    }
    await i18n.changeLanguage('en');
  });

  test('shows for a configured Community pod the human has not joined and navigates to the redirect', () => {
    renderSidebar([makePod('workspace', ['human-1'])]);

    expect(screen.getByText('Meet the builders and their agents.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Join HQ' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/community');
  });

  test('stays hidden once the Community pod is in memberPodIds', () => {
    renderSidebar([
      makePod('workspace', ['human-1']),
      makePod(COMMUNITY_POD_ID, ['human-1']),
    ]);

    expect(screen.queryByRole('button', { name: 'Join HQ' })).not.toBeInTheDocument();
  });

  test('stays hidden for self-hosted instances without Community config', () => {
    delete process.env.REACT_APP_COMMUNITY_POD_ID;
    renderSidebar([makePod('workspace', ['human-1'])]);

    expect(screen.queryByRole('button', { name: 'Join HQ' })).not.toBeInTheDocument();
  });

  test('splits joined Community pods from discoverable non-members without leaking them into All', async () => {
    const joinedPod = makePod('joined-space', ['human-1'], {
      name: 'Joined Builders',
      publicRead: true,
    });
    const hqPod = makePod(COMMUNITY_POD_ID, ['human-1'], { publicRead: true });
    mockApiGet.mockImplementation((url) => {
      if (url === '/api/pods?scope=community') {
        return Promise.resolve([joinedPod, hqPod]);
      }
      if (url === '/api/pods?scope=discover') {
        return Promise.resolve([
          makePod('public-space', [], {
            name: 'Open Builders',
            description: 'Build in public with the community.',
            publicRead: true,
          }),
          makePod('forced-public-dm', [], {
            name: 'Private agent room',
            type: 'agent-room',
            publicRead: true,
          }),
        ]);
      }
      return Promise.resolve([]);
    });
    renderSidebar([
      makePod('workspace', ['human-1']),
      joinedPod,
      hqPod,
    ]);

    const communityFilter = screen.getByRole('button', { name: 'Community' });
    fireEvent.click(communityFilter);
    expect(communityFilter).toHaveClass('v2-pods__filter--active');
    expect(screen.getByRole('button', { name: 'All' }))
      .not.toHaveClass('v2-pods__filter--active');
    expect(screen.getByRole('button', { name: 'Joined' }))
      .toHaveClass('v2-pods__community-tab--active');
    expect(await screen.findByText('Joined Builders')).toBeInTheDocument();
    expect(screen.getByText('Commonly HQ')).toBeInTheDocument();
    expect(screen.queryByText('Open Builders')).not.toBeInTheDocument();
    expect(mockApiGet).not.toHaveBeenCalledWith('/api/pods?scope=discover');

    const discoverView = screen.getByRole('button', { name: 'Discover' });
    fireEvent.click(discoverView);
    expect(discoverView).toHaveClass('v2-pods__community-tab--active');
    expect(screen.getByRole('button', { name: 'Joined' }))
      .not.toHaveClass('v2-pods__community-tab--active');
    expect(await screen.findByText('Open Builders')).toBeInTheDocument();
    expect(screen.getByText('Build in public with the community.')).toBeInTheDocument();
    expect(screen.getByText('0 members')).toBeInTheDocument();
    expect(screen.queryByText('Private agent room')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('My Workspace')).toBeInTheDocument();
    expect(screen.queryByText('Open Builders')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/api/pods?scope=community');
      expect(mockApiGet).toHaveBeenCalledWith('/api/pods?scope=discover');
    });
  });

  test('joins a discovered pod, moves it to Joined, refreshes memberships, and navigates in', async () => {
    const discoveredPod = makePod('bug-reports', [], {
      name: 'Bug Reports',
      description: 'Help make Commonly better.',
      publicRead: true,
    });
    const joinedPod = makePod('bug-reports', ['human-1'], {
      name: 'Bug Reports',
      description: 'Help make Commonly better.',
      publicRead: true,
    });
    mockApiGet.mockImplementation((url) => (
      url === '/api/pods?scope=discover'
        ? Promise.resolve([discoveredPod])
        : Promise.resolve([])
    ));
    mockApi.post.mockResolvedValue(joinedPod);
    renderSidebar([makePod('workspace', ['human-1'])]);

    fireEvent.click(screen.getByRole('button', { name: 'Community' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/pods/bug-reports/join');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/bug-reports');
    });
    expect(screen.getByRole('button', { name: 'Joined' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Bug Reports')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
  });

  test.each([
    [403, 'This Pod needs an invite link to join.'],
    [429, 'Too many join attempts. Wait a moment and try again.'],
  ])('keeps a discovered pod visible and explains a %s join refusal', async (status, message) => {
    const discoveredPod = makePod('feature-requests', [], {
      name: 'Feature Requests',
      publicRead: true,
    });
    mockApiGet.mockImplementation((url) => (
      url === '/api/pods?scope=discover'
        ? Promise.resolve([discoveredPod])
        : Promise.resolve([])
    ));
    mockApi.post.mockRejectedValue({ response: { status } });
    renderSidebar([makePod('workspace', ['human-1'])]);

    fireEvent.click(screen.getByRole('button', { name: 'Community' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByText('Feature Requests')).toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/workspace');
  });

  test('renders the Community discovery controls from both locale catalogs', async () => {
    mockApiGet.mockImplementation((url) => (
      url === '/api/pods?scope=discover'
        ? Promise.resolve([makePod('public-space', [], { name: 'Open Builders' })])
        : Promise.resolve([])
    ));
    renderSidebar([makePod('workspace', ['human-1'])]);
    expect(screen.getByRole('button', { name: 'Community' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Community' }));
    expect(screen.getByRole('button', { name: 'Joined' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
    expect(await screen.findByRole('button', { name: 'Join' })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    expect(screen.getByRole('button', { name: '社区' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已加入' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发现' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加入' })).toBeInTheDocument();
  });
});
