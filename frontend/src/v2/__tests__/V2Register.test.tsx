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

  // F581: on a team-gated instance the account exists but login refuses it
  // until the mailbox is verified. The screen must not say "You're in".
  it('says to verify, not "You\'re in", when the response requires verification', async () => {
    axios.post.mockResolvedValue({
      data: { message: 'Registered. Verify your email to join the Community pod.', verificationRequired: true },
    });
    const { login } = renderRegister(jest.fn().mockRejectedValue(new Error('should not be called')));

    await createAccount();

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText(
      'Your account is made. Open the link we sent to new@example.com, then sign in.',
    )).toBeInTheDocument();
    expect(screen.queryByText("You're in")).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'sign in now' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to sign in' })).toBeInTheDocument();
    // A login the server refuses anyway is not tried.
    expect(login).not.toHaveBeenCalled();
  });

  it('a pod invite sign-up that needs verification says the link also joins the pod', async () => {
    axios.post.mockResolvedValue({ data: { message: 'Registered.', verificationRequired: true } });
    renderRegister(undefined, `/v2/register?next=${encodeURIComponent(`/v2/invite/${'d'.repeat(32)}`)}`);

    await createAccount();

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText(
      'Your account is made. Open the link we sent to new@example.com to join the pod you were invited to, then sign in.',
    )).toBeInTheDocument();
  });

  it('falls back to the refused login when an older backend sends no flag', async () => {
    const login = jest.fn().mockRejectedValue({
      response: { data: { code: 'INSTANCE_ACCESS_RESTRICTED' } },
    });
    renderRegister(login);

    await createAccount();

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.queryByText("You're in")).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'sign in now' })).not.toBeInTheDocument();
    expect(login).toHaveBeenCalled();
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
  // a stranger with no code read hosting as locked. F580: "hiring from the
  // catalog" meant nothing to a first-time visitor either. The code grants the
  // cloudAgents entitlement (adding the ready-made agents Commonly runs), and
  // the copy says that in plain words, in both languages.
  it('says in plain words what an optional invitation code gets you', async () => {
    renderRegister();

    const field = await screen.findByLabelText(/invitation code/i);
    expect(field).toHaveAttribute('placeholder', "Adds Commonly's ready-made agents");
    expect(field).not.toBeRequired();
    expect(screen.getByText('optional')).toBeInTheDocument();
    expect(screen.getByText(
      'A code lets you add ready-made agents that Commonly runs for you. No code? Leave it blank. '
      + 'You can still start an agent here or connect your own, and add a code later on the Your team page.',
    )).toBeInTheDocument();

    // eslint-disable-next-line global-require
    const en = require('../../i18n/locales/en.json');
    // eslint-disable-next-line global-require
    const zh = require('../../i18n/locales/zh-CN.json');
    // Each key on its own, so one missing or drifted string fails by name.
    ['invitationPlaceholder', 'invitationHint', 'invitationHintRequired'].forEach((key) => {
      const enText = en.auth.register[key];
      expect(typeof enText).toBe('string');
      expect(enText.trim()).not.toBe('');
      expect(enText).not.toMatch(/catalog|hiring|hosted|BYO|!/i);
      const zhText = zh.auth.register[key];
      expect(typeof zhText).toBe('string');
      expect(zhText.trim()).not.toBe('');
      expect(zhText).not.toMatch(/托管|应用市场|您|！/);
      expect(zhText).toMatch(/智能体/);
    });
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

  it('under invite-only, the code the visitor brought sits in a required field they can correct', async () => {
    renderAt('/v2/register#invite=CM-TYP0', true);

    const field = await screen.findByLabelText(/^invitation code/i);
    expect(field).toHaveValue('CM-TYP0');
    expect(field).toBeRequired();
    expect(field).not.toHaveAttribute('placeholder');
    expect(screen.queryByText(/optional/i)).toBeNull();
    expect(screen.getByText(
      'You need a code to sign up here. It also lets you add ready-made agents that Commonly runs for you.',
    )).toBeInTheDocument();
    expect(screen.queryByText(/No code\? Leave it blank/)).toBeNull();
  });

  it('a rejected code says so in plain words, is forgotten, and can be fixed on the same form', async () => {
    renderAt('/v2/register#invite=CM-TYP0', true);
    axios.post.mockRejectedValueOnce({ response: { status: 403, data: { error: 'Invalid invitation code.', code: 'INVITATION_INVALID' } } });

    await submit();
    expect(await screen.findByText("That invitation code didn't work. Check it and try again.")).toBeInTheDocument();
    expect(window.sessionStorage.getItem('commonly.pendingInvite')).toBeNull();

    fireEvent.change(screen.getByLabelText(/^invitation code/i), { target: { value: 'CM-TYPO' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
    expect(axios.post.mock.calls[1][1].invitationCode).toBe('CM-TYPO');
  });

  it('a missing code under invite-only asks for one instead of echoing the server', async () => {
    renderAt('/v2/register#invite=CM-GATE', true);
    axios.post.mockRejectedValueOnce({ response: { status: 403, data: { error: 'Invitation code is required before registration.', code: 'INVITATION_REQUIRED' } } });

    await submit();
    expect(await screen.findByText('Enter your invitation code to sign up.')).toBeInTheDocument();
  });

  it('a reload after the URL was cleared still holds the code from this session', async () => {
    window.sessionStorage.setItem('commonly.pendingInvite', 'CM-KEPT');
    renderAt('/v2/register');

    const body = await submit();
    expect(body.invitationCode).toBe('CM-KEPT');
  });
});

// Launch row 2: signup links the Terms and Privacy pages it asks people to agree to.
describe('V2Register legal links', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({ data: { inviteOnly: false, providers: [] } });
  });

  it('links Terms and Privacy under the form', async () => {
    renderRegister();
    expect(await screen.findByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  });
});
