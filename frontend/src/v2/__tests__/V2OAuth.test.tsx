// @ts-nocheck
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import V2OAuthButtons from '../components/V2OAuthButtons';
import V2OAuthComplete from '../components/V2OAuthComplete';
import V2Login from '../components/V2Login';
import { AuthContext } from '../../context/AuthContext';

// Same mock surface as V2Login.test.tsx — axiosConfig assigns
// axios.defaults.baseURL at import time.
jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
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

afterEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

describe('V2OAuthButtons', () => {
  test('renders a button per configured provider with invite carried through', async () => {
    axios.get.mockResolvedValueOnce({
      data: { providers: [{ id: 'github', label: 'GitHub' }, { id: 'google', label: 'Google' }] },
    });

    render(
      <MemoryRouter>
        <V2OAuthButtons invite="CODE1" />
      </MemoryRouter>,
    );

    const github = await screen.findByRole('link', { name: /continue with github/i });
    expect(github).toHaveAttribute('href', expect.stringContaining('/api/auth/oauth/github/start'));
    expect(github).toHaveAttribute('href', expect.stringContaining('invite=CODE1'));
    expect(screen.getByRole('link', { name: /continue with google/i })).toBeInTheDocument();
  });

  test('renders nothing when no provider is configured', async () => {
    axios.get.mockResolvedValueOnce({ data: { providers: [] } });

    const { container } = render(
      <MemoryRouter>
        <V2OAuthButtons />
      </MemoryRouter>,
    );

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/oauth/providers'));
    expect(container).toBeEmptyDOMElement();
  });

  test('falls back to cached providers when the fetch fails (no blank SSO on a blip)', async () => {
    // Prior successful load cached the providers; this mount's fetch fails.
    localStorage.setItem('v2:oauth-providers', JSON.stringify([{ id: 'github', label: 'GitHub' }]));
    axios.get.mockRejectedValueOnce(new Error('network blip'));

    render(
      <MemoryRouter>
        <V2OAuthButtons />
      </MemoryRouter>,
    );

    // The button shows immediately from cache and is NOT blanked by the failure.
    expect(await screen.findByRole('link', { name: /continue with github/i })).toBeInTheDocument();
  });

  test('retries a transient failure and shows buttons once it recovers', async () => {
    localStorage.clear();
    axios.get
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue({ data: { providers: [{ id: 'google', label: 'Google' }] } });

    render(
      <MemoryRouter>
        <V2OAuthButtons />
      </MemoryRouter>,
    );

    // First attempt fails (no cache → nothing yet); the backoff retry (~800ms)
    // succeeds. Allow headroom for the backoff delay.
    expect(await screen.findByRole('link', { name: /continue with google/i }, { timeout: 3000 }))
      .toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});

describe('V2OAuthComplete', () => {
  const renderComplete = (search: string) => render(
    <AuthContext.Provider value={baseAuth}>
      <MemoryRouter initialEntries={[`/v2/oauth/complete${search}`]}>
        <Routes>
          <Route path="/v2/oauth/complete" element={<V2OAuthComplete />} />
          <Route path="/v2/login" element={<V2Login />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  test('exchanges the one-time code and stores the session token', async () => {
    axios.post.mockResolvedValueOnce({ data: { token: 'session-jwt' } });
    const replaceSpy = jest.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, replace: replaceSpy },
    });

    await act(async () => {
      renderComplete('?code=one-time&next=/v2/pods/abc');
    });

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith('/api/auth/oauth/exchange', { code: 'one-time' });
      expect(localStorage.getItem('token')).toBe('session-jwt');
      expect(replaceSpy).toHaveBeenCalledWith('/v2/pods/abc');
    });

    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  test('bounces to login with an error when the exchange fails', async () => {
    axios.post.mockRejectedValueOnce(new Error('bad code'));
    // The login page fetches providers on mount after the bounce.
    axios.get.mockResolvedValue({ data: { providers: [] } });

    await act(async () => {
      renderComplete('?code=stale');
    });

    expect(await screen.findByText(/sign-in could not be completed/i)).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
  });
});
