// @ts-nocheck
// Sign-up and account recovery follow the d215 sign-up frames: one alert or
// status row (V2AuthNotice) that marks only the fields it is about, providers
// before the form, "optional" in the label, and a plain key for a second path.
import fs from 'fs';
import path from 'path';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import V2Register from '../components/V2Register';
import V2ForgotPassword from '../components/V2ForgotPassword';
import V2ResetPassword from '../components/V2ResetPassword';
import RegistrationInviteRequired from '../../components/RegistrationInviteRequired';
import VerifyEmail from '../../components/VerifyEmail';
import { AuthContext } from '../../context/AuthContext';

const axios = require('axios').default;

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

const PROVIDERS = { data: { providers: [{ id: 'github', label: 'GitHub' }, { id: 'google', label: 'Google' }] } };

// Answers the two GETs every sign-up render makes; `rest` handles anything else.
const routeGets = (policy = { inviteOnly: false }, rest = () => Promise.reject(new Error('unexpected GET'))) => {
  axios.get.mockImplementation((url) => {
    if (url.includes('/api/auth/oauth/providers') || url.includes('providers')) return Promise.resolve(PROVIDERS);
    if (url.includes('registration-policy')) return Promise.resolve({ data: policy });
    return rest(url);
  });
};

const Where = () => {
  const { pathname, search } = useLocation();
  return <div>{`at ${pathname}${search}`}</div>;
};

const mount = (element, entry, login = jest.fn().mockRejectedValue(new Error('no session'))) => render(
  <AuthContext.Provider value={{
    currentUser: null, user: null, token: null, loading: false, error: null, isAuthenticated: false,
    register: jest.fn(), login, logout: jest.fn(), updateProfile: jest.fn(),
  }}
  >
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path={entry.split(/[?#]/)[0]} element={element} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

afterEach(() => { jest.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); });

describe('sign up', () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'alex@studio.dev' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'longenough' } });
  };

  test('providers come first, then "or", then the form; no subtitle', async () => {
    routeGets();
    mount(<V2Register />, '/v2/register');
    const google = await screen.findByRole('link', { name: /continue with google/i });
    expect(before(google, screen.getByText('or'))).toBe(true);
    expect(before(screen.getByText('or'), screen.getByLabelText(/^email$/i))).toBe(true);
    expect(screen.queryByText(/shared space where agents and humans/i)).toBeNull();
  });

  test('the optional code says so in its label, under open registration only', async () => {
    routeGets();
    mount(<V2Register />, '/v2/register');
    const code = await screen.findByLabelText(/invitation code/i);
    expect(code.closest('label').querySelector('em')).toHaveTextContent('optional');
  });

  test('under invite-only the code label carries no "optional"', async () => {
    routeGets({ inviteOnly: true });
    mount(<V2Register />, '/v2/register#invite=abc123');
    const code = await screen.findByLabelText(/invitation code/i);
    expect(code.closest('label').querySelector('em')).toBeNull();
  });

  test('a failed sign-up is one alert at the top that marks email and password', async () => {
    routeGets();
    axios.post.mockRejectedValue({ response: { data: { error: 'Registration failed.' } } });
    mount(<V2Register />, '/v2/register');
    const github = await screen.findByRole('link', { name: /continue with github/i });
    fill();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /create account/i })); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Registration failed.');
    expect(before(alert, github)).toBe(true);
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/invitation code/i)).not.toHaveAttribute('aria-invalid');
  });

  test('a rejected code marks the code, not the email and password', async () => {
    routeGets();
    axios.post.mockRejectedValue({ response: { data: { code: 'INVITATION_INVALID' } } });
    mount(<V2Register />, '/v2/register');
    await screen.findByLabelText(/invitation code/i);
    fill();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /create account/i })); });
    expect(screen.getByLabelText(/invitation code/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^email$/i)).not.toHaveAttribute('aria-invalid');
  });

  test('terms sit under the key, and the last line signs in keeping the deep link', async () => {
    routeGets();
    mount(<V2Register />, '/v2/register?next=%2Fv2%2Fpods%2Fp1');
    const signIn = await screen.findByRole('link', { name: /^sign in$/i });
    const terms = screen.getByRole('link', { name: /terms/i });
    expect(before(screen.getByRole('button', { name: /create account/i }), terms)).toBe(true);
    expect(before(terms, signIn)).toBe(true);
    expect(signIn).toHaveAttribute('href', '/v2/login?next=%2Fv2%2Fpods%2Fp1');
  });

  test('the check-your-email screen keeps the reminder line and adds the key on', async () => {
    routeGets();
    axios.post.mockResolvedValue({ data: { message: 'Registered. Check your email to verify.' } });
    mount(<V2Register />, '/v2/register');
    await screen.findByLabelText(/invitation code/i);
    fill();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /create account/i })); });
    expect(screen.getByRole('heading', { name: /you're in/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to sign in/i })).toBeInTheDocument();
  });
});

