// @ts-nocheck
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
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

const authFor = (id, verified = false) => ({
  ...auth,
  currentUser: { _id: id, email: 'person@example.com', verified },
  user: { _id: id, email: 'person@example.com', verified },
});

const renderBanner = (value = auth) => render(
  <AuthContext.Provider value={value}>
    <V2EmailVerificationBanner />
  </AuthContext.Provider>,
);

// Each route owns its own copy of the banner, the way V2App's separate auth
// gates (the pod shell and the `*` branch) each mount their own shell, so a
// route change between them remounts the banner.
const GoButton = ({ to }) => {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>go</button>;
};

// Two distinct gate components, like V2PodShellGate and V2RequireAuth, so
// React cannot reuse the banner instance across the navigation.
const PodGate = () => <div><V2EmailVerificationBanner /><GoButton to="/v2/agents" /></div>;
const OtherGate = () => <section><V2EmailVerificationBanner /><span>agents page</span></section>;

const renderRoutes = (value) => render(
  <AuthContext.Provider value={value}>
    <MemoryRouter initialEntries={['/v2']}>
      <Routes>
        <Route path="/v2" element={<PodGate />} />
        <Route path="/v2/agents" element={<OtherGate />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

const dismissBanner = () => {
  fireEvent.click(screen.getByRole('button', { name: /hide verification reminder/i }));
};

describe('V2EmailVerificationBanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('is a session-dismissible status reminder with a visible resend confirmation', async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({ data: { message: 'sent' } });
    const view = renderBanner();

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Verify your email to join the Community pod — link sent to person@example.com.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^resend$/i }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/auth/resend-verification',
      { email: 'person@example.com' },
    ));
    expect(screen.getByText('Verification link requested.')).toHaveClass('v2-verification-banner__notice');

    fireEvent.click(screen.getByRole('button', { name: /hide verification reminder/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // F652: a dismiss lasts until the next page load, so a remount stays hidden.
    view.unmount();
    renderBanner();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('a dismiss stays dismissed after navigating to another v2 route (F652)', () => {
    renderRoutes(authFor('route-user'));
    expect(screen.getByRole('status')).toBeInTheDocument();
    dismissBanner();
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByText('agents page')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('a remount in the same session stays hidden, keyed per account (F652)', () => {
    const view = renderBanner(authFor('remount-user'));
    dismissBanner();
    view.unmount();
    renderBanner(authFor('remount-user'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('another account in the same browser session still sees its own banner (F652)', () => {
    const view = renderBanner(authFor('first-user'));
    dismissBanner();
    view.unmount();
    const second = renderBanner(authFor('second-user'));
    expect(screen.getByRole('status')).toBeInTheDocument();

    // The first account's dismiss is still kept, so this test also fails if a
    // remount forgets the dismiss, not only if it leaks across accounts.
    second.unmount();
    renderBanner(authFor('first-user'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('a page load brings the reminder back after a dismiss (F652)', () => {
    const view = renderBanner(authFor('reload-user'));
    dismissBanner();
    view.unmount();
    renderBanner(authFor('reload-user'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    cleanup();

    // A reload re-evaluates the component module. Its shared dependencies are
    // pinned to this test's copies so hooks and context still line up.
    const shared = {
      react: React,
      'react-i18next': jest.requireActual('react-i18next'),
      '../../context/AuthContext': jest.requireActual('../../context/AuthContext'),
    };
    let Reloaded;
    jest.isolateModules(() => {
      Object.entries(shared).forEach(([name, mod]) => jest.doMock(name, () => mod));
      Reloaded = require('../components/V2EmailVerificationBanner').default;
    });
    Object.keys(shared).forEach((name) => jest.dontMock(name));

    render(
      <AuthContext.Provider value={authFor('reload-user')}>
        <Reloaded />
      </AuthContext.Provider>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  test('a verified user never sees it', () => {
    renderRoutes(authFor('verified-user', true));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
