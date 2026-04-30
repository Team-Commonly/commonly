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
    expect(screen.getByRole('heading', { name: /Sign in to v2/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  test('protected route redirects to login when not authenticated', () => {
    renderAt('/v2');
    expect(screen.getByRole('heading', { name: /Sign in to v2/i })).toBeInTheDocument();
  });
});
