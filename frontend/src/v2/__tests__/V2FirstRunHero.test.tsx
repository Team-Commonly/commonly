/* eslint-disable react/display-name */
import React from 'react';
import {
  act, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2FirstRunHero, {
  FIRST_RUN_DISMISSED_KEY,
  FIRST_RUN_STARTED_KEY,
} from '../components/V2FirstRunHero';
import V2Layout from '../components/V2Layout';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockNavigate = jest.fn();
const mockPodsState = {
  pods: [],
  loading: false,
  error: null,
  refresh: jest.fn(),
  createPod: jest.fn(),
  deletePod: jest.fn(),
  patchLastMessage: jest.fn(),
};

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({
    get: mockGet,
    post: mockPost,
    patch: jest.fn(),
    del: jest.fn(),
  }),
}));

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

jest.mock('../hooks/useV2Pods', () => ({
  useV2Pods: () => mockPodsState,
}));

jest.mock('../hooks/useV2PodDetail', () => ({
  useV2PodDetail: () => ({
    pod: { _id: 'hq', name: 'Commonly HQ' },
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

jest.mock('../components/V2NavRail', () => (
  { onOpenGuide }: { onOpenGuide?: () => void },
) => (
  <nav>
    Rail
    {onOpenGuide && <button type="button" onClick={onOpenGuide}>Guide</button>}
  </nav>
));
jest.mock('../components/V2PodsSidebar', () => () => <aside>Pods</aside>);
jest.mock('../components/V2PodInspector', () => () => <aside>Inspector</aside>);
jest.mock('../components/V2InviteModal', () => () => null);
jest.mock('../components/V2PodChat', () => ({ firstRunVisible }: { firstRunVisible?: boolean }) => (
  <main data-testid="pod-chat">
    <span>Normal pod view</span>
    {!firstRunVisible && <span>Quiet pod empty state</span>}
  </main>
));

const unissued = {
  issued: false,
  connected: false,
  lastUsedAt: null,
  connectedAgent: null,
};

const connected = {
  issued: true,
  connected: true,
  lastUsedAt: '2026-07-21T12:00:00.000Z',
  connectedAgent: {
    agentName: 'claude-code',
    instanceId: 'my-claude',
    podId: 'workspace-1',
  },
};

const renderHero = () => render(
  <MemoryRouter>
    <V2FirstRunHero />
  </MemoryRouter>,
);

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('V2FirstRunHero', () => {
  const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    mockGet.mockResolvedValue(unissued);
    mockPost.mockResolvedValue({ room: { _id: 'room-1' } });
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  });

  test('keeps the setup visible while polling from waiting to connected, then opens the agent room', async () => {
    mockGet
      .mockResolvedValueOnce(unissued)
      .mockResolvedValueOnce(connected);

    renderHero();
    await flush();

    expect(screen.getByRole('dialog', { name: 'Bring your agent into the room' }))
      .toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Waiting for your agent to connect…')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open connection setup/i })).toHaveAttribute('target', '_blank');

    await act(async () => {
      jest.advanceTimersByTime(3_000);
      await Promise.resolve();
    });

    expect(await screen.findByText('✓ Connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Say hello' }));
    await flush();

    expect(mockPost).toHaveBeenCalledWith('/api/agents/runtime/room', {
      agentName: 'claude-code',
      instanceId: 'my-claude',
      podId: 'workspace-1',
    });
    expect(mockNavigate).toHaveBeenCalledWith('/v2/pods/room-1');
    expect(localStorage.getItem(FIRST_RUN_DISMISSED_KEY)).toBe('1');
  });

  test('stops polling after unmount', async () => {
    const view = renderHero();
    await flush();
    expect(mockGet).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => {
      jest.advanceTimersByTime(9_000);
      await Promise.resolve();
    });

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  test('pauses polling while the tab is hidden and resumes when visible', async () => {
    renderHero();
    await flush();
    expect(mockGet).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      jest.advanceTimersByTime(6_000);
      await Promise.resolve();
    });
    expect(mockGet).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  test('an established owner does not see first-run again unless setup was already started', async () => {
    mockGet.mockResolvedValue({ ...connected, connected: false, connectedAgent: null });
    renderHero();

    // The ownership probe must not flash the onboarding card while it resolves.
    expect(screen.queryByRole('heading', { name: 'Bring your agent into the room' })).not.toBeInTheDocument();
    await flush();

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Bring your agent into the room' })).not.toBeInTheDocument();
    });
  });

  test('dismissal persists and avoids starting the poll', async () => {
    localStorage.setItem(FIRST_RUN_DISMISSED_KEY, '1');
    renderHero();
    await flush();

    expect(screen.queryByRole('heading', { name: 'Bring your agent into the room' })).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('dismisses the first-run modal with Escape', async () => {
    const priorControl = document.createElement('button');
    document.body.appendChild(priorControl);
    priorControl.focus();
    renderHero();
    await flush();

    expect(screen.getByRole('dialog', { name: 'Bring your agent into the room' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Bring your agent into the room' })).not.toBeInTheDocument();
    expect(localStorage.getItem(FIRST_RUN_DISMISSED_KEY)).toBe('1');
    expect(priorControl).toHaveFocus();
    priorControl.remove();
  });

  test('dismisses the first-run modal from the backdrop', async () => {
    renderHero();
    await flush();

    const dialog = screen.getByRole('dialog', { name: 'Bring your agent into the room' });
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);

    expect(screen.queryByRole('dialog', { name: 'Bring your agent into the room' })).not.toBeInTheDocument();
    expect(localStorage.getItem(FIRST_RUN_DISMISSED_KEY)).toBe('1');
  });

  test('the started latch survives a reload until the connected CTA is used', async () => {
    localStorage.setItem(FIRST_RUN_STARTED_KEY, '1');
    mockGet.mockResolvedValue(connected);
    renderHero();
    await flush();

    expect(await screen.findByRole('button', { name: 'Say hello' })).toBeInTheDocument();
  });
});

describe('V2Layout first-run placement', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    mockGet.mockResolvedValue(unissued);
    mockPodsState.pods = [{
      _id: 'hq',
      name: 'Commonly HQ',
      members: [
        { _id: 'human-1', username: 'new-human' },
        { _id: 'someone-elses-agent', username: 'support', isBot: true },
      ],
    }];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('shows onboarding as a shell-level modal when the human owns no installation', async () => {
    render(
      <MemoryRouter initialEntries={['/v2/pods/hq']}>
        <Routes>
          <Route path="/v2/pods/:podId" element={<V2Layout selectionMode="param" />} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();

    expect(screen.getByText('Normal pod view')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Bring your agent into the room' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId('pod-chat')).not.toContainElement(dialog);
    expect(mockGet).toHaveBeenCalledWith('/api/users/me/agent-connection');

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => {
      expect(screen.getByText('Quiet pod empty state')).toBeInTheDocument();
    });
  });

  test('keeps the shell unblocked when first-run was already dismissed', async () => {
    localStorage.setItem(FIRST_RUN_DISMISSED_KEY, '1');
    render(
      <MemoryRouter initialEntries={['/v2/pods/hq']}>
        <Routes>
          <Route path="/v2/pods/:podId" element={<V2Layout selectionMode="param" />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Quiet pod empty state')).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog', { name: 'Bring your agent into the room' })).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('reopens the dismissed guide from the rail and restores onboarding suppression', async () => {
    localStorage.setItem(FIRST_RUN_DISMISSED_KEY, '1');
    render(
      <MemoryRouter initialEntries={['/v2/pods/hq']}>
        <Routes>
          <Route path="/v2/pods/:podId" element={<V2Layout selectionMode="param" />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Quiet pod empty state')).toBeInTheDocument();
    });
    expect(mockGet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));

    expect(await screen.findByRole('dialog', { name: 'Bring your agent into the room' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Quiet pod empty state')).not.toBeInTheDocument();
    expect(localStorage.getItem(FIRST_RUN_DISMISSED_KEY)).toBeNull();
    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBe('1');
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/api/users/me/agent-connection');
    });
  });
});
