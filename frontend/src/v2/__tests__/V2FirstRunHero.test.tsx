/* eslint-disable react/display-name */
import React from 'react';
import {
  act, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2FirstRunHero, {
  FIRST_RUN_STARTED_KEY,
} from '../components/V2FirstRunHero';
import V2Layout from '../components/V2Layout';
import { requestFirstRunGuide } from '../firstRunGuide';

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

jest.mock('../components/V2NavRail', () => () => (
  <nav>
    Rail
    <button
      type="button"
      onClick={() => globalThis.dispatchEvent(new Event('commonly:reopen-first-run'))}
    >
      Guide
    </button>
  </nav>
));
jest.mock('../components/V2PodsSidebar', () => () => <aside>Pods</aside>);
jest.mock('../components/V2Inspector', () => () => <aside>Inspector</aside>);
jest.mock('../components/V2InviteModal', () => () => null);
jest.mock('../components/V2Thread', () => ({ firstRunVisible }: { firstRunVisible?: boolean }) => (
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

// The guide opens only when asked for (Feedback, then Guide). Since direction
// B (2026-10-15) it never opens on its own: Scout's starts are the first screen.
const askForGuide = async () => {
  act(() => {
    requestFirstRunGuide();
  });
  await flush();
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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await askForGuide();

    expect(screen.getByRole('dialog', { name: 'Bring your agent into your pod' }))
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
    // Completing ends the setup, so the guide does not come back on reload.
    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBeNull();
    // And it hands over to the room now: the card is mounted above the route,
    // so it must close itself rather than sit over the new room on
    // "Opening…", covering the message box (#2192).
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Opening…')).not.toBeInTheDocument();
  });

  test('a failed hand-over keeps the card open with its error, so the person can retry (#2192)', async () => {
    mockGet.mockResolvedValue(connected);
    mockPost.mockRejectedValueOnce({ response: { data: { message: 'room unavailable' } } });
    renderHero();
    await askForGuide();

    fireEvent.click(await screen.findByRole('button', { name: 'Say hello' }));
    await flush();

    expect(screen.getByRole('dialog', { name: 'Bring your agent into your pod' })).toBeInTheDocument();
    expect(screen.getByText('room unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Say hello' })).toBeEnabled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('stops polling after unmount', async () => {
    const view = renderHero();
    await askForGuide();
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
    await askForGuide();
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
    expect(screen.queryByRole('heading', { name: 'Bring your agent into your pod' })).not.toBeInTheDocument();
    await flush();

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Bring your agent into your pod' })).not.toBeInTheDocument();
    });
  });

  // Direction B (2026-10-15): Scout's welcome offers "Connect an agent I
  // already use" in the pod, so a modal over it would be a second connect path
  // on top of the first screen. A person with no agent gets no guide, and no
  // probe, until they ask for it.
  test('a person with no agent is not shown the guide on its own, and nothing polls', async () => {
    mockGet.mockResolvedValue(unissued);
    renderHero();
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(9_000);
      await Promise.resolve();
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('Skip ends the setup: the guide stays closed after a reload until asked for again', async () => {
    const { unmount } = renderHero();
    await askForGuide();
    expect(screen.getByRole('dialog', { name: 'Bring your agent into your pod' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBeNull();

    unmount();
    mockGet.mockClear();
    renderHero();
    await flush();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();

    await askForGuide();
    expect(screen.getByRole('dialog', { name: 'Bring your agent into your pod' })).toBeInTheDocument();
  });

  test('Escape dismisses the guide across reloads until asked for again', async () => {
    const priorControl = document.createElement('button');
    document.body.appendChild(priorControl);
    priorControl.focus();
    const { unmount } = renderHero();
    await askForGuide();

    expect(screen.getByRole('dialog', { name: 'Bring your agent into your pod' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Bring your agent into your pod' })).not.toBeInTheDocument();
    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBeNull();
    expect(priorControl).toHaveFocus();
    priorControl.remove();

    unmount();
    mockGet.mockClear();
    renderHero();
    await flush();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
    await askForGuide();
    expect(screen.getByRole('dialog', { name: 'Bring your agent into your pod' })).toBeInTheDocument();
  });

  test('a backdrop click dismisses the guide across reloads until asked for again', async () => {
    const { unmount } = renderHero();
    await askForGuide();

    const dialog = screen.getByRole('dialog', { name: 'Bring your agent into your pod' });
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);

    expect(screen.queryByRole('dialog', { name: 'Bring your agent into your pod' })).not.toBeInTheDocument();
    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBeNull();

    unmount();
    mockGet.mockClear();
    renderHero();
    await flush();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
    await askForGuide();
    expect(screen.getByRole('dialog', { name: 'Bring your agent into your pod' })).toBeInTheDocument();
  });

  test.each([
    {
      label: 'connected',
      status: connected,
      readyControl: 'Say hello',
    },
    {
      label: 'unconnected',
      status: unissued,
      readyControl: 'Open connection setup',
    },
  ])('opens for a $label user who asks for it, and Skip ends it', async ({
    status,
    readyControl,
  }) => {
    mockGet.mockResolvedValue(status);
    renderHero();
    await flush();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith('/api/users/me/agent-connection');

    act(() => {
      window.dispatchEvent(new Event('commonly:reopen-first-run'));
    });

    expect(screen.getByRole('dialog', { name: 'Bring your agent into your pod' }))
      .toBeInTheDocument();
    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBe('1');
    await flush();
    expect(await screen.findByRole(
      status.connected ? 'button' : 'link',
      { name: readyControl },
    )).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBeNull();
  });

  test('the started latch survives a reload until the connected CTA is used', async () => {
    localStorage.setItem(FIRST_RUN_STARTED_KEY, '1');
    mockGet.mockResolvedValue(connected);
    renderHero();
    await flush();

    expect(await screen.findByRole('button', { name: 'Say hello' })).toBeInTheDocument();
  });

  test('a Guide request made before the hero mounts opens it on the shell', async () => {
    requestFirstRunGuide();
    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBe('1');

    renderHero();
    await flush();

    expect(screen.getByRole('dialog', { name: 'Bring your agent into your pod' })).toBeInTheDocument();
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

  test('a person with no agent sees the pod, not a modal; asking opens the guide as a shell-level modal', async () => {
    render(
      <MemoryRouter initialEntries={['/v2/pods/hq']}>
        <Routes>
          <Route path="/v2/pods/:podId" element={<V2Layout selectionMode="param" />} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();

    // First open: the pod itself (Scout's starts live there), no dialog, no probe.
    await waitFor(() => {
      expect(screen.getByText('Quiet pod empty state')).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalledWith('/api/users/me/agent-connection');

    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    await flush();
    expect(screen.getByText('Normal pod view')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Bring your agent into your pod' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId('pod-chat')).not.toContainElement(dialog);
    expect(mockGet).toHaveBeenCalledWith('/api/users/me/agent-connection');

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => {
      expect(screen.getByText('Quiet pod empty state')).toBeInTheDocument();
    });
  });

  test('the rail entry opens the guide and starts its setup', async () => {
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
    expect(mockGet).not.toHaveBeenCalledWith('/api/users/me/agent-connection');

    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));

    expect(await screen.findByRole('dialog', { name: 'Bring your agent into your pod' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Quiet pod empty state')).not.toBeInTheDocument();
    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBe('1');
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/api/users/me/agent-connection');
    });
  });
});
