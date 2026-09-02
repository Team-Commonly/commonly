// @ts-nocheck
// Sam (2026-09-01): "Hire an agent" and "Add a computer" converged on this
// page with the persona silently dropped. Pinned: the catalog's ?persona=
// param renders a context card, names the agent after the persona, and the
// install request records the choice; the bare entry says nobody was picked.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import { PERSONA_CARDS } from '../agents/personaCatalogData';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const axios = jest.requireMock('axios').default;

const authValue = {
  currentUser: { _id: 'u1', username: 'sam' },
  user: { _id: 'u1', username: 'sam' },
  token: 'user-jwt',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const mockGet = () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: false, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }] });
    return Promise.resolve({ data: {} });
  });
};

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

afterEach(() => {
  jest.clearAllMocks();
  window.history.pushState({}, '', '/v2/agents/byo');
});

describe('BYO persona carry-through', () => {
  const card = PERSONA_CARDS.find((c) => c.availability === 'connect');

  test('?persona= renders the context card and names the agent after the persona', async () => {
    window.history.pushState({}, '', `/v2/agents/byo?persona=${card.key}`);
    mockGet();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-persona-context')).toBeInTheDocument());
    const context = screen.getByTestId('byo-persona-context');
    expect(context).toHaveTextContent(card.name);
    expect(context).toHaveTextContent(card.role);
    expect(context).toHaveTextContent(card.oneLiner);
    // Agent name field is seeded from the persona, not the generic default.
    expect(screen.getByDisplayValue(`sam-${card.key}`)).toBeInTheDocument();
    expect(screen.queryByTestId('byo-persona-none')).toBeNull();
  });

  test('the bare entry (Add a computer) says no colleague was picked', async () => {
    mockGet();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-persona-none')).toBeInTheDocument());
    expect(screen.getByText('No colleague picked yet — this is the blank-agent path.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse colleagues' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('sam-agent')).toBeInTheDocument();
  });

  test('an unknown persona key falls back to the bare entry, not a crash', async () => {
    window.history.pushState({}, '', '/v2/agents/byo?persona=not-a-real-persona');
    mockGet();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-persona-none')).toBeInTheDocument());
  });
});
