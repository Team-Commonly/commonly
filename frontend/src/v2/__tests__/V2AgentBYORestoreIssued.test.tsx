// @ts-nocheck
// F572: the issued command lived only in page memory. A reload before running
// it, then a resubmit, answered existing:true and the page asked to replace a
// key nobody had used. The page now keeps the connect code (never the key) in
// sessionStorage and shows the same line again.
import React from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
jest.mock('../components/V2NavRail', () => () => null);
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

const authValue = {
  currentUser: { _id: 'u1', username: 'sam' },
  user: { _id: 'u1', username: 'sam' },
  token: 'user-jwt',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const TOKEN = 'cm_agent_secret_token_value';
const CODE = 'cmc_' + 'A1b2C3d4E5f6G7h8I9j0K-';
const CODE2 = 'cmc_' + 'Z9y8X7w6V5u4T3s2R1q0P_';
const inMinutes = (n) => new Date(Date.now() + n * 60_000).toISOString();
// The server's record of when the current key was made, on the issue answer
// and on an existing:true answer alike.
const KEY_AT = '2026-11-24T10:00:00.000Z';
const OTHER_KEY_AT = '2026-11-24T10:05:00.000Z';

let connection = {};
// What the runtime-tokens route answers next, in order.
let tokenReplies = [];
let installAlready = false;

beforeEach(() => {
  sessionStorage.clear();
  connection = {};
  tokenReplies = [];
  installAlready = false;
  axios.get.mockReset();
  axios.post.mockReset();
  axios.get.mockImplementation((url) => {
    if (url === '/api/users/me/agent-connection') return Promise.resolve({ data: connection });
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
    if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: false, caps: { agentsPerUser: 3, turnsPerDay: 20 } } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    return Promise.resolve({ data: {} });
  });
  axios.post.mockImplementation((url) => {
    if (url === '/api/registry/install') {
      return installAlready
        ? Promise.reject({ response: { data: { error: 'Agent already installed in this pod' } } })
        : Promise.resolve({ data: { ok: true } });
    }
    if (/runtime-tokens/.test(url)) return Promise.resolve({ data: tokenReplies.shift() || {} });
    return Promise.resolve({ data: {} });
  });
});

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const submit = async () => {
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
};

const storedKeys = () => Object.keys(sessionStorage).filter((k) => k.startsWith('byo-issued:'));
const listenBox = () => document.querySelector('[data-testid="byo-listen"] .v2-byo__command .v2-byo__pre');
const tokenBodies = () => axios.post.mock.calls.filter(([url]) => /runtime-tokens/.test(url)).map(([, body]) => body);

// Issue once with a fresh code, then "reload": unmount and render again.
const issueThenReload = async (expiresAt = inMinutes(30)) => {
  tokenReplies = [{ token: TOKEN, connectCode: CODE, connectCodeExpiresAt: expiresAt, createdAt: KEY_AT }];
  renderPage();
  await submit();
  await screen.findByText(/your connect command for/i);
  cleanup();
  installAlready = true;
  tokenReplies = [{ existing: true, createdAt: KEY_AT }];
  renderPage();
  await submit();
};

