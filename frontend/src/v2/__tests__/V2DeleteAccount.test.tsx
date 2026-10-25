import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { AuthContext } from '../../context/AuthContext';
import i18n, { i18nReady } from '../../i18n';
import V2DeleteAccount from '../components/V2DeleteAccount';
import V2Login from '../components/V2Login';

jest.mock('../../utils/axiosConfig', () => ({
  __esModule: true,
  default: { delete: jest.fn(), get: jest.fn() },
}));

const logout = jest.fn();
const auth = {
  currentUser: { _id: 'u1', username: 'me', email: 'me@example.com' },
  user: null, token: 'jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), signInWithToken: jest.fn(), logout, updateProfile: jest.fn(),
};

const renderDeletion = () => render(
  <AuthContext.Provider value={auth}>
    <MemoryRouter initialEntries={['/v2/settings']}>
      <Routes>
        <Route path="/v2/settings" element={<div className="v2-settings"><V2DeleteAccount /></div>} />
        <Route path="/v2/login" element={<V2Login />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

const openDeletion = () => fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
const confirmDeletion = (value = 'DELETE') => fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Permanently delete account' }));

beforeEach(async () => {
  jest.resetAllMocks();
  localStorage.clear();
  await i18nReady;
  await i18n.changeLanguage('en');
  (axios.get as jest.Mock).mockResolvedValue({ data: { providers: [{ id: 'github', label: 'GitHub' }] } });
});

test('requires an exact deliberate confirmation, explains retention, and cancel clears sensitive fields', () => {
  renderDeletion();
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
  openDeletion();
  expect(screen.getByText(/permanently deletes your account and uploads/)).toHaveTextContent('cancels any active Stripe subscription. Shared messages are retained. Installed agent identities and memory survive.');
  expect(screen.getByLabelText('Type DELETE to confirm')).toHaveFocus();
  confirmDeletion('delete');
  expect(screen.getByRole('button', { name: 'Permanently delete account' })).toBeDisabled();
  // Form submission itself must enforce the guard, including Enter/programmatic submits.
  fireEvent.submit(screen.getByRole('form', { name: 'Delete account' }));
  expect(axios.delete).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Password (if your account has one)'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'Delete account' })).toHaveFocus();
  openDeletion();
  expect(screen.getByLabelText('Password (if your account has one)')).toHaveValue('');
  expect(screen.getByLabelText('Type DELETE to confirm')).toHaveValue('');
  expect(logout).not.toHaveBeenCalled();
});

test('sends the password in the DELETE body and logs out only after a 204; blocks duplicate submits', async () => {
  let resolve!: (value: unknown) => void;
  (axios.delete as jest.Mock).mockReturnValue(new Promise((done) => { resolve = done; }));
  renderDeletion();
  openDeletion();
  confirmDeletion();
  fireEvent.change(screen.getByLabelText('Password (if your account has one)'), { target: { value: 'correct password' } });
  submit();
  fireEvent.submit(screen.getByRole('form', { name: 'Delete account' }));
  expect(axios.delete).toHaveBeenCalledTimes(1);
  expect(axios.delete).toHaveBeenCalledWith('/api/users/me', { data: { password: 'correct password', confirmation: 'DELETE' } });
  expect(logout).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await act(async () => { resolve({ status: 204, data: '' }); });
  expect(logout).toHaveBeenCalledTimes(1);
});

test('keeps the session on failure, clears the error on retry and omits an unused password', async () => {
  (axios.delete as jest.Mock).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: {} });
  renderDeletion();
  openDeletion();
  confirmDeletion();
  submit();
  expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t delete your account. Try again.');
  expect(logout).not.toHaveBeenCalled();
  submit();
  await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(axios.delete).toHaveBeenLastCalledWith('/api/users/me', { data: { confirmation: 'DELETE' } });
});

test('PASSWORD_REQUIRED focuses a required password field and allows correction', async () => {
  (axios.delete as jest.Mock).mockRejectedValueOnce({ response: { data: { code: 'PASSWORD_REQUIRED', error: 'Enter your password.' } } })
    .mockResolvedValueOnce({ data: {} });
  renderDeletion();
  openDeletion();
  confirmDeletion();
  submit();
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter your password.');
  const password = screen.getByLabelText('Password (if your account has one)');
  expect(password).toBeRequired();
  expect(password).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Permanently delete account' })).toBeDisabled();
  expect(logout).not.toHaveBeenCalled();
  fireEvent.change(password, { target: { value: 'corrected' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  submit();
  await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
});

test('REAUTH_REQUIRED sends the existing OAuth login flow back to Settings without logging out or auto-deleting', async () => {
  (axios.delete as jest.Mock).mockRejectedValueOnce({ response: { data: { code: 'REAUTH_REQUIRED', error: 'Sign in again.' } } });
  renderDeletion();
  openDeletion();
  confirmDeletion();
  submit();
  expect(await screen.findByRole('alert')).toHaveTextContent('Sign in again.');
  const link = screen.getByRole('link', { name: /Sign in again with Google or GitHub/ });
  expect(link).toHaveAttribute('href', '/v2/login?next=/v2/settings');
  fireEvent.click(link);
  const oauth = await screen.findByRole('link', { name: /Continue with GitHub/ });
  expect(new URL(oauth.getAttribute('href')!, 'http://localhost').searchParams.get('next')).toBe('/v2/settings');
  expect(logout).not.toHaveBeenCalled();
  expect(axios.delete).toHaveBeenCalledTimes(1);
});

test('shows the backend rejection and keeps confirmation available for retry', async () => {
  (axios.delete as jest.Mock).mockRejectedValueOnce({ response: { data: { error: 'Incorrect password.' } } });
  renderDeletion();
  openDeletion();
  confirmDeletion();
  submit();
  expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect password.');
  expect(screen.getByLabelText('Type DELETE to confirm')).toHaveValue('DELETE');
  expect(screen.getByRole('button', { name: 'Permanently delete account' })).toBeEnabled();
  expect(logout).not.toHaveBeenCalled();
});
