// @ts-nocheck
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import V2Showcase from '../V2Showcase';

// The showcase fetches through a dedicated token-less axios instance created
// via axios.create(). Route every `.get` on that instance through mockGet so we
// can drive both the info and messages endpoints. The default-instance shape
// mirrors V2MarketplaceDetailPage.test.tsx so transitive axios.defaults /
// interceptor access during import doesn't throw.
const mockGet = jest.fn();
jest.mock('axios', () => {
  const instance = {
    get: (...args: unknown[]) => mockGet(...args),
    post: jest.fn(),
  };
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(() => instance),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

// V2MessageBubble (reused for read-only rendering) pulls the current user via
// useAuth — anonymous here, so token/currentUser are null.
jest.mock('../../../context/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ token: null, currentUser: null, isAuthenticated: false }),
}));

const renderAt = (podId: string, search = '') => render(
  <MemoryRouter initialEntries={[`/v2/showcase/${podId}${search}`]}>
    <Routes>
      <Route path="/v2/showcase/:podId" element={<V2Showcase />} />
      <Route path="/v2/landing" element={<div>landing-page</div>} />
      <Route path="/v2/register" element={<div>register-page</div>} />
    </Routes>
  </MemoryRouter>,
);

describe('V2Showcase', () => {
  beforeEach(() => {
    mockGet.mockReset();
    // jsdom has no scrollIntoView; the showcase auto-scroll effect calls it.
    // Polyfill so the effect can't throw mid-render during assertions.
    (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = jest.fn();
  });

  test('renders the room, agents, and read-only messages on success', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/messages')) {
        return Promise.resolve({
          data: {
            messages: [
              {
                id: '1',
                author: { username: 'sam', displayName: 'Sam', profilePicture: null, isBot: false },
                content: 'Welcome to the room',
                createdAt: new Date().toISOString(),
              },
              {
                id: '2',
                author: { username: 'openclaw-nova', displayName: 'Nova', profilePicture: null, isBot: true },
                content: 'On it — shipping a PR now',
                createdAt: new Date().toISOString(),
              },
            ],
            hasMore: false,
          },
        });
      }
      return Promise.resolve({
        data: {
          pod: {
            id: 'pod123',
            name: 'Engineering Pod',
            description: 'Where humans and agents ship together.',
            type: 'standard',
            memberCount: 4,
            createdAt: new Date().toISOString(),
          },
          members: [],
          agents: [
            { displayName: 'Nova', agentName: 'openclaw', instanceId: 'nova', profilePicture: null },
          ],
        },
      });
    });

    renderAt('pod123');

    await waitFor(() => expect(screen.getByText('Engineering Pod')).toBeInTheDocument());
    expect(screen.getByText('Welcome to the room')).toBeInTheDocument();
    expect(screen.getByText('On it — shipping a PR now')).toBeInTheDocument();
    // Conversion CTA is present and there is no composer / send affordance.
    expect(screen.getAllByText('Sign up to join').length).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText(/Message/i)).not.toBeInTheDocument();
  });

  test('load older fetches with a before cursor and prepends; a poll must not discard them', async () => {
    const info = { pod: { name: 'Room', memberCount: 2 }, agents: [] };
    const newest = [{ id: '10', content: 'newest-msg', author: { username: 'sam' }, createdAt: '2026-07-20T00:00:00Z' }];
    const older = [{ id: '1', content: 'ancient-msg', author: { username: 'sam' }, createdAt: '2026-07-01T00:00:00Z' }];
    mockGet.mockImplementation((url, cfg = {}) => {
      if (String(url).endsWith('/messages')) {
        return Promise.resolve({
          data: cfg?.params?.before ? { messages: older, hasMore: false } : { messages: newest, hasMore: true },
        });
      }
      return Promise.resolve({ data: info });
    });

    renderAt('abc');
    await screen.findByText('newest-msg');
    const btn = await screen.findByRole('button', { name: /load older/i });
    await act(async () => { btn.click(); });

    await screen.findByText('ancient-msg');
    expect(screen.getByText('newest-msg')).toBeInTheDocument();

    const paged = mockGet.mock.calls.find((c) => c[1]?.params?.before);
    expect(paged[1].params.before).toBe('2026-07-20T00:00:00Z');

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /load older/i })).not.toBeInTheDocument();
    });
  });

  test('pages back to find a ?m= permalink target, then highlights it', async () => {
    const info = { pod: { name: 'Room', memberCount: 2 }, agents: [] };
    const newest = [{ id: '10', content: 'newest-msg', author: { username: 'sam' }, createdAt: '2026-07-20T00:00:00Z' }];
    const older = [{ id: '3', content: 'target-msg', author: { username: 'sam' }, createdAt: '2026-07-02T00:00:00Z' }];
    mockGet.mockImplementation((url, cfg = {}) => {
      if (String(url).endsWith('/messages')) {
        return Promise.resolve({
          data: cfg?.params?.before ? { messages: older, hasMore: false } : { messages: newest, hasMore: true },
        });
      }
      return Promise.resolve({ data: info });
    });

    renderAt('abc', '?m=3');

    await screen.findByText('target-msg');
    await waitFor(() => {
      expect(document.getElementById('msg-3')?.className).toContain('v2-showcase__msg--target');
    });
  });

  test('renders the not-public state on a 404', async () => {
    mockGet.mockRejectedValue({ response: { status: 404 } });

    renderAt('private-pod');

    await waitFor(() => expect(screen.getByText("This room isn't public")).toBeInTheDocument());
    expect(screen.getByText('Start your own room')).toBeInTheDocument();
  });
});
