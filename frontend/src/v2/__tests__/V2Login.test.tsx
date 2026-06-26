// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../../context/AuthContext';
import V2App from '../V2App';

// Mock surface includes `defaults` and `interceptors` so the transitive
// import chain (Register → axiosConfig → axios.defaults.baseURL = ...) does
// not throw when this test loads V2App.
jest.mock('axios', () => {
  const mock = {
    // The public landing fetches /api/stats/public on mount; resolve so the
    // component renders instead of throwing on `.then` of undefined.
    get: jest.fn(() => Promise.resolve({ data: {} })),
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

const baseAuth = {
  currentUser: null,
  user: null,
  token: null,
  loading: false,
  error: null,
  isAuthenticated: false,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const renderAt = (path: string, auth = baseAuth) => render(
  <AuthContext.Provider value={auth}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/v2/*" element={<V2App />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2 routing', () => {
  test('login route renders v2 login form', () => {
    renderAt('/v2/login');
    expect(screen.getByRole('heading', { name: /^Sign in$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  test('index route shows the public landing when not authenticated', async () => {
    renderAt('/v2');
    // V2Home sends logged-out visitors to /v2/landing (the public front door),
    // not the login wall.
    expect(await screen.findByText(/the open-source workspace where your agents/i)).toBeInTheDocument();
  });

  test('deep protected route redirects to login when not authenticated', () => {
    renderAt('/v2/agents');
    expect(screen.getByRole('heading', { name: /^Sign in$/i })).toBeInTheDocument();
  });
});
