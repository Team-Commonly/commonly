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

  it('keeps open as the default join policy while the pod is born private', async () => {
    // Join policy is distinct from public visibility: an open pod still starts
    // private and unlisted until its owner publishes it separately.
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

    fireEvent.click(screen.getByRole('button', { name: 'New pod' }));

    expect(screen.getByRole('radio', { name: 'Open to join' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Invite-only' })).not.toBeChecked();

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

  it('creates an invite-only pod when the person chooses it', async () => {
    const podsState = {
      pods: [], loading: false, error: null, createPod: mockCreatePod,
      patchLastMessage: jest.fn(),
    };
    render(
      <MemoryRouter initialEntries={['/v2']}>
        <V2PodsSidebar selectedPodId={null} podsState={podsState} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New pod' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Invite-only' }));
    fireEvent.change(screen.getByPlaceholderText('Pod name'), { target: { value: 'Connector team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockCreatePod).toHaveBeenCalledWith('Connector team', undefined, 'team', 'invite-only'));
  });

  it('opens from Connectors and returns there after creating the first pod', async () => {
    const podsState = {
      pods: [],
      loading: false,
      error: null,
      createPod: mockCreatePod,
      patchLastMessage: jest.fn(),
    };
    render(
      <MemoryRouter initialEntries={['/v2?newPod=1']}>
        <V2PodsSidebar selectedPodId={null} podsState={podsState} />
        <CurrentPath />
      </MemoryRouter>,
    );

    expect(screen.getByPlaceholderText('Pod name')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Pod name'), {
      target: { value: 'First pod' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/connectors'));
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

    fireEvent.click(screen.getByRole('button', { name: '新建 Pod' }));

    // Audience options are gone in every locale — a zh-only regression here
    // would mean the removal was done in the component but not the catalog.
    expect(screen.queryByRole('button', { name: /开放加入/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /仅限邀请/ })).not.toBeInTheDocument();

    // What SHOULD localize: the fields creation still asks for.
    expect(screen.getByPlaceholderText('Pod 名称')).toBeInTheDocument();
  });
});
