/* eslint-disable react/display-name */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  MemoryRouter, Route, Routes, useLocation, useNavigate,
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
jest.mock('../components/V2PodsSidebar', () => ({ variant }: { variant?: string }) => (
  <div data-testid="pods-sidebar" data-variant={variant || 'column'} />
));
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

// A path probe that can also step back through the router's own history, which
// is the only way jsdom can tell a `replace` from a `push`.
const CurrentPathWithBack = () => {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="current-path">{location.pathname}</span>
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </>
  );
};

const usePhoneViewport = () => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })),
  });
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

// The app's real shell: `/v2` mounts the auto selector, and the pod route mounts
// the param shell (V2App.tsx:127 / :165), which is the instance that records the
// visit. A test that only mounts the auto layout cannot see LAST_POD_KEY at all.
const renderAutoIntoParamShell = () => render(
  <MemoryRouter initialEntries={['/v2']}>
    <Routes>
      <Route path="/v2" element={<V2Layout selectionMode="auto" />} />
      <Route
        path="/v2/pods/:podId"
        element={<><V2Layout selectionMode="param" /><CurrentPath /></>}
      />
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

  test('on a phone /v2 is the pods list page: no redirect into a pod, no thread, page-variant sidebar', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn((query: string) => ({
        matches: query === '(max-width: 760px)',
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
    localStorage.setItem('v2:lastPodId', 'hq');
    renderAutoLayout();
    await waitFor(() => expect(screen.getByTestId('pods-sidebar')).toHaveAttribute('data-variant', 'page'));
    expect(screen.queryByTestId('current-path')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'toggle inspector' })).not.toBeInTheDocument();
  });

  test('a phone first login lands in the workspace thread, and the list is where you come back to', async () => {
    // TASK-144. The list is the right landing for a phone that has a pod to
    // return to; a device that has never opened one has nothing to list, so the
    // welcome thread is the first screen. The same redirect is what records the
    // pod — which is why the back arrow lands on a list that then stays put.
    usePhoneViewport();
    expect(localStorage.getItem('v2:lastPodId')).toBeNull();

    const first = renderAutoIntoParamShell();
    await waitFor(() => {
      expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/workspace');
    });
    // Written by the param shell that the redirect lands on — the same effect
    // that runs when a returning user taps a pod.
    await waitFor(() => expect(localStorage.getItem('v2:lastPodId')).toBe('workspace'));
    first.unmount();

    // ...and the next /v2 on this device is the list, with no second redirect.
    renderAutoLayout();
    await waitFor(() => {
      expect(screen.getByTestId('pods-sidebar')).toHaveAttribute('data-variant', 'page');
    });
    expect(screen.queryByTestId('current-path')).not.toBeInTheDocument();
  });

  test('a phone first login replaces, so back does not bounce through the list', async () => {
    usePhoneViewport();
    render(
      <MemoryRouter initialEntries={['/v2']}>
        <Routes>
          <Route path="/v2" element={<V2Layout selectionMode="auto" />} />
          <Route
            path="/v2/pods/:podId"
            element={<><V2Layout selectionMode="param" /><CurrentPathWithBack /></>}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/workspace');
    });
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    // A push would leave /v2 underneath, so one step back would re-resolve the
    // landing; a replace leaves nothing to step back into.
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/workspace');
  });

  test('keeps the create-pod query on /v2 until the sidebar finishes the round trip', async () => {
    render(
      <MemoryRouter initialEntries={['/v2?newPod=1']}>
        <Routes>
          <Route
            path="/v2"
            element={(
              <>
                <V2Layout selectionMode="auto" />
                <CurrentPath />
              </>
            )}
          />
          <Route path="/v2/pods/:podId" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('current-path').textContent).toBe('/v2'));
  });

  test('opening a pod records it in the visit log that orders the sidebar’s Recent', () => {
    render(
      <MemoryRouter initialEntries={['/v2/pods/workspace']}>
        <Routes>
          <Route path="/v2/pods/:podId" element={<V2Layout selectionMode="param" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(Object.keys(JSON.parse(localStorage.getItem('v2:podVisits') || '{}'))).toEqual(['workspace']);
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

  test.each([
    [390, null, false],
    [1199, null, false],
    [1200, null, true],
    [1440, null, true],
    [1440, '1', false],
    [1199, '0', true],
  ])('inspector visibility at %ipx with stored preference %s is %s', (width, preference, visible) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn((query: string) => ({
        matches: query === '(max-width: 760px)' ? Number(width) <= 760 : Number(width) >= 1200,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
    if (preference !== null) localStorage.setItem('v2.inspectorCollapsed', String(preference));

    render(
      <MemoryRouter initialEntries={['/v2/pods/workspace']}>
        <Routes>
          <Route path="/v2/pods/:podId" element={<V2Layout selectionMode="param" />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('workspace-inspector') !== null).toBe(visible);
    expect(localStorage.getItem('v2.inspectorCollapsed')).toBe(preference);
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
