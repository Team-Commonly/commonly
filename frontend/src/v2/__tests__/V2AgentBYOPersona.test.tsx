// @ts-nocheck
// Sam (2026-09-01): "Hire an agent" and "Add a computer" converged on this
// page with the persona silently dropped. Pinned: a ?persona= param renders
// a context card, names the agent after the persona, and the
// install request records the choice. The bare entry renders no persona
// block at all: TASK-163 removed the "No colleague selected" notice, which
// described a catalog choice this page cannot offer (nothing in src links
// ?persona= since #1534), while the ?persona= reader above stays live.
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
  });

  test('the bare entry renders no persona block, and does not link to the retired catalog', async () => {
    mockGet();
    const { container } = renderPage();
    // Absence IS the assertion here (TASK-163). The old notice rendered on
    // every entry without ?persona=, and its testid is gone with it, so a
    // queryByTestId('byo-persona-none') would now be vacuously null — hence
    // the class query plus the positive proof that the page still rendered.
    await waitFor(() => expect(screen.getByDisplayValue('sam-agent')).toBeInTheDocument());
    expect(container.querySelector('.v2-byo__persona')).toBeNull();
    expect(screen.queryByRole('button', { name: /browse colleagues/i })).toBeNull();
  });

  test('an unknown persona key falls back to the bare entry, not a crash', async () => {
    window.history.pushState({}, '', '/v2/agents/byo?persona=not-a-real-persona');
    mockGet();
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByDisplayValue('sam-agent')).toBeInTheDocument());
    expect(container.querySelector('.v2-byo__persona')).toBeNull();
    expect(container.querySelector('.v2-byo__form')).toBeInTheDocument();
  });
});
