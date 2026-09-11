// @ts-nocheck
// Tools list (tools plan §6): rows from the projected grants, the aside from the
// grant, the trail and its three counts from the broker's rows. Nothing here
// draws a control the server does not enforce.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ConnectorTools from '../components/V2ConnectorTools';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;

const authValue = {
  currentUser: { _id: 'u1', username: 'sam' }, user: { _id: 'u1', username: 'sam' }, token: 'user-jwt',
  loading: false, error: null, isAuthenticated: true, register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const NOW = Date.now();
const iso = (ms) => new Date(NOW + ms).toISOString();
const pods = [
  { _id: 'p1', name: 'Launch pod', members: [{ _id: 'u1', username: 'sam' }, { _id: 'a1', username: 'scout' }] },
  { _id: 'p2', name: 'Ops', members: [{ _id: 'u1', username: 'sam' }] },
];
const grantLive = {
  grantId: 'grant_live', installationId: 'inst-1', target: { kind: 'pod', id: 'p1' }, tools: ['github.list_issues', 'github.comment_on_issue'],
  writeMode: 'write-with-confirm', budget: { calls: 50, windowMs: 3600000 }, effectiveAudience: ['a1'], expiresAt: iso(6 * 86400000),
  revokedAt: null, parentGrantId: null, rootGrantId: null, createdAt: iso(-3600000), grantedBy: 'u1',
};
const grantRevoked = { ...grantLive, grantId: 'grant_gone', target: { kind: 'pod', id: 'p2' }, writeMode: 'read', effectiveAudience: [], revokedAt: iso(-600000), createdAt: iso(-86400000) };
const trail = {
  grantId: 'grant_live',
  calls: [
    { callId: 'c1', agentUserId: 'a1', tool: 'github.list_issues', outcome: 'ok', reason: null, approvalId: null, argsDigest: 'a'.repeat(64), at: iso(-120000), durationMs: 80 },
    { callId: 'c2', agentUserId: 'a1', tool: 'github.comment_on_issue', outcome: 'refused', reason: 'not_in_audience', approvalId: null, argsDigest: 'b'.repeat(64), at: iso(-300000), durationMs: null },
    { callId: 'c3', agentUserId: 'a1', tool: 'github.comment_on_issue', outcome: 'pending_approval', reason: null, approvalId: 'appr-1', argsDigest: 'c'.repeat(64), at: iso(-400000), durationMs: null },
  ],
  counts: { total: 3, ok: 1, refused: 1, pending_approval: 1, failed: 0 },
};

const mockApi = () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods/p1/grants') return Promise.resolve({ data: { podId: 'p1', grants: [grantLive] } });
    if (url === '/api/pods/p2/grants') return Promise.resolve({ data: { podId: 'p2', grants: [grantRevoked] } });
    if (url === '/api/registry/pods/p1/agents') return Promise.resolve({ data: { agents: [{ name: 'scout', displayName: 'Scout', userId: 'a1' }] } });
    if (url === '/api/registry/pods/p2/agents') return Promise.resolve({ data: { agents: [] } });
    if (url === '/api/grants/grant_live/calls') return Promise.resolve({ data: trail });
    if (url === '/api/grants/grant_gone/calls') return Promise.resolve({ data: { grantId: 'grant_gone', calls: [], counts: { total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 } } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
  axios.post.mockResolvedValue({ data: { grantId: 'grant_live', revoked: 1 } });
};

const renderTools = (props = {}) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter><V2ConnectorTools pods={pods} {...props} /></MemoryRouter>
  </AuthContext.Provider>,
);

beforeEach(() => { jest.clearAllMocks(); mockApi(); });

test('rows carry the states table: a live grant pulses when used in the last 10 minutes, a revoked one goes hollow', async () => {
  renderTools();
  expect(await screen.findByRole('heading', { name: 'Tools' })).toBeInTheDocument();
  expect(screen.getByText('1 granted')).toBeInTheDocument();
  const live = screen.getByRole('button', { name: 'View GitHub in Launch pod' });
  expect(within(live).getByText('Launch pod')).toBeInTheDocument();
  expect(within(live).getByText('sam')).toBeInTheDocument();
  expect(within(live).getByText('Scout may use it · every write asks first')).toBeInTheDocument();
  expect(within(live).getByText('granted 1h ago')).toBeInTheDocument();
  const liveDot = live.querySelector('.v2-connector-row__dot');
  expect(liveDot).toHaveClass('v2-connector-row__dot--live');
  await waitFor(() => expect(liveDot).toHaveClass('v2-connector-row__dot--pulse'));
  const gone = screen.getByRole('button', { name: 'View GitHub in Ops' });
  expect(within(gone).getByText('revoked 10m ago')).toBeInTheDocument();
  expect(gone.querySelector('.v2-connector-row__dot')).toHaveClass('v2-connector-row__dot--empty');
  // No not-yet row and no Add without a catalogue: nothing the server does not enforce.
  expect(screen.queryByText('not granted')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Manage' })).toHaveLength(2);
});

test('the aside reads the grant and the trail: agents, allow-list under its mode, what asks first, three counts, outcomes as words', async () => {
  renderTools();
  fireEvent.click(await screen.findByRole('button', { name: 'View GitHub in Launch pod' }));
  const aside = await screen.findByRole('complementary', { name: 'Grant details' });
  expect(within(aside).getByRole('heading', { name: 'GitHub · Launch pod' })).toBeInTheDocument();
  expect(within(aside).getByText(/Granted by sam 1h ago\. Ends 6d from now\./)).toBeInTheDocument();
  expect(within(aside).getByText('agents allowed').nextElementSibling).toHaveTextContent('Scout');
  expect(within(aside).getByText('read and write, ask first').nextElementSibling).toHaveTextContent('github.list_issues');
  expect(within(aside).getByText('asks a person first').nextElementSibling).toHaveTextContent('every write asks first');
  expect(within(aside).getByText('budget').nextElementSibling).toHaveTextContent('50 calls per 1h');
  await waitFor(() => expect(within(aside).getByText('calls').previousElementSibling).toHaveTextContent('3'));
  expect(within(aside).getByText('refused').previousElementSibling).toHaveTextContent('1');
  expect(within(aside).getByText('awaiting a person').previousElementSibling).toHaveTextContent('1');
  const lines = within(aside).getAllByRole('listitem');
  expect(lines.map((line) => line.textContent)).toEqual([
    'Scout · github.list_issues · ok2m ago',
    'Scout · github.comment_on_issue · refused5m ago',
    'Scout · github.comment_on_issue · pending_approval7m ago',
  ]);
  // The arguments never reach the page: only the digest does, and it is not rendered.
  expect(aside.textContent).not.toContain('a'.repeat(64));
  expect(axios.get).toHaveBeenCalledWith('/api/grants/grant_live/calls', expect.objectContaining({ headers: expect.any(Object) }));
});

test('Revoke is two-click and posts the revoke verb, then reloads; a dead grant offers no Revoke', async () => {
  renderTools();
  fireEvent.click(await screen.findByRole('button', { name: 'View GitHub in Launch pod' }));
  const aside = await screen.findByRole('complementary', { name: 'Grant details' });
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(within(aside).getByRole('button', { name: 'Revoke' }));
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(within(aside).getByRole('button', { name: 'Yes, revoke it' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants/grant_live/revoke', undefined, expect.any(Object)));
  await waitFor(() => expect(axios.get.mock.calls.filter(([url]) => url === '/api/pods/p1/grants')).toHaveLength(2));

  fireEvent.click(screen.getByRole('button', { name: 'View GitHub in Ops' }));
  const gone = await screen.findByRole('complementary', { name: 'Grant details' });
  expect(within(gone).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  expect(within(gone).getByText(/Revoked 10m ago\./)).toBeInTheDocument();
  await waitFor(() => expect(within(gone).getByText('No calls yet.')).toBeInTheDocument());
});

test('search filters by tool name and the segment hides not-yet rows; with no grants and no catalogue it renders nothing', async () => {
  renderTools();
  await screen.findByRole('heading', { name: 'Tools' });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search tools' }), { target: { value: 'comment' } });
  expect(screen.getAllByRole('button', { name: /^View GitHub/ })).toHaveLength(2);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search tools' }), { target: { value: 'zzz' } });
  expect(screen.getByText('Nothing matches.')).toBeInTheDocument();

  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/grants') ? { grants: [] } : { agents: [] } }));
  const { container } = render(
    <AuthContext.Provider value={authValue}><MemoryRouter><V2ConnectorTools pods={pods} /></MemoryRouter></AuthContext.Provider>,
  );
  await waitFor(() => expect(container.textContent).not.toContain('Loading tools'));
  expect(container.querySelector('.v2-tools')).toBeNull();
});
