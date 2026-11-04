// @ts-nocheck
// The admin and dev routes' access check (11-04 consistency audit, finding 9).
// A non-admin used to get a MuiAlert: SF Pro 14, r12, a red exclamation icon.
// It now speaks the shell's one-line state grammar (`.v2-state`, the twin of
// memory's `p.v2m-state`): text only, no icon, no MUI, no exclamation mark.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../../i18n';
import ProtectedRoute from '../../components/ProtectedRoute';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = require('axios');

const authValue = {
  currentUser: { _id: 'u1', username: 'lily' },
  user: { _id: 'u1', username: 'lily' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const renderGate = () => render(
  <MemoryRouter>
    <AuthContext.Provider value={authValue}>
      <ProtectedRoute requireAdmin><div>admin page</div></ProtectedRoute>
    </AuthContext.Provider>
  </MemoryRouter>,
);

describe('ProtectedRoute admin gate', () => {
  test('signed out, the gate sends the person to /login and never asks the admin endpoint', () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <AuthContext.Provider value={{ ...authValue, isAuthenticated: false, currentUser: null, user: null, token: null }}>
          <Routes>
            <Route path="/admin" element={<ProtectedRoute requireAdmin><div>admin page</div></ProtectedRoute>} />
            <Route path="/login" element={<div>sign-in page</div>} />
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText('sign-in page')).toBeInTheDocument();
    expect(screen.queryByText('admin page')).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  let errorSpy;
  beforeEach(() => {
    axios.get.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    errorSpy.mockRestore();
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('a non-admin gets the v2 state line, not a red MUI alert', async () => {
    axios.get.mockRejectedValue({ response: { status: 403 } });
    const { container } = renderGate();
    const checking = screen.getByRole('status');
    expect(checking).toHaveClass('v2-state');
    expect(checking).toHaveTextContent('Checking your access…');

    const denial = await screen.findByRole('alert');
    expect(denial.tagName).toBe('P');
    expect(denial).toHaveClass('v2-state');
    expect(denial).toHaveTextContent("This page is for admins. Your account doesn't have access to it.");
    expect(denial.textContent).not.toMatch(/!/);
    expect(denial.querySelector('svg')).toBeNull();
    expect(container.querySelector('[class*="Mui"]')).toBeNull();
    expect(screen.queryByText('admin page')).toBeNull();
  });

  test('the denial reads in Chinese under zh-CN', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    axios.get.mockRejectedValue({ response: { status: 403 } });
    renderGate();
    expect(await screen.findByRole('alert')).toHaveTextContent('这个页面只对管理员开放，你的账号没有访问权限。');
  });

  test('an admin gets the page', async () => {
    axios.get.mockResolvedValue({ data: { ok: true } });
    renderGate();
    expect(await screen.findByText('admin page')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
