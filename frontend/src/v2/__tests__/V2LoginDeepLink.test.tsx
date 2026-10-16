// @ts-nocheck
// GTM's re-engagement email links past signups to /v2/agents/byo?mode=hosted.
// Signed out, ProtectedRoute sends them to /v2/login with state.from, and the
// link must survive every sign-in path: password login lost the query, and the
// OAuth buttons were never given it at all.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import V2Login from '../components/V2Login';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
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

const Landed = () => {
  const location = useLocation();
  return <div data-testid="landed">{`${location.pathname}${location.search}`}</div>;
};

const DEEP = { pathname: '/v2/agents/byo', search: '?mode=hosted', hash: '' };

const renderLogin = (entry, login = jest.fn().mockResolvedValue({})) => {
  render(
    <AuthContext.Provider value={{
      currentUser: null, user: null, token: null, loading: false, error: null, isAuthenticated: false,
      register: jest.fn(), login, logout: jest.fn(), updateProfile: jest.fn(),
    }}
    >
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/v2/login" element={<V2Login />} />
          <Route path="*" element={<Landed />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return login;
};

const signIn = async () => {
  fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: 'lee@example.com' } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pw' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^sign in$/i })); });
};

afterEach(() => { jest.clearAllMocks(); localStorage.clear(); });

describe('V2Login keeps the deep link it was sent from', () => {
  test('password sign-in lands on the full path, query included', async () => {
    renderLogin({ pathname: '/v2/login', state: { from: DEEP } });
    await signIn();
    expect(await screen.findByTestId('landed')).toHaveTextContent('/v2/agents/byo?mode=hosted');
  });

  test('the OAuth buttons carry it as next', async () => {
    axios.get.mockResolvedValueOnce({
      data: { providers: [{ id: 'github', label: 'GitHub' }, { id: 'google', label: 'Google' }] },
    });
    renderLogin({ pathname: '/v2/login', state: { from: DEEP } });
    for (const name of [/continue with github/i, /continue with google/i]) {
      // eslint-disable-next-line no-await-in-loop
      const href = new URL((await screen.findByRole('link', { name })).getAttribute('href'), 'http://localhost');
      expect(href.searchParams.get('next')).toBe('/v2/agents/byo?mode=hosted');
    }
  });

  test('?next= still wins, and an off-site next is ignored for the page it came from', async () => {
    renderLogin({ pathname: '/v2/login', search: '?next=/v2/invite/abc', state: { from: DEEP } });
    await signIn();
    expect(await screen.findByTestId('landed')).toHaveTextContent('/v2/invite/abc');
  });

  test('an off-site next never becomes the destination', async () => {
    renderLogin({ pathname: '/v2/login', search: `?next=${encodeURIComponent('/\\evil.example')}` });
    await signIn();
    expect(await screen.findByTestId('landed')).toHaveTextContent(/^\/v2$/);
  });
});
