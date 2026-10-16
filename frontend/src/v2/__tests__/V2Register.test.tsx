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
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'new-user' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('new@example.com', 'Password123!'));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2');
  });

  const createAccount = async () => {
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'new-user' } });
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
    renderRegister();

    await createAccount();

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/auth/register',
      expect.objectContaining({ signupRef: 'x' }),
    ));
    localStorage.clear();
  });

  it('keeps the sign-in fallback when the immediate login is unavailable', async () => {
    const { login } = renderRegister(jest.fn().mockRejectedValue(new Error('login unavailable')));

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'new-user' } });
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

  it('still shows the reminder for the pre-2026-09-23 wording a rolling backend sends', async () => {
    // The one arm with no other guard: an old backend answering a new frontend,
    // which is the window this ships through. Dropping `check your email` from
    // the regex left the file green until this case existed.
    axios.post.mockResolvedValue({
      data: { message: 'User registered successfully. Check your email for verification.' },
    });
    renderRegister(jest.fn().mockRejectedValue(new Error('login unavailable')));

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'new-user' } });
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
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'new-user' } });
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
