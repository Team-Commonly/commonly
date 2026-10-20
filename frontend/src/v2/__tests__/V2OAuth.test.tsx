// @ts-nocheck
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import V2OAuthButtons from '../components/V2OAuthButtons';
import V2OAuthComplete from '../components/V2OAuthComplete';
import V2Login from '../components/V2Login';
import { AuthContext, AuthProvider, useAuth } from '../../context/AuthContext';

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
  signInWithToken: jest.fn(),
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

  test('carries the first-touch ref into the provider start', async () => {
    localStorage.setItem('commonly.firstTouchRef', JSON.stringify({ ref: 'x' }));
    axios.get.mockResolvedValueOnce({ data: { providers: [{ id: 'google', label: 'Google' }] } });

    render(
      <MemoryRouter>
        <V2OAuthButtons />
      </MemoryRouter>,
    );

    const google = await screen.findByRole('link', { name: /continue with google/i });
    expect(new URL(google.getAttribute('href') as string, 'https://api.test').searchParams.get('ref')).toBe('x');
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
  const renderComplete = (search: string, auth = baseAuth) => render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[`/v2/oauth/complete${search}`]}>
        <Routes>
          <Route path="/v2/oauth/complete" element={<V2OAuthComplete />} />
          <Route path="/v2/login" element={<V2Login />} />
          <Route path="/v2/pods/:podId" element={<p>pod page</p>} />
          <Route path="/v2" element={<p>home</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  // A full-page navigation would go through window.location; the in-app one
  // must not touch it.
  let locationSpies;
  const originalLocation = window.location;
  beforeEach(() => {
    locationSpies = { replace: jest.fn(), assign: jest.fn() };
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, origin: originalLocation.origin, ...locationSpies },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  test('exchanges the one-time code, hands the session to AuthContext and navigates in-app', async () => {
    axios.post.mockResolvedValueOnce({ data: { token: 'session-jwt' } });
    const signInWithToken = jest.fn();

    await act(async () => {
      renderComplete('?code=one-time&next=/v2/pods/abc', { ...baseAuth, signInWithToken });
    });

    expect(await screen.findByText('pod page')).toBeInTheDocument();
    expect(axios.post).toHaveBeenCalledWith('/api/auth/oauth/exchange', { code: 'one-time' });
    expect(signInWithToken).toHaveBeenCalledWith('session-jwt');
    expect(locationSpies.replace).not.toHaveBeenCalled();
    expect(locationSpies.assign).not.toHaveBeenCalled();
  });

  test('an off-site next (backslash, read as //) lands on /v2, not the other site', async () => {
    axios.post.mockResolvedValueOnce({ data: { token: 'session-jwt' } });

    await act(async () => {
      renderComplete(`?code=one-time&next=${encodeURIComponent('/\\evil.example/x')}`);
    });

    expect(await screen.findByText('home')).toBeInTheDocument();
    expect(locationSpies.replace).not.toHaveBeenCalled();
  });

  test('with the real AuthProvider, the destination waits for the user and then renders signed in', async () => {
    // The guard every signed-in route uses: boot screen while loading,
    // signed-out page without a token.
    const Guarded = () => {
      const { loading, isAuthenticated, currentUser } = useAuth();
      if (loading) return <p>booting</p>;
      if (!isAuthenticated) return <p>signed out</p>;
      return <p>{`signed in as ${currentUser?.username}`}</p>;
    };
    let resolveUser;
    axios.post.mockResolvedValueOnce({ data: { token: 'session-jwt' } });
    axios.get.mockImplementation((url) => (url === '/api/auth/user'
      ? new Promise((resolve) => { resolveUser = resolve; })
      : Promise.resolve({ data: {} })));

    await act(async () => {
      render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/v2/oauth/complete?code=one-time&next=/v2']}>
            <Routes>
              <Route path="/v2/oauth/complete" element={<V2OAuthComplete />} />
              <Route path="/v2" element={<Guarded />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>,
      );
    });

    // Never the signed-out page in between: loading holds until the user is in.
    expect(await screen.findByText('booting')).toBeInTheDocument();
    expect(screen.queryByText('signed out')).toBeNull();
    expect(localStorage.getItem('token')).toBe('session-jwt');

    await act(async () => {
      resolveUser({ data: { _id: 'u1', username: 'ada', email: 'ada@example.com' } });
    });

    expect(await screen.findByText('signed in as ada')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/auth/user', { headers: { Authorization: 'Bearer session-jwt' } });
    expect(locationSpies.replace).not.toHaveBeenCalled();
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
