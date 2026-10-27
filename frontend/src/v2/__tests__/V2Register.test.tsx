// @ts-nocheck
import React from 'react';
import {
  fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import {
  MemoryRouter, Route, Routes, useLocation,
} from 'react-router-dom';
import V2Register from '../components/V2Register';
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

const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
};

const renderRegister = (login = jest.fn().mockResolvedValue({}), entry = '/v2/register') => {
  const auth = {
    currentUser: null,
    user: null,
    token: null,
    loading: false,
    error: null,
    isAuthenticated: false,
    register: jest.fn(),
    login,
    logout: jest.fn(),
    updateProfile: jest.fn(),
  };

  return {
    login,
    ...render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/v2/register" element={<V2Register />} />
            <Route path="/v2/*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    ),
  };
};

describe('V2Register', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockImplementation((url) => (
      url === '/api/auth/registration-policy'
        ? Promise.resolve({ data: { inviteOnly: false } })
        : Promise.resolve({ data: { providers: [] } })
    ));
    axios.post.mockResolvedValue({
      data: { message: 'Registered. Verify your email to join the Community pod.' },
    });
  });

  it('signs in with the submitted credentials and enters the workspace', async () => {
    const { login } = renderRegister();

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('new@example.com', 'Password123!'));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2');
  });

  // TASK-290 A: the page asks for an email and a password only; the server
  // derives the handle from the email.
  it('asks for no username and sends none', async () => {
    renderRegister();

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    expect(screen.queryByLabelText(/username/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/auth/register', expect.anything()));
    expect(axios.post.mock.calls[0][1]).not.toHaveProperty('username');
  });

  const createAccount = async () => {
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
  };

  it('lands a new account on the deep link it signed up from', async () => {
    const deepLink = encodeURIComponent('/v2/agents/byo?mode=hosted');
    const { login } = renderRegister(undefined, `/v2/register?next=${deepLink}`);

    await createAccount();

    await waitFor(() => expect(login).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/v2/agents/byo?mode=hosted'));
  });

  it.each([
    ['protocol-relative', '//evil.example/x'],
    ['dot-segment (normalises to //)', '/.//evil.example/x'],
  ])('drops a %s next and enters the workspace instead', async (_label, next) => {
    const { login } = renderRegister(undefined, `/v2/register?next=${encodeURIComponent(next)}`);

    await createAccount();

    await waitFor(() => expect(login).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/v2$/));
  });

  it('sends the first-touch ref with the signup', async () => {
    localStorage.setItem('commonly.firstTouchRef', JSON.stringify({ ref: 'x' }));
    localStorage.setItem('commonly.signupSource.v1', JSON.stringify({ landingPath: '/guides/start', ref: 'x' }));
    renderRegister();

    await createAccount();

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/auth/register',
      expect.objectContaining({ signupRef: 'x', signupSource: expect.objectContaining({ landingPath: '/guides/start', ref: 'x' }) }),
    ));
    localStorage.clear();
  });

  it('keeps the sign-in fallback when the immediate login is unavailable', async () => {
    const { login } = renderRegister(jest.fn().mockRejectedValue(new Error('login unavailable')));

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('heading', { name: "You're in" })).toBeInTheDocument();
    // The sentence names the gate — joining the Community pod — and the address
    // it went to: the same sentence the in-app banner shows.
    expect(screen.getByText(
      'Verify your email to join the Community pod — link sent to new@example.com.',
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sign in now' })).toHaveAttribute('href', '/v2/login');
    expect(login).toHaveBeenCalledWith('new@example.com', 'Password123!');
  });

  it('tells a new team user to verify before signing in', async () => {
    const login = jest.fn().mockRejectedValue({
      response: { data: { code: 'INSTANCE_ACCESS_RESTRICTED' } },
    });
    renderRegister(login);

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/Verify your email first, then/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/v2/login');
    expect(screen.queryByRole('link', { name: 'sign in now' })).not.toBeInTheDocument();
  });

  it('still shows the reminder for the pre-2026-09-23 wording a rolling backend sends', async () => {
    // The one arm with no other guard: an old backend answering a new frontend,
    // which is the window this ships through. Dropping `check your email` from
    // the regex left the file green until this case existed.
    axios.post.mockResolvedValue({
      data: { message: 'User registered successfully. Check your email for verification.' },
    });
    renderRegister(jest.fn().mockRejectedValue(new Error('login unavailable')));

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('heading', { name: "You're in" })).toBeInTheDocument();
    expect(screen.getByText(/join the Community pod/)).toBeInTheDocument();
  });

  it('shows the plain created screen when verification is not required', async () => {
    // The screen is selected from the response's prose, so both directions are
    // pinned: a message naming verification shows the reminder, one saying none is
    // needed shows the plain created state. A copy edit that drops both phrases
    // would otherwise silently strand the reminder screen.
    axios.post.mockResolvedValue({
      data: { message: 'User registered successfully. Email verification is not required.' },
    });
    renderRegister(jest.fn().mockRejectedValue(new Error('login unavailable')));

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('heading', { name: 'Account created' })).toBeInTheDocument();
    expect(screen.queryByText(/join the Community pod/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'sign in now' })).not.toBeInTheDocument();
  });

  // QA 2026-10-16: the field said the code "Unlocks hosted agents", but
  // "Run it here" works without one (hosted is capped per user, not gated), so
  // a stranger with no code read hosting as locked. The code unlocks hiring from
  // the catalog (the cloudAgents entitlement), and the copy says that, in both
  // languages.
  it('never tells a stranger the invitation code unlocks hosting', async () => {
    renderRegister();

    const field = await screen.findByLabelText(/invitation code/i);
    expect(field).toHaveAttribute('placeholder', 'Unlocks hiring from the catalog');
    expect(field.getAttribute('placeholder')).not.toMatch(/host/i);
    expect(screen.getByText(/you can still run an agent here or bring your own/i)).toBeInTheDocument();

    // eslint-disable-next-line global-require
    const zh = require('../../i18n/locales/zh-CN.json');
    const { invitationPlaceholder, invitationHint } = zh.auth.register;
    expect(`${invitationPlaceholder} ${invitationHint}`).not.toMatch(/托管/);
    expect(zh.yourTeam.redeem.success).not.toMatch(/托管/);
  });
});

