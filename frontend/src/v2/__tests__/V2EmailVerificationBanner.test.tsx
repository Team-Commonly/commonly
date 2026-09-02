// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import { AuthContext } from '../../context/AuthContext';
import V2EmailVerificationBanner from '../components/V2EmailVerificationBanner';

jest.mock('axios', () => {
  const mock = {
    post: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const auth = {
  currentUser: { _id: 'unverified-user', email: 'person@example.com', verified: false },
  user: { _id: 'unverified-user', email: 'person@example.com', verified: false },
  token: 'token',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const renderBanner = () => render(
  <AuthContext.Provider value={auth}>
    <V2EmailVerificationBanner />
  </AuthContext.Provider>,
);

describe('V2EmailVerificationBanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('is a session-dismissible status reminder and resends without exposing an alert', async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({ data: { message: 'sent' } });
    const view = renderBanner();

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Verify your email — we sent a link to person@example.com.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^resend$/i }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/auth/resend-verification',
      { email: 'person@example.com' },
    ));
    expect(banner).toHaveTextContent('Verification link requested.');

    fireEvent.click(screen.getByRole('button', { name: /hide verification reminder/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    view.unmount();
    renderBanner();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
