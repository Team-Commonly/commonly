// @ts-nocheck
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// F508: Claude Code's connect page put about 330 words on folders, Work in my
// repo and pull requests between the waiting line and the way to the pod, and a
// newcomer who created a Claude Code agent copied nothing. That detail is now
// folded behind one disclosure, as short as the Codex page; nothing is dropped.
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

// The page names the Node floor the CLI declares. Read it from cli/package.json
// rather than copying the number, so a CLI engines bump fails this test.
const CLI_NODE_FLOOR = Number(require('../../../../cli/package.json').engines.node.match(/\d+/)[0]);

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

let hostedConfigured = false;

const issueToken = async (runner?: 'codex', pod = {}) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', ...pod }] });
    if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: hostedConfigured, caps: { agentsPerUser: 3, turnsPerDay: 20 } } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    return Promise.resolve({ data: {} });
  });
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } }); // runtime-tokens
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter>
        <V2AgentBYO />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  if (hostedConfigured) fireEvent.click(await screen.findByTestId('byo-mode-byo'));
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  if (runner) fireEvent.click(screen.getByTestId(`byo-runner-${runner}`));
  // The runner sets the default name, which re-checks it, so wait for the button again.
  if (runner) await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
  await screen.findByText(/your connect command for/i);
};


const PRIVATE_POD = { joinPolicy: 'invite-only', publicRead: false, communityListed: false };
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const realUserAgent = window.navigator.userAgent;
const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Claude Code connect page: folder and permission detail is folded (F508)', () => {
  beforeEach(() => { jest.clearAllMocks(); setUserAgent(MAC); });
  afterEach(() => setUserAgent(realUserAgent));

  test('the reach note and the repo choice sit in one closed disclosure after the waiting line', async () => {
    await issueToken(undefined, PRIVATE_POD);
    const fold = screen.getByTestId('byo-folder-details');
    expect(fold.tagName).toBe('DETAILS');
    expect(fold).not.toHaveAttribute('open');
    expect(within(fold).getByText(/^Folder and permissions \(optional\)$/)).toBeInTheDocument();
    expect(fold).toContainElement(screen.getByTestId('byo-listen-reach'));
    expect(fold).toContainElement(screen.getByTestId('byo-repo-choice'));
    expect(fold).toContainElement(screen.getByTestId('byo-repo-issue-to-pr'));
    // The waiting line and the MCP-alone note stay in view, before the fold.
    expect(follows(screen.getByTestId('byo-listen-waiting'), fold)).toBe(true);
    expect(fold).not.toContainElement(screen.getByTestId('byo-listen-waiting'));
    expect(follows(fold, screen.getByTestId('byo-key-once'))).toBe(true);
  });

  test('ticking Work in my repo says so on the fold, so a closed fold still shows the choice', async () => {
    await issueToken(undefined, PRIVATE_POD);
    fireEvent.click(screen.getByTestId('byo-repo-toggle'));
    const fold = screen.getByTestId('byo-folder-details');
    expect(within(fold).getByText(/^Folder and permissions: Work in my repo is on$/)).toBeInTheDocument();
  });

  test('in a pod not confirmed private the fold still holds the reach note, without the repo choice', async () => {
    await issueToken(undefined, { joinPolicy: 'invite-only' });
    const fold = screen.getByTestId('byo-folder-details');
    expect(fold).toContainElement(screen.getByTestId('byo-listen-reach'));
    expect(screen.queryByTestId('byo-repo-choice')).toBeNull();
  });

  test('Codex keeps its one short note and gets no fold', async () => {
    await issueToken('codex', PRIVATE_POD);
    expect(screen.queryByTestId('byo-folder-details')).toBeNull();
    expect(screen.getByTestId('byo-listen-reach-codex')).toBeInTheDocument();
  });
});
