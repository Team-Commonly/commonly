import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import axios from 'axios';
import { AuthProvider } from '../../context/AuthContext';
import { AppProvider } from '../../context/AppContext';
import V2App from '../V2App';
import V2MessageRow from '../components/V2MessageRow';

jest.mock('axios', () => {
  const client = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: client, ...client };
});

jest.mock('../hooks/useV2PodDetail', () => ({
  useV2PodDetail: () => ({ pod: null, members: [], messages: [], agents: [], loading: false, error: null }),
}));
jest.mock('../hooks/useV2PodAttention', () => ({
  useV2PodAttention: () => ({ items: [], count: 0, countByPod: {} }),
  notifyAttentionChanged: jest.fn(),
}));
jest.mock('../hooks/useV2Pinned', () => ({
  useV2Pinned: () => ({ pinned: [], toggle: jest.fn() }),
}));
jest.mock('../components/V2NavRail', () => () => null);
jest.mock('../components/V2Thread', () => () => null);
jest.mock('../components/V2Inspector', () => () => null);
jest.mock('../components/V2InviteModal', () => () => null);
jest.mock('../components/V2FirstRunHero', () => () => null);
jest.mock('../components/V2MobileTabs', () => () => null);

// The V1 ChatRoom must never mount inside v2 again (finding 1, 11-04).
jest.mock('../../components/ChatRoom', () => function LegacyChatRoom() { return <div data-testid="v1-chatroom" />; });
jest.mock('../components/V2PodBoard', () => function PodBoard() { return <div data-testid="v2-board" />; });

// Finding 1 of the 11-04 consistency audit: in-v2 links reached the legacy
// MUI ChatRoom at /v2/pods/chat/:id. Every such path now lands on the v2 pod
// view at /v2/pods/:id, keeping the message deep link the pod view reads.
const Path = () => {
  const location = useLocation();
  return <span data-testid="path">{`${location.pathname}${location.search}${location.hash}`}</span>;
};

const renderShell = (path: string) => render(
  <AuthProvider>
    <AppProvider>
      <MemoryRouter initialEntries={[path]}>
        <Path />
        <Routes>
          <Route path="/v2/*" element={<V2App />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  </AuthProvider>,
);

const landsOn = async (expected: string) => {
  await waitFor(() => expect(screen.getByTestId('path').textContent).toBe(expected));
  expect(screen.queryByTestId('v1-chatroom')).toBeNull();
};

describe('legacy chat routes inside v2', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('token', 'test-token');
    jest.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() })),
    });
    (axios.get as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/auth/user') {
        return Promise.resolve({ data: { _id: 'human-1', username: 'human', email: 'human@example.test', verified: true } });
      }
      if (url === '/api/pods') {
        return Promise.resolve({ data: [
          { _id: 'workspace', name: 'Workspace', type: 'chat', createdBy: { _id: 'human-1' } },
          { _id: 'crew', name: 'Crew', type: 'team', createdBy: { _id: 'human-1' } },
        ] });
      }
      if (url === '/api/posts') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
    (axios.post as jest.Mock).mockResolvedValue({ data: {} });
  });

  afterEach(() => localStorage.clear());

  test('/v2/chat/:id opens the v2 pod view, not the legacy room', async () => {
    renderShell('/v2/chat/workspace');
    await landsOn('/v2/pods/workspace');
  });

  test('/v2/chat/:id keeps a ?message= deep link', async () => {
    renderShell('/v2/chat/workspace?message=m-42');
    await landsOn('/v2/pods/workspace?message=m-42');
  });

  test('/v2/chat/:id keeps a #message- deep link', async () => {
    renderShell('/v2/chat/workspace#message-m-42');
    await landsOn('/v2/pods/workspace#message-m-42');
  });

  test('an old /v2/pods/chat/:id link opens the v2 pod view', async () => {
    renderShell('/v2/pods/chat/workspace?message=m-7');
    await landsOn('/v2/pods/workspace?message=m-7');
  });

  test('a team pod under the legacy shape opens the v2 pod view', async () => {
    renderShell('/v2/pods/team/crew');
    await landsOn('/v2/pods/crew');
  });

  test('the v2 board route is untouched', async () => {
    renderShell('/v2/pods/workspace/board');
    await waitFor(() => expect(screen.getByTestId('v2-board')).toBeInTheDocument());
    expect(screen.getByTestId('path').textContent).toBe('/v2/pods/workspace/board');
  });
});

describe('pod links inside a v2 message', () => {
  test('clicking a pod link lands on the v2 pod view', () => {
    render(<AuthProvider>
      <MemoryRouter initialEntries={['/v2/pods/workspace']}>
        <Path />
        <Routes>
          <Route path="*" element={<V2MessageRow message={{
            id: 'mention-location', pod_id: 'workspace', user_id: 'viewer-1', message_type: 'text',
            content: '@rhea review', created_at: '2026-10-24T10:00:00.000Z', user: { username: 'viewer' },
            mentionNotices: [{ code: 'MENTION_NOT_IN_POD', handle: 'rhea', message: 'API feedback',
              pods: [{ id: 'reviews-pod', name: 'Reviews' }] }],
          }} />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>);
    fireEvent.click(screen.getByRole('link', { name: 'Reviews' }));
    expect(screen.getByTestId('path').textContent).toBe('/v2/pods/reviews-pod');
  });
});
