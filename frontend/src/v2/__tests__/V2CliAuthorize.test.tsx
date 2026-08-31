// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { AuthContext } from '../../context/AuthContext';
import V2CliAuthorize from '../components/V2CliAuthorize';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

const auth = {
  currentUser: { _id: 'u1', username: 'lily', email: 'lily@example.com' },
  user: { _id: 'u1', username: 'lily', email: 'lily@example.com' },
  token: 'jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const renderPage = (path = '/cli/authorize?code=ABCD-EFGH', value = auth) => render(
  <AuthContext.Provider value={value}>
    <MemoryRouter initialEntries={[path]}><V2CliAuthorize /></MemoryRouter>
  </AuthContext.Provider>,
);

afterEach(() => jest.clearAllMocks());

describe('V2CliAuthorize', () => {
  test('prefills a terminal code, confirms the device facts, then completes approval', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { status: 'pending', request: { hostname: 'sam-laptop', clientName: 'commonly-cli', clientVersion: '0.1.26', createdAt: '2026-08-31T00:00:00.000Z' } } })
      .mockResolvedValueOnce({ data: { status: 'authorized' } });
    renderPage();

    expect(screen.getByLabelText('Device code')).toHaveValue('ABCD-EFGH');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/auth/device/authorize', { userCode: 'ABCD-EFGH' }));
    expect(await screen.findByText('Authorize sam-laptop as @lily?')).toBeInTheDocument();
    expect(screen.getByText('CLI SIGN-IN')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(axios.post).toHaveBeenLastCalledWith('/api/auth/device/authorize', {
      userCode: 'ABCD-EFGH', decision: 'authorize',
    }));
    expect(await screen.findByText('Device authorized')).toBeInTheDocument();
  });

  test('signed-out users get an explicit return path after sign-in', () => {
    renderPage('/cli/authorize?code=ABCD-EFGH', { ...auth, currentUser: null, user: null, token: null, isAuthenticated: false });
    expect(screen.getByRole('link', { name: 'Sign in to continue' })).toHaveAttribute(
      'href',
      expect.stringContaining('next=%2Fcli%2Fauthorize%3Fcode%3DABCD-EFGH'),
    );
    expect(screen.getByLabelText('Device code')).toBeDisabled();
  });

  test('labels an already-consumed code instead of calling it expired', async () => {
    axios.post.mockResolvedValue({ data: { status: 'consumed' } });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Code already used')).toBeInTheDocument();
  });
});
