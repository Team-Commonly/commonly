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
  return <div data-testid="location">{location.pathname}</div>;
};

const renderRegister = (login = jest.fn().mockResolvedValue({})) => {
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
        <MemoryRouter initialEntries={['/v2/register']}>
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
      data: { message: 'User registered successfully. Check your email for verification.' },
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

  it('keeps the sign-in fallback when the immediate login is unavailable', async () => {
    const { login } = renderRegister(jest.fn().mockRejectedValue(new Error('login unavailable')));

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/auth/registration-policy'));
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'new-user' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sign in now' })).toHaveAttribute('href', '/v2/login');
    expect(login).toHaveBeenCalledWith('new@example.com', 'Password123!');
  });
});
