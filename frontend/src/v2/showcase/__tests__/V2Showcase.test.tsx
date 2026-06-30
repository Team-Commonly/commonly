// @ts-nocheck
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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

const renderAt = (podId: string) => render(
  <MemoryRouter initialEntries={[`/v2/showcase/${podId}`]}>
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

  test('renders the not-public state on a 404', async () => {
    mockGet.mockRejectedValue({ response: { status: 404 } });

    renderAt('private-pod');

    await waitFor(() => expect(screen.getByText("This room isn't public")).toBeInTheDocument());
    expect(screen.getByText('Start your own room')).toBeInTheDocument();
  });
});
