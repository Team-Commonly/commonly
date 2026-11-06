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

const openForm = async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url === '/api/pods' ? [] : {} }));
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter><V2YourTeamPage /></MemoryRouter>
    </AuthContext.Provider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Have an invitation code?' }));
  fireEvent.change(screen.getByPlaceholderText('Invitation code'), { target: { value: ' BETA-1 ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
};

afterEach(() => { jest.clearAllMocks(); window.localStorage.clear(); });

describe('Your Team invitation code', () => {
  test('sends the trimmed code in the field the server reads, and unlocks the catalog', async () => {
    axios.post.mockResolvedValue({ data: { message: 'Hosted agents unlocked.' } });
    await openForm();
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe('/api/auth/redeem-invitation');
    expect(body).toEqual({ invitationCode: 'BETA-1' });
    expect(await screen.findByText('Catalog unlocked — hire your first agent.')).toBeInTheDocument();
  });

  test('a refused code shows the translated line, not the server text', async () => {
    axios.post.mockRejectedValue({ response: { status: 403, data: { error: 'Invalid invitation code.' } } });
    await openForm();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not redeem that code.');
    expect(screen.queryByText('Invalid invitation code.')).not.toBeInTheDocument();
  });
});
