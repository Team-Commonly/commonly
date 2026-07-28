// @ts-nocheck
import React from 'react';
import {
  act, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import V2PodsSidebar from '../components/V2PodsSidebar';
import i18n, { i18nReady } from '../../i18n';

const mockCreatePod = jest.fn();

jest.mock('../hooks/useV2Pods', () => ({
  useV2Pods: () => ({
    pods: [],
    loading: false,
    error: null,
    createPod: mockCreatePod,
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
  useV2Api: () => ({
    get: jest.fn().mockResolvedValue([]),
    post: jest.fn(),
    patch: jest.fn(),
    del: jest.fn(),
  }),
}));

jest.mock('../hooks/useV2Unread', () => ({
  useV2Unread: () => ({
    isUnread: () => false,
    bumpLatest: jest.fn(),
    seedFromExisting: jest.fn(),
  }),
}));

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false, joinPod: jest.fn() }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1', username: 'builder' } }),
}));

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

describe('V2PodsSidebar create flow', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionStorage.clear();
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    mockCreatePod.mockResolvedValue({
      _id: 'new-private-pod',
      name: 'Launch circle',
      type: 'team',
      joinPolicy: 'invite-only',
    });
  });

  it('creates a real invite-only Pod and marks it for the starter panel', async () => {
    const podsState = {
      pods: [],
      loading: false,
      error: null,
      createPod: mockCreatePod,
      patchLastMessage: jest.fn(),
    };
    render(
      <MemoryRouter initialEntries={['/v2']}>
        <V2PodsSidebar selectedPodId={null} podsState={podsState} />
        <CurrentPath />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New Pod' }));
    expect(screen.getByRole('button', { name: /Open to join/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Anyone can join if this pod is listed in Community.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Invite-only/ }));
    expect(screen.getByRole('button', { name: /Invite-only/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Only people you invite can join.')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Pod name'), {
      target: { value: 'Launch circle' },
    });
    fireEvent.change(screen.getByPlaceholderText('Goal or description'), {
      target: { value: 'Prepare the launch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(mockCreatePod).toHaveBeenCalledWith(
        'Launch circle',
        'Prepare the launch',
        'team',
        'invite-only',
      );
    });
    expect(sessionStorage.getItem('v2.justCreated.new-private-pod')).toBe('1');
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/new-private-pod');
  });

  it('renders both policy helpers from the Simplified Chinese catalog', async () => {
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    const podsState = {
      pods: [],
      loading: false,
      error: null,
      createPod: mockCreatePod,
      patchLastMessage: jest.fn(),
    };
    render(
      <MemoryRouter>
        <V2PodsSidebar selectedPodId={null} podsState={podsState} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '新建 Pod' }));

    expect(screen.getByText('列入「社区」后，任何人都可以加入。')).toBeInTheDocument();
    expect(screen.getByText('只有你邀请的人才能加入。')).toBeInTheDocument();

  });
});
