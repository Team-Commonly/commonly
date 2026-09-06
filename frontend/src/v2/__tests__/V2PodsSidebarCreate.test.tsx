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

  it('creates a Pod from name + purpose alone, born private', async () => {
    // ADR-016 / #768: creation asks for intent, not audience. Every pod is
    // born private and unlisted; `joinPolicy: 'open'` is the DORMANT
    // declaration ("open once listed"), not a choice the creator made here.
    // Visibility moves to a later, deliberate act via POST /pods/:id/visibility.
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

    fireEvent.click(screen.getByRole('button', { name: '+ new' }));

    // The audience choice is gone — it set one field, could not be honoured
    // for non-admins, and asked a stranger to decide before they had content.
    expect(screen.queryByRole('button', { name: /Open to join/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Invite-only/ })).not.toBeInTheDocument();

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
        'open',
      );
    });
    expect(sessionStorage.getItem('v2.justCreated.new-private-pod')).toBe('1');
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/new-private-pod');
  });

  it('the simplified create form still localizes (zh-CN)', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: '+ 新建' }));

    // Audience options are gone in every locale — a zh-only regression here
    // would mean the removal was done in the component but not the catalog.
    expect(screen.queryByRole('button', { name: /开放加入/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /仅限邀请/ })).not.toBeInTheDocument();

    // What SHOULD localize: the fields creation still asks for.
    expect(screen.getByPlaceholderText('Pod 名称')).toBeInTheDocument();
  });
});
