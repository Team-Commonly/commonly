import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ConnectorTools from '../components/V2ConnectorTools';
import { AuthContext } from '../../context/AuthContext';
import i18n, { i18nReady } from '../../i18n';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;

const auth = {
  currentUser: { _id: 'u1', username: 'sam', email: 'sam@example.test' }, user: { _id: 'u1', username: 'sam', email: 'sam@example.test' }, token: 'user-jwt',
  loading: false, error: null, isAuthenticated: true, register: jest.fn(), login: jest.fn(), signInWithToken: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};
const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
const yesterday = new Date(Date.now() - 86_400_000).toISOString();
const grant = (id: string, revokedAt: string | null) => ({
  grantId: id, installationId: 'inst-github', target: { kind: 'pod', id: 'p1' }, tools: ['github.list_issues'],
  writeMode: 'read', budget: null, effectiveAudience: [], expiresAt: tomorrow,
  revokedAt, revokedBy: revokedAt ? 'u1' : null, parentGrantId: null, rootGrantId: null,
  createdAt: yesterday, grantedBy: 'u1',
});
const catalog = [{ installableId: 'github', list: 'tools', label: 'GitHub', description: 'Issues', available: true,
  tools: [{ name: 'github.list_issues', requiredWriteMode: 'read', irreversible: false }], connections: [] }];

beforeAll(async () => { await i18nReady; await i18n.changeLanguage('en'); });

test('two live grants stay visible and nine revoked grants start in one closed fold', async () => {
  const grants = [grant('live-1', null), grant('live-2', null),
    ...Array.from({ length: 9 }, (_, i) => grant(`revoked-${i}`, yesterday))];
  axios.get.mockImplementation((url: string) => {
    if (url === '/api/installables') return Promise.resolve({ data: { installables: catalog } });
    if (url === '/api/pods/p1/grants') return Promise.resolve({ data: { grants } });
    if (url === '/api/registry/pods/p1/agents') return Promise.resolve({ data: { agents: [] } });
    if (url.includes('/calls')) return Promise.resolve({ data: { calls: [], counts: { total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 } } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });

  const { container } = render(<AuthContext.Provider value={auth}><MemoryRouter>
    <V2ConnectorTools pods={[{ _id: 'p1', name: 'Launch pod', members: [{ _id: 'u1', username: 'sam' }] }]} />
  </MemoryRouter></AuthContext.Provider>);

  const fold = await screen.findByRole('button', { name: 'inactive · 9' });
  expect(fold).toHaveAttribute('aria-expanded', 'false');
  expect(container.querySelectorAll('.v2-connector-row')).toHaveLength(2);
  expect(screen.queryByText(/not enabled|not yet|coming/i)).not.toBeInTheDocument();

  fireEvent.click(fold);
  await waitFor(() => expect(container.querySelectorAll('.v2-connector-row')).toHaveLength(11));
  expect(fold).toHaveAttribute('aria-expanded', 'true');
});
