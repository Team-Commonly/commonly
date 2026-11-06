// @ts-nocheck
// The Your Team redeem form posted `code`, and POST /api/auth/redeem-invitation
// reads `invitationCode`, so every code was refused as invalid.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import V2YourTeamPage from '../components/V2YourTeamPage';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = { get: jest.fn(), post: jest.fn(), defaults: { baseURL: '', headers: { common: {} } }, interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } };
  return { __esModule: true, default: mock, ...mock };
});

const user = { _id: 'u1', username: 'sam', role: 'user' };
const authValue = {
  currentUser: user, user, token: 't', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(),
};

const mergeUser = jest.fn();

const openForm = async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url === '/api/pods' ? [] : {} }));
  render(
    <AuthContext.Provider value={{ ...authValue, mergeUser }}>
      <MemoryRouter><V2YourTeamPage /></MemoryRouter>
    </AuthContext.Provider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Hire an agent' }));
  fireEvent.change(screen.getByPlaceholderText('Invitation code'), { target: { value: ' BETA-1 ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
};

afterEach(() => { jest.clearAllMocks(); window.localStorage.clear(); });

describe('Your Team invitation code', () => {
  test('an entitled account gets no hint and no form', async () => {
    axios.get.mockImplementation((url) => Promise.resolve({ data: url === '/api/pods' ? [] : {} }));
    const entitled = { ...user, entitlements: { cloudAgents: true } };
    render(
      <AuthContext.Provider value={{ ...authValue, currentUser: entitled, user: entitled, mergeUser }}>
        <MemoryRouter><V2YourTeamPage /></MemoryRouter>
      </AuthContext.Provider>,
    );
    await screen.findByRole('button', { name: 'Hire an agent' });
    expect(screen.queryByRole('button', { name: 'About Your team' })).toBeNull();
    expect(screen.queryByPlaceholderText('Invitation code')).toBeNull();
  });

  test('the page prints no notice: the sentence is the head hint, and Hire opens the form', async () => {
    axios.get.mockImplementation((url) => Promise.resolve({ data: url === '/api/pods' ? [] : {} }));
    render(
      <AuthContext.Provider value={{ ...authValue, mergeUser }}>
        <MemoryRouter><V2YourTeamPage /></MemoryRouter>
      </AuthContext.Provider>,
    );
    const hire = await screen.findByRole('button', { name: 'Hire an agent' });
    expect(document.querySelector('.v2-team__notice')).toBeNull();
    expect(screen.getByText(/needs an invitation code during beta/).closest('.v2-hint__content')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'About Your team' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Invitation code')).toBeNull();
    fireEvent.click(hire);
    expect(screen.getByPlaceholderText('Invitation code')).toBeInTheDocument();
  });

  test('sends the trimmed code in the field the server reads, and unlocks the catalog', async () => {
    const entitlements = { cloudAgents: true };
    axios.post.mockResolvedValue({ data: { message: 'Hosted agents unlocked.', entitlements } });
    await openForm();
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe('/api/auth/redeem-invitation');
    expect(body).toEqual({ invitationCode: 'BETA-1' });
    expect(await screen.findByText('Catalog unlocked — hire your first agent.')).toBeInTheDocument();
    // Hire leaves this page, and the next page has to read the grant from the auth user.
    expect(mergeUser).toHaveBeenCalledWith({ entitlements });
  });

  test('a refused code shows the translated line, not the server text', async () => {
    axios.post.mockRejectedValue({ response: { status: 403, data: { error: 'Invalid invitation code.', message: 'server text' } } });
    await openForm();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not redeem that code.');
    expect(screen.queryByText('server text')).not.toBeInTheDocument();
    expect(mergeUser).not.toHaveBeenCalled();
  });

  test('a rate limit says to wait, so a good code does not read as a bad one', async () => {
    axios.post.mockRejectedValue({ response: { status: 429, data: { message: 'Too many login attempts.', code: 'rate_limited' } } });
    await openForm();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many tries from here. Wait a few minutes, then try the code again.');
    expect(alert).not.toHaveTextContent('login');
    expect(mergeUser).not.toHaveBeenCalled();
  });

  test.each([
    ['a server error', { response: { status: 500, data: { error: 'Server error' } } }],
    ['a dropped connection', new Error('Network Error')],
  ])('%s does not read as a bad code, and warns the code may be spent', async (_name, failure) => {
    axios.post.mockRejectedValue(failure);
    await openForm();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side. Try again in a minute. If it still fails, the code may already be used.');
    expect(mergeUser).not.toHaveBeenCalled();
  });

  test('a grant does not land on the account that signed in while the request ran', async () => {
    window.localStorage.setItem('token', 'account-a');
    axios.post.mockImplementation(async () => {
      window.localStorage.setItem('token', 'account-b');
      return { data: { entitlements: { cloudAgents: true } } };
    });
    await openForm();
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    await screen.findByText('Catalog unlocked — hire your first agent.');
    expect(mergeUser).not.toHaveBeenCalled();
  });
});
