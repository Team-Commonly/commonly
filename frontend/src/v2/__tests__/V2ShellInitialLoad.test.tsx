import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import axios from 'axios';
import { AuthProvider } from '../../context/AuthContext';
import { AppProvider } from '../../context/AppContext';
import V2App from '../V2App';

jest.mock('axios', () => {
  const client = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: client, ...client };
});

jest.mock('../hooks/useV2PodDetail', () => ({
  useV2PodDetail: () => ({ pod: null, members: [], messages: [], agents: [], loading: false, error: null }),
}));
jest.mock('../hooks/useV2PodAttention', () => ({
  useV2PodAttention: () => ({ items: [], count: 0, countByPod: {} }),
  notifyAttentionChanged: jest.fn(),
}));
jest.mock('../hooks/useV2Pinned', () => ({
  useV2Pinned: () => ({ pinned: [], toggle: jest.fn() }),
}));
jest.mock('../components/V2NavRail', () => () => null);
jest.mock('../components/V2Thread', () => () => null);
jest.mock('../components/V2Inspector', () => () => null);
jest.mock('../components/V2InviteModal', () => () => null);
jest.mock('../components/V2FirstRunHero', () => () => null);
jest.mock('../components/V2MobileTabs', () => () => null);

const Path = () => {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
};

const renderShell = (path: string) => render(
  <AuthProvider>
    <AppProvider>
      <MemoryRouter initialEntries={[path]}>
        <Path />
        <Routes>
          <Route path="/v2/*" element={<V2App />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  </AuthProvider>,
);

describe('first desktop shell load', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('token', 'test-token');
    jest.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() })),
    });
    (axios.get as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/auth/user') {
        return Promise.resolve({ data: { _id: 'human-1', username: 'human', email: 'human@example.test', verified: true } });
      }
      if (url === '/api/pods') {
        return Promise.resolve({ data: [{
          _id: 'workspace', name: 'Workspace', joinPolicy: 'invite-only', createdBy: { _id: 'human-1' },
        }] });
      }
      if (url === '/api/posts') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
    (axios.post as jest.Mock).mockResolvedValue({ data: {} });
  });

  afterEach(() => localStorage.clear());

  test('auto-select navigation keeps one layout fetch and one auth fetch', async () => {
    renderShell('/v2');

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/v2/pods/workspace'));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/pods', expect.anything()));
    expect((axios.get as jest.Mock).mock.calls.filter(([url]) => url === '/api/pods')).toHaveLength(1);
    expect((axios.get as jest.Mock).mock.calls.filter(([url]) => url === '/api/auth/user')).toHaveLength(1);
  });

  test('direct pod link uses the same single-fetch shell', async () => {
    renderShell('/v2/pods/workspace');

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/pods', expect.anything()));
    expect(screen.getByTestId('path')).toHaveTextContent('/v2/pods/workspace');
    expect((axios.get as jest.Mock).mock.calls.filter(([url]) => url === '/api/pods')).toHaveLength(1);
    expect((axios.get as jest.Mock).mock.calls.filter(([url]) => url === '/api/auth/user')).toHaveLength(1);
  });

  test('legacy pod-type path redirects before the shell stores a selected pod', async () => {
    const store = jest.spyOn(Storage.prototype, 'setItem');
    renderShell('/v2/pods/chat');

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/v2/pods/workspace'));
    expect((axios.get as jest.Mock).mock.calls.filter(([url]) => url === '/api/pods')).toHaveLength(1);
    expect(store).not.toHaveBeenCalledWith('v2:lastPodId', 'chat');
    store.mockRestore();
  });
});
