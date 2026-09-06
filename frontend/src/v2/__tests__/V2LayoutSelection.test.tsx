/* eslint-disable react/display-name */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  MemoryRouter, Route, Routes, useLocation,
} from 'react-router-dom';
import V2Layout from '../components/V2Layout';
import type { V2Pod } from '../hooks/useV2Pods';

const mockPodsState = {
  pods: [] as V2Pod[],
  loading: false,
  error: null,
  refresh: jest.fn(),
  createPod: jest.fn(),
  deletePod: jest.fn(),
  patchLastMessage: jest.fn(),
};

jest.mock('../hooks/useV2Pods', () => ({
  useV2Pods: () => mockPodsState,
}));

jest.mock('../hooks/useV2PodDetail', () => ({
  useV2PodDetail: () => ({
    pod: null,
    members: [],
    messages: [],
    agents: [],
    loading: false,
    error: null,
  }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1', username: 'new-human' } }),
}));

jest.mock('../components/V2NavRail', () => () => null);
jest.mock('../components/V2PodsSidebar', () => () => null);
jest.mock('../components/V2Thread', () => ({ onToggleInspector }: { onToggleInspector?: () => void }) => (
  <button type="button" onClick={onToggleInspector}>toggle inspector</button>
));
jest.mock('../components/V2Inspector', () => () => <aside data-testid="workspace-inspector" />);
jest.mock('../components/V2InviteModal', () => () => null);
jest.mock('../components/V2FirstRunHero', () => () => null);

const CurrentPath = () => {
  const location = useLocation();
  return <span data-testid="current-path">{location.pathname}</span>;
};

const hqPod: V2Pod = {
  _id: 'hq',
  name: 'Commonly HQ',
  joinPolicy: 'open',
  createdBy: { _id: 'hq-owner' },
  createdAt: '2026-07-20T00:00:00.000Z',
};

const workspacePod: V2Pod = {
  _id: 'workspace',
  name: 'My Workspace',
  joinPolicy: 'invite-only',
  createdBy: { _id: 'human-1' },
  createdAt: '2026-07-21T00:00:00.000Z',
};

const newerWorkspacePod: V2Pod = {
  ...workspacePod,
  _id: 'newer-workspace',
  name: 'Newer Workspace',
  createdAt: '2026-07-22T00:00:00.000Z',
};

const originalMatchMedia = window.matchMedia;

const renderAutoLayout = () => render(
  <MemoryRouter initialEntries={['/v2']}>
    <Routes>
      <Route path="/v2" element={<V2Layout selectionMode="auto" />} />
      <Route path="/v2/pods/:podId" element={<CurrentPath />} />
    </Routes>
  </MemoryRouter>,
);

describe('V2Layout default pod selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockPodsState.pods = [hqPod, newerWorkspacePod, workspacePod];
  });

  afterEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  test('a phone starts with its inspector sheet closed even when desktop left it open', () => {
    const phoneViewport = {
      matches: true,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn(() => phoneViewport),
    });
    localStorage.setItem('v2.inspectorCollapsed', '0');

    render(
      <MemoryRouter initialEntries={['/v2/pods/workspace']}>
        <Routes>
          <Route path="/v2/pods/:podId" element={<V2Layout selectionMode="param" />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('workspace-inspector')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'toggle inspector' }));
    expect(screen.getByTestId('workspace-inspector')).toBeInTheDocument();
    expect(phoneViewport.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  test('lands a new user in their oldest own workspace instead of auto-joined HQ', async () => {
    renderAutoLayout();

    await waitFor(() => {
      expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/workspace');
    });
  });

  test('a valid last visited pod wins over the workspace', async () => {
    localStorage.setItem('v2:lastPodId', 'hq');
    renderAutoLayout();

    await waitFor(() => {
      expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/hq');
    });
  });

  test('a stale last visited pod falls back to the workspace', async () => {
    localStorage.setItem('v2:lastPodId', 'deleted-pod');
    renderAutoLayout();

    await waitFor(() => {
      expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/workspace');
    });
  });

  test('falls back to the first pod when the user owns no workspace', async () => {
    mockPodsState.pods = mockPodsState.pods.map((pod) => (
      pod.joinPolicy === 'invite-only'
        ? { ...pod, createdBy: { _id: 'someone-else' } }
        : pod
    ));
    renderAutoLayout();

    await waitFor(() => {
      expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/hq');
    });
  });

  test('records every visited pod for the next automatic selection', async () => {
    render(
      <MemoryRouter initialEntries={['/v2/pods/workspace']}>
        <Routes>
          <Route
            path="/v2/pods/:podId"
            element={(
              <>
                <V2Layout selectionMode="param" />
                <CurrentPath />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(localStorage.getItem('v2:lastPodId')).toBe('workspace');
    });
  });

  test('refreshes the membership-backed sidebar when navigation lands in a newly-created room', async () => {
    mockPodsState.pods = [];
    render(
      <MemoryRouter initialEntries={['/v2/pods/new-room']}>
        <Routes>
          <Route path="/v2/pods/:podId" element={<V2Layout selectionMode="param" />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(mockPodsState.refresh).toHaveBeenCalledTimes(1));
  });
});
