// @ts-nocheck
// Tools list (tools plan §6): rows from the projected grants, the aside from the
// grant, the trail and its three counts from the broker's rows. Nothing here
// draws a control the server does not enforce.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  revokedAt: null, revokedBy: null, parentGrantId: null, rootGrantId: null, createdAt: iso(-3600000), grantedBy: 'u1',
};
const grantRevoked = { ...grantLive, grantId: 'grant_gone', target: { kind: 'pod', id: 'p2' }, writeMode: 'read', effectiveAudience: [], revokedAt: iso(-600000), revokedBy: 'u1', createdAt: iso(-86400000) };
const trail = {
  grantId: 'grant_live',
  calls: [
    { callId: 'c1', agentUserId: 'a1', tool: 'github.list_issues', outcome: 'ok', reason: null, approvalId: null, argsDigest: 'a'.repeat(64), at: iso(-120000), durationMs: 80 },
    { callId: 'c2', agentUserId: 'a1', tool: 'github.comment_on_issue', outcome: 'refused', reason: 'not_in_audience', approvalId: null, argsDigest: 'b'.repeat(64), at: iso(-300000), durationMs: null },
    { callId: 'c3', agentUserId: 'a1', tool: 'github.comment_on_issue', outcome: 'pending_approval', reason: null, approvalId: 'appr-1', argsDigest: 'c'.repeat(64), at: iso(-400000), durationMs: null },
  ],
  counts: { total: 3, ok: 1, refused: 1, pending_approval: 1, failed: 0 },
};

const githubEntry = {
  installableId: 'github', list: 'tools', label: 'GitHub', description: 'Issues and pull requests.', available: true,
  broker: { id: 'commonly-grant-broker' },
  tools: [
    { name: 'github.list_issues', requiredWriteMode: 'read', irreversible: false },
    { name: 'github.comment_on_issue', requiredWriteMode: 'write', irreversible: true },
    { name: 'github.close_issue', requiredWriteMode: 'write', irreversible: true },
  ],
  connections: [{ connectionId: 'conn-1', owner: 'Team-Commonly', repo: 'commonly' }],
};

const linearEntry = {
  installableId: 'linear', list: 'tools', label: 'Linear', description: 'Issues in Linear.', available: true,
  broker: { id: 'commonly-grant-broker' },
  tools: [{ name: 'linear.create_issue', requiredWriteMode: 'write', irreversible: true }],
  connections: [{ connectionId: 'conn-2', owner: 'Team-Commonly', repo: 'linear' }],
};
const grantLinear = { ...grantLive, grantId: 'grant_lin', installationId: 'inst-2', tools: ['linear.create_issue'] };