describe('invitation required', () => {
  test('the code comes first, the waitlist sits below the "or" rule, its key is plain', async () => {
    mount(<RegistrationInviteRequired />, '/v2/register/invite-required');
    const code = screen.getByLabelText(/^invitation code$/i);
    const rule = screen.getByText(/need access\? join the waitlist/i);
    expect(rule).toHaveClass('v2-login__or');
    expect(before(code, rule)).toBe(true);
    expect(before(rule, screen.getByLabelText(/^email$/i))).toBe(true);
    expect(screen.getByLabelText(/^name/i).closest('label').querySelector('em')).toHaveTextContent('optional');
    expect(screen.getByLabelText(/^use case/i).closest('label').querySelector('em')).toHaveTextContent('optional');
    expect(screen.getByRole('button', { name: /request waitlist access/i })).toHaveClass('v2-login__submit--ghost');
  });

  test('a sent request is a status row above its key, and the address stays for a second send', async () => {
    axios.post.mockResolvedValue({ data: {} });
    mount(<RegistrationInviteRequired />, '/v2/register/invite-required');
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'alex@studio.dev' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /request waitlist access/i })); });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Waitlist request submitted.');
    expect(before(status, screen.getByRole('button', { name: /request waitlist access/i }))).toBe(true);
    expect(screen.getByLabelText(/^email$/i)).toHaveValue('alex@studio.dev');
  });

  test('a failed request is an alert row', async () => {
    axios.post.mockRejectedValue({ response: { data: { error: 'Nope' } } });
    mount(<RegistrationInviteRequired />, '/v2/register/invite-required');
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'alex@studio.dev' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /request waitlist access/i })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Nope');
  });
});

describe('verify email', () => {
  test('a verified address shows the server line as a status and goes on with the filled key', async () => {
    axios.get.mockResolvedValue({ data: { message: 'Email verified successfully' } });
    mount(<VerifyEmail />, '/v2/verify-email?token=a+b/c');
    expect(screen.getByText(/verifying your email/i)).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Email verified successfully');
    expect(axios.get).toHaveBeenCalledWith('/api/auth/verify-email?token=a%20b%2Fc');
    const go = screen.getByRole('button', { name: /go to sign in/i });
    expect(go).not.toHaveClass('v2-login__submit--ghost');
    fireEvent.click(go);
    expect(screen.getByText('at /v2/login')).toBeInTheDocument();
  });

  test('a failure is the alert row, and the way out is a plain key', async () => {
    axios.get.mockRejectedValue({ response: { data: { error: 'Invalid or expired token' } } });
    mount(<VerifyEmail />, '/v2/verify-email?token=t2');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or expired token');
    expect(screen.getByRole('button', { name: /go to sign in/i })).toHaveClass('v2-login__submit--ghost');
  });

  test('without a token it fails at once and asks nothing of the server', () => {
    mount(<VerifyEmail />, '/v2/verify-email');
    expect(screen.getByRole('alert')).toHaveTextContent('Verification failed.');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('a token is sent once, even under StrictMode', async () => {
    axios.get.mockResolvedValue({ data: { message: 'ok' } });
    mount(<React.StrictMode><VerifyEmail /></React.StrictMode>, '/v2/verify-email?token=once');
    await screen.findByRole('status');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});

describe('forgot password', () => {
  test('a failure is the alert above the field, and marks it', async () => {
    axios.post.mockRejectedValue({});
    mount(<V2ForgotPassword />, '/v2/forgot-password');
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'alex@studio.dev' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /send reset link/i })); });
    const alert = screen.getByRole('alert');
    expect(before(alert, screen.getByLabelText(/^email$/i))).toBe(true);
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute('aria-invalid', 'true');
  });

  test('once sent, the form goes and one status row says so', async () => {
    axios.post.mockResolvedValue({ data: {} });
    mount(<V2ForgotPassword />, '/v2/forgot-password');
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'alex@studio.dev' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /send reset link/i })); });
    expect(screen.getByRole('status')).toHaveTextContent(/valid for one hour/i);
    expect(screen.queryByLabelText(/^email$/i)).toBeNull();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/v2/login');
  });
});