// TASK-404: an invitation code arrives in the URL but must not stay there,
// where it would sit in history and screenshots (and, in the query form, in
// request logs). The page keeps it in state for the session and clears the URL.
describe('V2Register invite code handoff', () => {
  const FullLocation = () => {
    const location = useLocation();
    return <div data-testid="here">{`${location.pathname}${location.search}${location.hash}`}</div>;
  };

  const renderAt = (entry, inviteOnly = false) => {
    axios.get.mockImplementation((url) => (
      url === '/api/auth/registration-policy'
        ? Promise.resolve({ data: { inviteOnly } })
        : Promise.resolve({ data: { providers: [] } })
    ));
    axios.post.mockResolvedValue({ data: { message: 'Registered.' } });
    const login = jest.fn().mockResolvedValue({});
    render(
      <AuthContext.Provider value={{ currentUser: null, user: null, token: null, loading: false, error: null, isAuthenticated: false, register: jest.fn(), login, logout: jest.fn(), updateProfile: jest.fn() }}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/v2/register" element={<><V2Register /><FullLocation /></>} />
            <Route path="/v2/*" element={<FullLocation />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    return { login };
  };

  const submit = async () => {
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/auth/register', expect.anything()));
    return axios.post.mock.calls.find(([url]) => url === '/api/auth/register')[1];
  };

  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
  });

  it('reads a fragment code, clears it from the URL, keeps other parameters, and still registers with it', async () => {
    renderAt('/v2/register?next=%2Fv2%2Fpods%2Fabc#invite=CM-AB12');

    await waitFor(() => expect(screen.getByTestId('here')).toHaveTextContent(/^\/v2\/register\?next=%2Fv2%2Fpods%2Fabc$/));
    expect(window.sessionStorage.getItem('commonly.pendingInvite')).toBe('CM-AB12');

    const body = await submit();
    expect(body.invitationCode).toBe('CM-AB12');
    await waitFor(() => expect(window.sessionStorage.getItem('commonly.pendingInvite')).toBeNull());
  });

  it('clears a query code from links sent before the fragment form', async () => {
    renderAt('/v2/register?invite=CM-OLD1');

    await waitFor(() => expect(screen.getByTestId('here')).toHaveTextContent(/^\/v2\/register$/));
    const body = await submit();
    expect(body.invitationCode).toBe('CM-OLD1');
  });

  it('under invite-only, a visitor who arrived with a code stays on the form after the URL is cleared', async () => {
    renderAt('/v2/register#invite=CM-GATE', true);

    await waitFor(() => expect(screen.getByTestId('here')).toHaveTextContent(/^\/v2\/register$/));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    expect(screen.queryByText(/invite-required/)).toBeNull();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('a reload after the URL was cleared still holds the code from this session', async () => {
    window.sessionStorage.setItem('commonly.pendingInvite', 'CM-KEPT');
    renderAt('/v2/register');

    const body = await submit();
    expect(body.invitationCode).toBe('CM-KEPT');
  });
});