// Two tools entries and one grant: the shape the page has to survive once a
// second tool Installable ships. The old single-entry accounting hid the entry
// it did not cover (and the header still subtracted exactly one).
const mockTwoEntries = ({ catalog = [githubEntry, linearEntry], grants = { p1: [grantLinear], p2: [grantRevoked] } } = {}) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/installables') return Promise.resolve({ data: { installables: catalog } });
    const pod = /^\/api\/pods\/(p\d)\/grants$/.exec(url);
    if (pod) return Promise.resolve({ data: { podId: pod[1], grants: grants[pod[1]] || [] } });
    if (url === '/api/registry/pods/p1/agents') return Promise.resolve({ data: { agents: [{ name: 'scout', displayName: 'Scout', userId: 'a1' }] } });
    if (url === '/api/registry/pods/p2/agents') return Promise.resolve({ data: { agents: [] } });
    if (url.includes('/calls')) return Promise.resolve({ data: { grantId: 'g', calls: [], counts: { total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 } } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
};

const mockApi = (catalog = []) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/installables') return Promise.resolve({ data: { installables: [{ installableId: 'telegram', list: 'channels' }, ...catalog] } });
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

test('TASK-131: a grant age advances in place, and a returning tab re-reads, without a reload', async () => {
  jest.useFakeTimers();
  try {
    renderTools();
    expect(await screen.findByText('granted 1h ago')).toBeInTheDocument();

    await act(async () => { jest.advanceTimersByTime(60 * 60_000); });
    expect(screen.getByText('granted 2h ago')).toBeInTheDocument();

    const reads = () => axios.get.mock.calls.filter(([url]) => url === '/api/pods/p1/grants').length;
    const before = reads();
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  } finally {
    jest.useRealTimers();
  }
});

test('TASK-131: a grant expiring with the page open moves its tool back to Not yet on the same tick as the count', async () => {
  jest.useFakeTimers();
  try {
    // Live for one more minute, so the only thing that changes is the clock.
    const expiring = { ...grantLive, grantId: 'grant_soon', expiresAt: iso(60_000) };
    axios.get.mockImplementation((url) => {
      if (url === '/api/installables') return Promise.resolve({ data: { installables: [githubEntry] } });
      if (url.endsWith('/grants')) return Promise.resolve({ data: { grants: url.includes('p1') ? [expiring] : [] } });
      if (url.includes('/registry/pods/')) return Promise.resolve({ data: { agents: [] } });
      if (url.includes('/calls')) return Promise.resolve({ data: { grantId: 'grant_soon', calls: [], counts: { total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 } } });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    renderTools();
    expect(await screen.findByText('1 granted')).toBeInTheDocument();
    expect(screen.queryByText('not granted')).not.toBeInTheDocument();

    await act(async () => { jest.advanceTimersByTime(2 * 60_000); });

    // The count always followed the clock; the list did not, so the two
    // disagreed on screen until a reload.
    expect(screen.getByText('0 granted · 1 more')).toBeInTheDocument();
    expect(screen.getByText('not granted')).toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});

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
  expect(within(gone).getByText('revoked by sam 10m ago')).toBeInTheDocument();
  expect(gone.closest('.v2-connector-row')).toHaveClass('v2-connector-row--dead');
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
    'Scout · github.comment_on_issue · awaiting a person7m ago',
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
  expect(within(gone).getByText(/Revoked by sam 10m ago\./)).toBeInTheDocument();
  await waitFor(() => expect(within(gone).getByText('No calls yet.')).toBeInTheDocument());
});

test('the catalogue draws the not-yet row, and Add mints the grant exactly as the server takes it — never a brokerId', async () => {
  mockApi([githubEntry]);
  // No live grant anywhere → a not-yet row; the two dead/live fixtures are replaced by a revoked one only.
  axios.get.mockImplementation((url) => {
    if (url === '/api/installables') return Promise.resolve({ data: { installables: [githubEntry] } });
    if (url.endsWith('/grants')) return Promise.resolve({ data: { grants: url.includes('p2') ? [grantRevoked] : [] } });
    if (url === '/api/registry/pods/p1/agents') return Promise.resolve({ data: { agents: [{ name: 'scout', displayName: 'Scout', userId: 'a1' }, { name: 'hosted-smoke', userId: 'x9', internal: true }] } });
    if (url.includes('/registry/pods/')) return Promise.resolve({ data: { agents: [] } });
    if (url.includes('/calls')) return Promise.resolve({ data: { grantId: 'g', calls: [], counts: { total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 } } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
  axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
  renderTools();
  expect(await screen.findByText('0 granted · 1 more')).toBeInTheDocument();
  expect(screen.getByText('Issues and pull requests.')).toBeInTheDocument();
  expect(screen.getByText('read, or read and write')).toBeInTheDocument();
  expect(screen.getByText('not granted')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  const form = await screen.findByRole('complementary', { name: 'Add GitHub' });
  // Default: read, every non-internal seat in the room, 7 days; under read only read tools are on the list.
  expect(within(form).getByRole('button', { name: 'read' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(form).getByText('github.list_issues')).toBeInTheDocument();
  expect(within(form).queryByText('github.comment_on_issue')).toBeNull();
  expect(within(form).getByText('nothing asks first')).toBeInTheDocument();
  expect(within(form).getByRole('checkbox', { name: 'Scout' })).toBeChecked();
  fireEvent.click(within(form).getByRole('button', { name: 'read and write' }));
  expect(within(form).getByText('github.comment_on_issue')).toBeInTheDocument();
  expect(within(form).getByText('github.comment_on_issue, github.close_issue ask first')).toBeInTheDocument();
  fireEvent.change(within(form).getByRole('combobox', { name: 'ends' }), { target: { value: '30' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  const [url, body] = axios.post.mock.calls[0];
  expect(url).toBe('/api/grants');
  expect(body).toMatchObject({ connectionId: 'conn-1', target: { kind: 'pod', id: 'p1' }, writeMode: 'write', audience: ['a1'], tools: ['github.list_issues', 'github.comment_on_issue', 'github.close_issue'] });
  // Both are the server's: the broker from the catalogue (Vera 67728), the installation from the Connection (#1677).
  expect(body).not.toHaveProperty('brokerId');
  expect(body).not.toHaveProperty('installationId');
  expect(Object.keys(body).sort()).toEqual(['audience', 'connectionId', 'expiresAt', 'target', 'tools', 'writeMode']);
  const days = (new Date(body.expiresAt).getTime() - Date.now()) / 86400000;
  expect(days).toBeGreaterThan(29.9);
  expect(days).toBeLessThan(30.1);
  await waitFor(() => expect(axios.get.mock.calls.filter(([u]) => u === '/api/pods/p1/grants')).toHaveLength(2));
});

test('a not-yet row without a Connection or on an unconfigured instance offers no Add', async () => {
  mockApi([{ ...githubEntry, connections: [] }]);
  axios.get.mockImplementation((url) => {
    if (url === '/api/installables') return Promise.resolve({ data: { installables: [{ ...githubEntry, connections: [] }] } });
    if (url.endsWith('/grants')) return Promise.resolve({ data: { grants: [] } });
    return Promise.resolve({ data: { agents: [] } });
  });
  renderTools();
  expect(await screen.findByText('install the GitHub App first · an admin does this once')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Install GitHub App' })).toBeNull();
});

test('an admin can install the GitHub App from the no-connection Tools row', async () => {
  const noConnection = { ...githubEntry, connections: [] };
  axios.get.mockImplementation((url) => {
    if (url === '/api/installables') return Promise.resolve({ data: { installables: [noConnection] } });
    if (url.endsWith('/grants')) return Promise.resolve({ data: { grants: [] } });
    if (url.includes('/registry/pods/')) return Promise.resolve({ data: { agents: [] } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
  axios.post.mockResolvedValue({ data: { integration: { installationId: 'install-42', createdBy: 'u1' } } });
  const admin = {
    ...authValue,
    currentUser: { ...authValue.currentUser, role: 'admin' },
    user: { ...authValue.user, role: 'admin' },
  };
  render(<AuthContext.Provider value={admin}><MemoryRouter><V2ConnectorTools pods={pods} /></MemoryRouter></AuthContext.Provider>);

  fireEvent.click(await screen.findByRole('button', { name: 'Install GitHub App' }));
  const form = await screen.findByRole('complementary', { name: 'Install GitHub App' });
  fireEvent.change(within(form).getByRole('textbox', { name: 'installation ID' }), { target: { value: 'install-42' } });
  fireEvent.change(within(form).getByRole('textbox', { name: 'owner' }), { target: { value: 'Team-Commonly' } });
  fireEvent.change(within(form).getByRole('textbox', { name: 'repository' }), { target: { value: 'commonly' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Install GitHub App' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
    '/api/integrations/github-app',
    { installationId: 'install-42', owner: 'Team-Commonly', repo: 'commonly' },
    expect.any(Object),
  ));
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Install GitHub App' })).toBeNull());
});

test('an admin is told when another administrator already owns the GitHub App installation', async () => {
  const noConnection = { ...githubEntry, connections: [] };
  axios.get.mockImplementation((url) => {
    if (url === '/api/installables') return Promise.resolve({ data: { installables: [noConnection] } });
    if (url.endsWith('/grants')) return Promise.resolve({ data: { grants: [] } });
    if (url.includes('/registry/pods/')) return Promise.resolve({ data: { agents: [] } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
  axios.post.mockResolvedValue({ data: { integration: { installationId: 'install-42', createdBy: 'other-admin' } } });
  const admin = {
    ...authValue,
    currentUser: { ...authValue.currentUser, _id: 'u2', role: 'admin' },
    user: { ...authValue.user, _id: 'u2', role: 'admin' },
  };
  render(<AuthContext.Provider value={admin}><MemoryRouter><V2ConnectorTools pods={pods} /></MemoryRouter></AuthContext.Provider>);

  fireEvent.click(await screen.findByRole('button', { name: 'Install GitHub App' }));
  const form = await screen.findByRole('complementary', { name: 'Install GitHub App' });
  fireEvent.change(within(form).getByRole('textbox', { name: 'installation ID' }), { target: { value: 'install-42' } });
  fireEvent.change(within(form).getByRole('textbox', { name: 'owner' }), { target: { value: 'Team-Commonly' } });
  fireEvent.change(within(form).getByRole('textbox', { name: 'repository' }), { target: { value: 'commonly' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Install GitHub App' }));

  await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent('This GitHub App is already installed by another administrator.'));
  expect(screen.getByRole('complementary', { name: 'Install GitHub App' })).toBeInTheDocument();
});

test('an unavailable not-yet tool row offers the same Ask affordance as unavailable channels', async () => {
  const unavailable = { ...githubEntry, available: false, connections: [] };
  axios.get.mockImplementation((url) => {
    if (url === '/api/installables') return Promise.resolve({ data: { installables: [unavailable] } });
    if (url.endsWith('/grants')) return Promise.resolve({ data: { grants: [] } });
    if (url.includes('/registry/pods/')) return Promise.resolve({ data: { agents: [] } });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
  renderTools();
  expect(await screen.findByText('not enabled on this instance · ask your operator')).toBeInTheDocument();
  const ask = screen.getByRole('link', { name: 'Ask' });
  expect(ask).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly/issues/new?title=Connector%20request');
  expect(ask.closest('.v2-connector-row')).toHaveClass('v2-connector-row--not-enabled');
});

test('Change access mints a new grant then revokes the old one; Grant again on a dead grant only mints', async () => {
  mockApi([githubEntry]);
  axios.post.mockResolvedValue({ data: { grantId: 'grant_new' } });
  renderTools();
  fireEvent.click(await screen.findByRole('button', { name: 'View GitHub in Launch pod' }));
  const aside = await screen.findByRole('complementary', { name: 'Grant details' });
  // Under `write` the aside names the irreversible tools from the catalogue.
  expect(within(aside).getByText('asks a person first').nextElementSibling).toHaveTextContent('every write asks first');
  fireEvent.click(within(aside).getByRole('button', { name: 'Change access' }));
  const form = await screen.findByRole('complementary', { name: 'Change access' });
  expect(within(form).getByRole('button', { name: 'read and write, ask first' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(form).getByRole('checkbox', { name: 'Scout' })).toBeChecked();
  fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  expect(axios.post.mock.calls[0][0]).toBe('/api/grants');
  expect(axios.post.mock.calls[1][0]).toBe('/api/grants/grant_live/revoke');

  axios.post.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Grant again' }));
  const again = await screen.findByRole('complementary', { name: 'Add GitHub' });
  expect(within(again).getByRole('heading', { name: 'GitHub · Ops' })).toBeInTheDocument();
  fireEvent.click(within(again).getByRole('button', { name: 'Grant' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(axios.post.mock.calls[0][0]).toBe('/api/grants');
});

test('Revoke renders only for the granter', async () => {
  mockApi([githubEntry]);
  const member = { ...authValue, currentUser: { _id: 'u2', username: 'rae' }, user: { _id: 'u2', username: 'rae' } };
  render(<AuthContext.Provider value={member}><MemoryRouter><V2ConnectorTools pods={pods} /></MemoryRouter></AuthContext.Provider>);
  fireEvent.click(await screen.findByRole('button', { name: 'View GitHub in Launch pod' }));
  const aside = await screen.findByRole('complementary', { name: 'Grant details' });
  expect(within(aside).getByText(/Granted by sam/)).toBeInTheDocument();
  expect(within(aside).queryByRole('button', { name: 'Revoke' })).toBeNull();
  expect(within(aside).queryByRole('button', { name: 'Change access' })).toBeNull();
  // The trail is the room's: a member still reads it.
  await waitFor(() => expect(within(aside).getByText('calls').previousElementSibling).toHaveTextContent('3'));
});

test('Grant again renders only for the granter', async () => {
  mockApi([githubEntry]);
  const member = { ...authValue, currentUser: { _id: 'u2', username: 'rae' }, user: { _id: 'u2', username: 'rae' } };
  render(<AuthContext.Provider value={member}><MemoryRouter><V2ConnectorTools pods={pods} /></MemoryRouter></AuthContext.Provider>);
  await screen.findByRole('button', { name: 'View GitHub in Ops' });
  // The dead row offers a member Manage (read the grant), never the mint.
  expect(screen.queryByRole('button', { name: 'Grant again' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Manage' })).toHaveLength(2);
});

test('Change access keeps the minted grant when the revoke fails and retries only the revoke', async () => {
  mockApi([githubEntry]);
  axios.post.mockImplementation((url) => (url === '/api/grants'
    ? Promise.resolve({ data: { grantId: 'grant_new' } })
    : Promise.reject(new Error('revoke down'))));
  renderTools();
  fireEvent.click(await screen.findByRole('button', { name: 'View GitHub in Launch pod' }));
  fireEvent.click(within(await screen.findByRole('complementary', { name: 'Grant details' })).getByRole('button', { name: 'Change access' }));
  fireEvent.click(within(await screen.findByRole('complementary', { name: 'Change access' })).getByRole('button', { name: 'Grant' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  const aside = await screen.findByRole('complementary', { name: 'Grant details' });
  expect(await within(aside).findByText('The new grant is live. This old one still is too — its revoke did not go through.')).toBeInTheDocument();
  expect(within(aside).queryByRole('button', { name: 'Revoke' })).toBeNull();
  axios.post.mockResolvedValue({ data: { grantId: 'grant_live', revoked: 1 } });
  fireEvent.click(within(aside).getByRole('button', { name: 'Revoke the old grant' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(3));
  // Only the revoke went out again — no third mint.
  expect(axios.post.mock.calls.map(([u]) => u)).toEqual(['/api/grants', '/api/grants/grant_live/revoke', '/api/grants/grant_live/revoke']);
});

test('TASK-133: a live grant on one entry leaves the other entry under Not yet', async () => {
  mockTwoEntries();
  const { container } = renderTools();
  expect(await screen.findByRole('heading', { name: 'Tools' })).toBeInTheDocument();
  // One entry granted, so exactly one is still to grant — and the entry the
  // grant names is the one that leaves the list (label and glyph from its own entry).
  expect(screen.getByText('1 granted · 1 more')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'View Linear in Launch pod' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'View GitHub in Launch pod' })).not.toBeInTheDocument();
  const notYet = container.querySelectorAll('.v2-connector-row--not-yet');
  expect(notYet).toHaveLength(1);
  expect(notYet[0].textContent).toContain('GitHub');
  expect(notYet[0].textContent).toContain('Issues and pull requests.');
});

test('TASK-133: the granted entry itself leaves Not yet, the other one stays', async () => {
  mockTwoEntries({ grants: { p1: [grantLive], p2: [grantRevoked] } });
  const { container } = renderTools();
  expect(await screen.findByRole('button', { name: 'View GitHub in Launch pod' })).toBeInTheDocument();
  const notYet = container.querySelectorAll('.v2-connector-row--not-yet');
  expect(notYet).toHaveLength(1);
  expect(notYet[0].textContent).toContain('Linear');
  expect(notYet[0].textContent).not.toContain('GitHub');
});

test('TASK-133: with every entry granted the header carries no "more"', async () => {
  mockTwoEntries({ grants: { p1: [grantLive, grantLinear], p2: [grantRevoked] } });
  const { container } = renderTools();
  expect(await screen.findByText('2 granted')).toBeInTheDocument();
  expect(screen.queryByText(/· \d+ more/)).not.toBeInTheDocument();
  expect(container.querySelectorAll('.v2-connector-row--not-yet')).toHaveLength(0);
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