describe('reset password', () => {
  const fill = (a, b) => {
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: a } });
    fireEvent.change(screen.getByLabelText(/^confirm password$/i), { target: { value: b } });
  };

  test('a mismatch rings both fields, with no link to a new email', async () => {
    mount(<V2ResetPassword />, '/v2/reset-password?token=t');
    fill('longenough1', 'longenough2');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /update password/i })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(screen.getByLabelText(/^new password$/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^confirm password$/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('link', { name: /request a new link/i })).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('an expired link carries its recovery link in the alert and leaves the fields alone', async () => {
    axios.post.mockRejectedValue({});
    mount(<V2ResetPassword />, '/v2/reset-password?token=t');
    fill('longenough1', 'longenough1');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /update password/i })); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/the link may have expired/i);
    expect(alert.querySelector('a')).toHaveAttribute('href', '/v2/forgot-password');
    expect(screen.getByLabelText(/^new password$/i)).not.toHaveAttribute('aria-invalid');
  });

  test('updated is a status row and the filled key goes to sign in', async () => {
    axios.post.mockResolvedValue({ data: {} });
    mount(<V2ResetPassword />, '/v2/reset-password?token=t');
    fill('longenough1', 'longenough1');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /update password/i })); });
    expect(screen.getByRole('status')).toHaveTextContent(/password updated/i);
    fireEvent.click(screen.getByRole('button', { name: /go to sign in/i }));
    expect(screen.getByText('at /v2/login')).toBeInTheDocument();
  });

  test('opened without the email link, it is one line and one key to request one', () => {
    mount(<V2ResetPassword />, '/v2/reset-password');
    expect(screen.queryByLabelText(/^new password$/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /send me a reset link/i }));
    expect(screen.getByText('at /v2/forgot-password')).toBeInTheDocument();
  });
});

describe('auth card styles', () => {
  const v2 = fs.readFileSync(path.join(__dirname, '../v2.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string) => {
    const i = v2.indexOf(`\n${sel} {`);
    expect(i).toBeGreaterThan(-1);
    return v2.slice(i, v2.indexOf('}', i));
  };

  test('the auth page scrolls, and the card centres with auto margins', () => {
    const page = rule('.v2-login');
    expect(page).toMatch(/overflow-y: auto/);
    expect(page).toMatch(/min-height: 0/);
    expect(page).not.toMatch(/place-items: center/);
    expect(rule('.v2-login__card')).toMatch(/margin: auto/);
  });

  test('a form inside a lifted card lends its rows to the card grid', () => {
    expect(rule('.v2-login__card--stack > form')).toMatch(/display: contents/);
  });

  test('the second path is a key, not a second fill', () => {
    const ghost = rule('.v2-root button.v2-login__submit--ghost');
    expect(ghost).toMatch(/linear-gradient\(180deg, var\(--v2-key-a\), var\(--v2-key-b\)\)/);
    expect(ghost).toMatch(/border-color: var\(--v2-key-edge\)/);
  });

  test('"optional" in a label is the muted mono tag at the far end of the label', () => {
    expect(rule('.v2-login__label')).toMatch(/justify-content: space-between/);
    const em = rule('.v2-login__label em');
    expect(em).toMatch(/var\(--v2-font-mono\)/);
    expect(em).toMatch(/font-style: normal/);
  });

  test('errors and confirmations share one row; the green success box and the bordered divider are gone', () => {
    expect(rule('.v2-login__notice')).toMatch(/box-shadow: inset 0 0 0 1px var\(--v2-border\)/);
    expect(v2).not.toMatch(/\.v2-login__(error|success|divider)\b/);
  });
});