describe('BYO reload keeps the issued command (F572)', () => {
  test('a reload and resubmit shows the same line again, with no replace prompt', async () => {
    await issueThenReload();
    await screen.findByText(/your connect command for/i);
    expect(listenBox().textContent).toContain(`--connect ${CODE}`);
    expect(screen.queryByTestId('byo-replace-key-confirmation')).not.toBeInTheDocument();
    expect(tokenBodies()).toHaveLength(2);
    expect(tokenBodies()[1].force).toBeUndefined();
  });

  test('the entry is keyed by user, pod, agent and instance, and never holds the key', async () => {
    tokenReplies = [{ token: TOKEN, connectCode: CODE, connectCodeExpiresAt: inMinutes(30), createdAt: KEY_AT }];
    renderPage();
    await submit();
    await screen.findByText(/your connect command for/i);
    const keys = storedKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^byo-issued:u1:p1:[^:]+:default$/);
    const raw = sessionStorage.getItem(keys[0]);
    expect(raw).toContain(CODE);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toMatch(/token/i);
  });

  test('existing:true with nothing stored still asks to replace the key', async () => {
    installAlready = true;
    tokenReplies = [{ existing: true }];
    renderPage();
    await submit();
    await screen.findByTestId('byo-replace-key-confirmation');
    expect(screen.queryByText(/your connect command for/i)).not.toBeInTheDocument();
  });

  test('an expired stored code is ignored and removed', async () => {
    tokenReplies = [{ token: TOKEN, connectCode: CODE, connectCodeExpiresAt: inMinutes(30), createdAt: KEY_AT }];
    renderPage();
    await submit();
    await screen.findByText(/your connect command for/i);
    const [key] = storedKeys();
    const entry = JSON.parse(sessionStorage.getItem(key));
    cleanup();
    sessionStorage.setItem(key, JSON.stringify({ ...entry, connectCodeExpiresAt: Date.now() - 1000 }));
    installAlready = true;
    tokenReplies = [{ existing: true, createdAt: KEY_AT }];
    renderPage();
    await submit();
    await screen.findByTestId('byo-replace-key-confirmation');
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  // Plant an entry for this page's agent as the page itself would write it.
  const plantFor = async (entry) => {
    tokenReplies = [{ token: TOKEN, connectCode: CODE, connectCodeExpiresAt: inMinutes(30), createdAt: KEY_AT }];
    renderPage();
    await submit();
    await screen.findByText(/your connect command for/i);
    const [key] = storedKeys();
    const stored = JSON.parse(sessionStorage.getItem(key));
    cleanup();
    sessionStorage.setItem(key, JSON.stringify({ ...stored, ...entry }));
    return key;
  };
  const resubmitExisting = async (createdAt = KEY_AT) => {
    installAlready = true;
    tokenReplies = [{ existing: true, createdAt }];
    renderPage();
    await submit();
  };

  test('a key replaced elsewhere (another createdAt) shows the replace prompt and drops the entry', async () => {
    const key = await plantFor({});
    await resubmitExisting(OTHER_KEY_AT);
    await screen.findByTestId('byo-replace-key-confirmation');
    expect(screen.queryByText(/your connect command for/i)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  test('an existing:true answer without a createdAt restores nothing', async () => {
    const key = await plantFor({});
    installAlready = true;
    tokenReplies = [{ existing: true }];
    renderPage();
    await submit();
    await screen.findByTestId('byo-replace-key-confirmation');
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  test('a malformed stored code shows the replace prompt and is dropped', async () => {
    const key = await plantFor({ connectCode: 'cmc_short; rm -rf ~' });
    await resubmitExisting();
    await screen.findByTestId('byo-replace-key-confirmation');
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  test('opening the page as one user sweeps another user\'s entries and keeps its own', async () => {
    const entry = JSON.stringify({ connectCode: CODE, connectCodeExpiresAt: Date.now() + 60_000, issuedAt: Date.now(), keyCreatedAt: KEY_AT, adapter: 'claude', os: 'mac' });
    sessionStorage.setItem('byo-issued:u2:p1:alice-claude:default', entry);
    sessionStorage.setItem('byo-issued:u1:p1:sam-claude:default', entry);
    sessionStorage.setItem('unrelated', 'kept');
    renderPage();
    await waitFor(() => expect(sessionStorage.getItem('byo-issued:u2:p1:alice-claude:default')).toBeNull());
    expect(sessionStorage.getItem('byo-issued:u1:p1:sam-claude:default')).toBe(entry);
    expect(sessionStorage.getItem('unrelated')).toBe('kept');
  });

  describe('a named instance', () => {
    beforeEach(() => { window.history.pushState({}, '', '/?pod=p1&name=sam-claude&instanceId=nova'); });
    afterEach(() => { window.history.pushState({}, '', '/'); });

    test('restores under its own key', async () => {
      await issueThenReload();
      await screen.findByText(/your connect command for/i);
      expect(storedKeys()).toEqual(['byo-issued:u1:p1:sam-claude:nova']);
      expect(listenBox().textContent).toContain(`--connect ${CODE}`);
      expect(screen.queryByTestId('byo-replace-key-confirmation')).not.toBeInTheDocument();
    });

    test('does not restore the default instance\'s line', async () => {
      const entry = JSON.stringify({ connectCode: CODE, connectCodeExpiresAt: Date.now() + 30 * 60_000, issuedAt: Date.now(), keyCreatedAt: KEY_AT, adapter: 'claude', os: 'mac' });
      sessionStorage.setItem('byo-issued:u1:p1:sam-claude:default', entry);
      await resubmitExisting();
      await screen.findByTestId('byo-replace-key-confirmation');
      expect(sessionStorage.getItem('byo-issued:u1:p1:sam-claude:default')).toBe(entry);
    });
  });

  test('a code that runs out on the page is dropped from storage', async () => {
    jest.useFakeTimers();
    try {
      tokenReplies = [{ token: TOKEN, connectCode: CODE, connectCodeExpiresAt: inMinutes(2), createdAt: KEY_AT }];
      renderPage();
      await submit();
      await screen.findByText(/your connect command for/i);
      expect(storedKeys()).toHaveLength(1);
      await act(async () => { jest.advanceTimersByTime(2 * 60_000 + 1000); });
      await screen.findByTestId('byo-line-expired');
      expect(storedKeys()).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('when sessionStorage throws', () => {
    let getSpy; let setSpy;
    beforeEach(() => {
      getSpy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
      setSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    });
    afterEach(() => { getSpy.mockRestore(); setSpy.mockRestore(); });

    test('issuing still shows the command, and a resubmit still asks to replace the key', async () => {
      tokenReplies = [{ token: TOKEN, connectCode: CODE, connectCodeExpiresAt: inMinutes(30), createdAt: KEY_AT }];
      renderPage();
      await submit();
      await screen.findByText(/your connect command for/i);
      expect(listenBox().textContent).toContain(`--connect ${CODE}`);
      cleanup();
      installAlready = true;
      tokenReplies = [{ existing: true }];
      renderPage();
      await submit();
      await screen.findByTestId('byo-replace-key-confirmation');
    });
  });

  test('the entry is cleared once the agent is seen listening', async () => {
    tokenReplies = [{ token: TOKEN, connectCode: CODE, connectCodeExpiresAt: inMinutes(30), createdAt: KEY_AT }];
    jest.useFakeTimers();
    try {
      renderPage();
      await submit();
      await screen.findByText(/your connect command for/i);
      expect(storedKeys()).toHaveLength(1);
      const name = screen.getByTestId('byo-listen-waiting').textContent.match(/for (\S+) to check in/)[1];
      connection = { connected: true, connectedAgent: { agentName: name }, lastUsedAt: new Date().toISOString() };
      await act(async () => { jest.advanceTimersByTime(5_000); });
      await waitFor(() => expect(screen.getByTestId('byo-listen-ok')).toBeInTheDocument());
      expect(storedKeys()).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('replacing the key drops the old code', async () => {
    await issueThenReload();
    await screen.findByText(/your connect command for/i);
    const [key] = storedKeys();
    tokenReplies = [{ token: 'cm_agent_new_token', connectCode: CODE2, connectCodeExpiresAt: inMinutes(30) }];
    fireEvent.click(screen.getByTestId('byo-restored-new-key'));
    await waitFor(() => expect(listenBox().textContent).toContain(`--connect ${CODE2}`));
    expect(tokenBodies()[2]).toMatchObject({ force: true, connectCode: true });
    const raw = sessionStorage.getItem(key);
    expect(raw || '').not.toContain(CODE);
    expect(raw || '').not.toContain('cm_agent_new_token');
    // A new key's view is whole again.
    expect(screen.queryByTestId('byo-restored-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('byo-mcp-details')).toBeInTheDocument();
  });

  test('the restored view hides everything that needs the key and offers a new one', async () => {
    await issueThenReload();
    await screen.findByText(/your connect command for/i);
    expect(screen.getByTestId('byo-restored-note')).toBeInTheDocument();
    expect(screen.getByTestId('byo-restored-new-key')).toBeEnabled();
    expect(screen.queryByTestId('byo-mcp-details')).not.toBeInTheDocument();
    expect(screen.queryByTestId('byo-key-once')).not.toBeInTheDocument();
    expect(screen.queryByText(/the key on its own/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /add to cursor/i })).not.toBeInTheDocument();
    expect(document.querySelector('.v2-byo__memory-text')).toBeNull();
    // No snippet on the page carries an empty key.
    expect(document.body.textContent).not.toMatch(/COMMONLY_AGENT_TOKEN=\s/);
  });
});
