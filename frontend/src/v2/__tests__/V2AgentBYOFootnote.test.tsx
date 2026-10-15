// @ts-nocheck
// The CLI footnote must lead people to the listener shown after install.
// `agent init` scaffolds a Python webhook and does not connect Claude/Codex.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

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

beforeEach(() => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines: [], offlineAfterMs: 90000 } });
    return Promise.resolve({ data: {} });
  });
});

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2AgentBYO footnote', () => {
  test('names the runtime mode leading to the listener, even from Run it here', async () => {
    renderPage();
    const footnote = await screen.findByText(/Prefer the CLI\?/);
    expect(footnote).toHaveTextContent('Choose Bring your own runtime; after install');
    expect(footnote).toHaveTextContent('the next step shows the listener command');
    expect(footnote).not.toHaveTextContent('commonly agent init');

    fireEvent.click(await screen.findByTestId('byo-mode-hosted'));
    expect(footnote).toHaveTextContent('Choose Bring your own runtime; after install');
  });
});
