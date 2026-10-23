// @ts-nocheck
import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigationType } from 'react-router-dom';
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
  sessionStorage.clear();
});

describe('V2OAuthButtons', () => {
  test('posts an invite without nesting a form or exposing the code in a link', async () => {
    axios.get.mockResolvedValueOnce({
      data: { providers: [{ id: 'github', label: 'GitHub' }, { id: 'google', label: 'Google' }] },
    });
    render(
      <MemoryRouter>
        <V2OAuthButtons invite="CODE1" next="/v2/pods/abc" />
      </MemoryRouter>,
    );

    const github = await screen.findByRole('button', { name: /continue with github/i });
    expect(github).not.toHaveAttribute('href');
    expect(github.closest('form')).toBeNull();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();

    const submit = jest.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    fireEvent.click(github);
    const form = document.body.querySelector('form[action*="/api/auth/oauth/github/start"]') as HTMLFormElement;
    expect(form).toBeTruthy();
    expect(form).toHaveAttribute('method', 'post');
    expect(form).toHaveAttribute('action', expect.stringContaining('/api/auth/oauth/github/start'));
    expect(form.method).toBe('post');
    expect(form.action).toContain('/api/auth/oauth/github/start');
    expect(form.action).not.toContain('CODE1');
    const fields = Object.fromEntries(Array.from(form.elements)
      .filter((el) => el.name)
      .map((el) => [el.name, el.value]));
    expect(fields).toEqual({ next: '/v2/pods/abc', invite: 'CODE1' });

    expect(sessionStorage.getItem('commonly.pendingInviteOAuth')).toBe('1');
    form.remove();
    submit.mockRestore();
  });

  test('without an invite the button is a plain link and submits no form', async () => {
    axios.get.mockResolvedValueOnce({ data: { providers: [{ id: 'github', label: 'GitHub' }] } });
    const submit = jest.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});

    render(
      <MemoryRouter>
        <V2OAuthButtons />
      </MemoryRouter>,
    );

    const github = await screen.findByRole('link', { name: /continue with github/i });
    // jsdom can't follow the link; stop the navigation so only the form question is tested.
    github.addEventListener('click', (e) => e.preventDefault());
    act(() => { github.click(); });
    expect(submit).not.toHaveBeenCalled();
    submit.mockRestore();
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
  // A destination that says how it was reached: REPLACE keeps the spent
  // one-time code out of history, so Back can't re-post it.
  const Dest = ({ label }) => <p>{`${label} ${useNavigationType()}`}</p>;
  const renderComplete = (search: string, auth = baseAuth) => render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[`/v2/oauth/complete${search}`]}>
        <Routes>
          <Route path="/v2/oauth/complete" element={<V2OAuthComplete />} />
          <Route path="/v2/login" element={<V2Login />} />
          <Route path="/v2/pods/:podId" element={<Dest label="pod page" />} />
          <Route path="/v2" element={<Dest label="home" />} />
          <Route path="*" element={<p>in-app elsewhere</p>} />
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

    expect(await screen.findByText('pod page REPLACE')).toBeInTheDocument();
    expect(axios.post).toHaveBeenCalledWith('/api/auth/oauth/exchange', { code: 'one-time' });
    expect(signInWithToken).toHaveBeenCalledWith('session-jwt');
    expect(locationSpies.replace).not.toHaveBeenCalled();
    expect(locationSpies.assign).not.toHaveBeenCalled();
  });

  test('clears an invite only after an invite-bearing OAuth signup succeeds', async () => {
    sessionStorage.setItem('commonly.pendingInvite', 'CM-SIGNUP');
    sessionStorage.setItem('commonly.pendingInviteOAuth', '1');
    axios.post.mockResolvedValueOnce({ data: { token: 'session-jwt' } });

    await act(async () => {
      renderComplete('?code=one-time&next=/v2&inviteSignup=1');
    });

    await screen.findByText('home REPLACE');
    expect(sessionStorage.getItem('commonly.pendingInvite')).toBeNull();
    expect(sessionStorage.getItem('commonly.pendingInviteOAuth')).toBeNull();
  });

  test('keeps an earlier invite through an ordinary OAuth login', async () => {
    sessionStorage.setItem('commonly.pendingInvite', 'CM-EARLIER');
    axios.post.mockResolvedValueOnce({ data: { token: 'session-jwt' } });

    await act(async () => {
      renderComplete('?code=one-time&next=/v2');
    });

    await screen.findByText('home REPLACE');
    expect(sessionStorage.getItem('commonly.pendingInvite')).toBe('CM-EARLIER');
  });

  test('an off-site next (backslash, read as //) lands on /v2, not the other site', async () => {
    axios.post.mockResolvedValueOnce({ data: { token: 'session-jwt' } });

    await act(async () => {
      renderComplete(`?code=one-time&next=${encodeURIComponent('/\\evil.example/x')}`);
    });

    expect(await screen.findByText('home REPLACE')).toBeInTheDocument();
    expect(locationSpies.replace).not.toHaveBeenCalled();
  });

  // V2App unmounting would strip the v2-canvas body class that only the boot
  // stamps, so a destination outside /v2 keeps the load (sprint-review on
  // #2360). `/v2abc` passes safeNextPath and starts with "/v2", so it is the
  // case that pins the regex's boundary.
  test.each(['/', '/v2abc'])('%s keeps the full-page load, after the session is handed over', async (next) => {
    axios.post.mockResolvedValueOnce({ data: { token: 'session-jwt' } });
    const signInWithToken = jest.fn();

    await act(async () => {
      renderComplete(`?code=one-time&next=${encodeURIComponent(next)}`, { ...baseAuth, signInWithToken });
    });

    await waitFor(() => expect(locationSpies.replace).toHaveBeenCalledWith(next));
    expect(signInWithToken).toHaveBeenCalledWith('session-jwt');
    // Full load only: nothing navigated in-app as well.
    expect(screen.queryByText('in-app elsewhere')).toBeNull();
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
    sessionStorage.setItem('commonly.pendingInvite', 'CM-RETRY');
    sessionStorage.setItem('commonly.pendingInviteOAuth', '1');
    axios.post.mockRejectedValueOnce(new Error('bad code'));
    // The login page fetches providers on mount after the bounce.
    axios.get.mockResolvedValue({ data: { providers: [] } });

    await act(async () => {
      renderComplete('?code=stale');
    });

    expect(await screen.findByText(/sign-in could not be completed/i)).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
    expect(sessionStorage.getItem('commonly.pendingInvite')).toBe('CM-RETRY');
    expect(sessionStorage.getItem('commonly.pendingInviteOAuth')).toBeNull();
  });
});
