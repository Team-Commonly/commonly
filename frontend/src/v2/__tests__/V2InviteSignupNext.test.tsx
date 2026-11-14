// @ts-nocheck
// F518: on an instance where signing up needs an invitation code, someone who
// came from a pod invite keeps that invite's page as their destination through
// the code step, and the login page's "Create an account" keeps it too.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import V2Register from '../components/V2Register';
import V2Login from '../components/V2Login';
import RegistrationInviteRequired from '../../components/RegistrationInviteRequired';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;

const NEXT = `/v2/invite/${'d'.repeat(32)}`;
const ENC = encodeURIComponent(NEXT);
const Here = () => { const l = useLocation(); return <p data-testid="here">{`${l.pathname}${l.search}${l.hash}`}</p>; };
const auth = { currentUser: null, user: null, token: null, loading: false, error: null, isAuthenticated: false, register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn() };
const renderAt = (entry) => render(
  <AuthContext.Provider value={auth}>
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/v2/register" element={<V2Register />} />
        <Route path="/v2/register/invite-required" element={<><RegistrationInviteRequired /><Here /></>} />
        <Route path="/v2/login" element={<V2Login />} />
        <Route path="*" element={<Here />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  axios.get.mockImplementation((url) => Promise.resolve({ data: url === '/api/auth/registration-policy' ? { inviteOnly: true } : { providers: [] } }));
});

test('invite-only sign-up without a code goes to the code step and keeps the invite', async () => {
  renderAt(`/v2/register?next=${ENC}`);
  await waitFor(() => expect(screen.getByTestId('here')).toHaveTextContent(`/v2/register/invite-required?next=${ENC}`));
});

test('the code step continues to sign-up with the code and the invite still the destination', async () => {
  renderAt(`/v2/register/invite-required?next=${ENC}`);
  fireEvent.change(await screen.findByLabelText(/invitation code/i), { target: { value: 'CM-WALK1' } });
  fireEvent.click(screen.getByRole('button', { name: /continue to registration/i }));
  await waitFor(() => expect(sessionStorage.getItem('commonly.pendingInvite')).toBe('CM-WALK1'));
  expect(await screen.findByRole('button', { name: /create account/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /^sign in$/i })).toHaveAttribute('href', `/v2/login?next=${ENC}`);
});

test('the code step\'s Sign in keeps the invite too', async () => {
  renderAt(`/v2/register/invite-required?next=${ENC}`);
  expect(await screen.findByRole('link', { name: /^sign in$/i })).toHaveAttribute('href', `/v2/login?next=${ENC}`);
});

test('an off-site next on the code step is dropped, not carried', async () => {
  renderAt('/v2/register/invite-required?next=%2F%2Fevil.example');
  fireEvent.change(await screen.findByLabelText(/invitation code/i), { target: { value: 'CM-WALK1' } });
  fireEvent.click(screen.getByRole('button', { name: /continue to registration/i }));
  await screen.findByRole('button', { name: /create account/i });
  expect(screen.getByRole('link', { name: /^sign in$/i })).toHaveAttribute('href', '/v2/login');
});

test('the login page\'s Create an account keeps the invite as the destination', async () => {
  renderAt(`/v2/login?next=${ENC}`);
  expect(await screen.findByRole('link', { name: /create an account/i })).toHaveAttribute('href', `/v2/register?next=${ENC}`);
});

test('signing up from a pod invite, the verify step names that pod, not the Community pod', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url === '/api/auth/registration-policy' ? { inviteOnly: false } : { providers: [] } }));
  axios.post.mockResolvedValueOnce({ data: { message: 'Registered. Verify your email to join the Community pod.' } });
  auth.login.mockRejectedValueOnce({ response: { status: 403, data: { code: 'EMAIL_NOT_VERIFIED' } } });
  renderAt(`/v2/register?next=${ENC}`);
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
  fireEvent.change(await screen.findByLabelText(/^email$/i), { target: { value: 'b@example.com' } });
  for (const box of screen.getAllByLabelText(/password/i)) fireEvent.change(box, { target: { value: 'pw-123456789' } });
  const name = screen.queryByLabelText(/username/i); if (name) fireEvent.change(name, { target: { value: 'bee' } });
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
  expect(await screen.findByText(/Verify your email to join the pod you were invited to/)).toBeInTheDocument();
  expect(screen.queryByText(/Community pod/)).toBeNull();
});

test('signing in before verifying says to verify, not that the instance is team-only', async () => {
  auth.login.mockRejectedValueOnce({ response: { status: 403, data: { error: 'This instance is limited to the team.', code: 'INSTANCE_ACCESS_RESTRICTED', reason: 'unverified' } } });
  renderAt(`/v2/login?next=${ENC}`);
  fireEvent.change(await screen.findByLabelText(/^email$/i), { target: { value: 'b@example.com' } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pw-123456789' } });
  fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
  expect(await screen.findByText(/Verify your email first/)).toBeInTheDocument();
  expect(screen.queryByText(/limited to the team/)).toBeNull();
});

test.each([
  [`?next=${ENC}`, `/v2/register?next=${ENC}#invite=CM-WALK1`],
  ['?next=%2F%2Fevil.example', '/v2/register#invite=CM-WALK1'],
])('the code step itself sends %s on as %s', async (search, dest) => {
  render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[`/v2/register/invite-required${search}`]}>
        <Routes>
          <Route path="/v2/register/invite-required" element={<RegistrationInviteRequired />} />
          <Route path="*" element={<Here />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  fireEvent.change(await screen.findByLabelText(/invitation code/i), { target: { value: 'CM-WALK1' } });
  fireEvent.click(screen.getByRole('button', { name: /continue to registration/i }));
  expect(await screen.findByTestId('here')).toHaveTextContent(dest);
});
