// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// The listening-verification loop on the BYO page (#887 class, second half).
// #888 made the listening step legible; this pins the step being CHECKABLE:
// the page polls /api/users/me/agent-connection until THIS agent's runtime
// token authenticates after issuance, then flips the step to a checkmark and
// drops the departure warning. The time-fence and name-match keep a
// pre-existing connected agent from ever flipping the checkmark for the one
// just issued.
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
// This suite owns the BYO request sequence, not the rail's attention query.
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

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const issueToken = async () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    return Promise.resolve({ data: {} });
  });
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } }); // runtime-tokens

  renderPage();
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
  await screen.findByText(/your connect command for/i);
};

beforeEach(() => {
  axios.get.mockImplementation((url) => (
    url.startsWith('/api/registry/agents/next-free-name?')
      ? Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } })
      : Promise.resolve({ data: {} })
  ));
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('V2AgentBYO listening verification', () => {

  // F457: the quick-try run found no harness and exited before checking in.
  // It reported that first, so the page says so instead of waiting forever,
  // keeps polling, and still turns green once the person installs it and reruns.
  test('says the harness is missing when this agent\'s run reported it, then still flips to verified', async () => {
    jest.useFakeTimers();
    await issueToken();
    const missingRead = (rows) => ({ data: { issued: true, connected: false, lastUsedAt: null, connectedAgent: null, harnessMissing: rows } });

    // Another agent's report, and an old one for this agent, change nothing.
    axios.get.mockResolvedValueOnce(missingRead([
      { agentName: 'old-agent', instanceId: 'default', harness: 'codex', at: new Date().toISOString() },
      { agentName: 'sam-claude', instanceId: 'default', harness: 'claude', at: '2020-01-01T00:00:00.000Z' },
      { agentName: 'sam-claude', instanceId: 'second', harness: 'claude', at: new Date().toISOString() },
    ]));
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.queryByTestId('byo-listen-harness-missing')).not.toBeInTheDocument();
    expect(screen.getByTestId('byo-listen-waiting')).toHaveTextContent(/Waiting for sam-claude to check in/);
    expect(screen.getByTestId('byo-listen-waiting')).not.toHaveClass('v2-byo__listen-note--stopped');

    axios.get.mockResolvedValueOnce(missingRead([
      { agentName: 'sam-claude', instanceId: 'default', harness: 'claude', at: new Date().toISOString() },
    ]));
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-listen-harness-missing')).toHaveTextContent(
      'sam-claude’s command stopped: Claude Code isn’t installed on that computer.',
    );
    // F458: a stopped command reads as a warning, not the pending dot.
    expect(screen.getByTestId('byo-listen-waiting')).toHaveClass('v2-byo__listen-note--stopped');

    axios.get.mockResolvedValueOnce(missingRead([
      { agentName: 'sam-claude', instanceId: 'default', harness: null, at: new Date().toISOString() },
    ]));
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-listen-harness-missing')).toHaveTextContent(/found no Claude Code, Codex or pi/);

    axios.get.mockResolvedValueOnce({
      data: {
        issued: true, connected: true, lastUsedAt: new Date().toISOString(),
        connectedAgent: { agentName: 'sam-claude', instanceId: 'default', podId: 'p1' },
      },
    });
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-listen-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-harness-missing')).not.toBeInTheDocument();
  });
  // F515: the run found the harness signed out, or Node too old, and stopped
  // before it started waiting. The newer of this agent's reports is the one
  // shown, and polling goes on.
  test('says the harness is signed out or Node is too old, whichever this run reported last', async () => {
    jest.useFakeTimers();
    await issueToken();
    const now = Date.now();
    const read = (fields) => ({ data: { issued: true, connected: false, lastUsedAt: null, connectedAgent: null, ...fields } });

    axios.get.mockResolvedValueOnce(read({
      harnessMissing: [{ agentName: 'sam-claude', instanceId: 'default', harness: 'claude', at: new Date(now).toISOString() }],
      listenBlocked: [{
        agentName: 'sam-claude', instanceId: 'default', reason: 'harness-signed-out', harness: 'claude', at: new Date(now + 1000).toISOString(),
      }],
    }));
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-listen-harness-missing')).toHaveTextContent(
      'sam-claude’s command stopped: Claude Code is installed on that computer but not signed in. Run claude there once to sign in',
    );
    expect(screen.getByTestId('byo-listen-waiting')).toHaveClass('v2-byo__listen-note--stopped');

    axios.get.mockResolvedValueOnce(read({
      listenBlocked: [{ agentName: 'sam-claude', instanceId: 'default', reason: 'node-too-old', harness: null, at: new Date(now + 2000).toISOString() }],
    }));
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-listen-harness-missing')).toHaveTextContent(
      'sam-claude’s command stopped: that computer’s Node is older than version 22.',
    );

    // Another agent's report, or a code this build doesn't know, shows nothing.
    axios.get.mockResolvedValueOnce(read({
      listenBlocked: [
        { agentName: 'old-agent', instanceId: 'default', reason: 'node-too-old', harness: null, at: new Date(now + 3000).toISOString() },
        { agentName: 'sam-claude', instanceId: 'default', reason: 'something-new', harness: null, at: new Date(now + 3000).toISOString() },
      ],
    }));
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.queryByTestId('byo-listen-harness-missing')).not.toBeInTheDocument();
  });

  test('waits, then flips to verified when THIS agent checks in after issuance', async () => {
    jest.useFakeTimers();
    await issueToken();

    // Pre-flip: waiting indicator + honest departure warning are visible.
    expect(screen.getByTestId('byo-listen-waiting')).toBeInTheDocument();
    expect(screen.getByTestId('byo-cta-warning')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-ok')).not.toBeInTheDocument();
    // The fill marks the next step: Copy until it's listening, then the pod.
    expect(screen.getAllByRole('button', { name: 'Copy' })[0]).toHaveClass('v2-byo__copy--next');
    expect(screen.getByRole('button', { name: 'Go to your pod' })).toHaveClass('v2-byo__secondary--waiting');

    // The rail reads the same state as the page (TASK-169). It used to read
    // "not created yet" while the page beside it said the install had
    // succeeded — a token had already been issued, so that was false.
    const rail = screen.getByTestId('byo-preview');
    expect(rail.querySelector('.v2-byo__preview-status--waiting')).not.toBeNull();
    expect(rail.querySelector('.v2-byo__preview-status--draft')).toBeNull();
    expect(screen.getByText('not listening yet')).toBeInTheDocument();

    // First poll: a DIFFERENT (pre-existing) agent is connected — must NOT flip.
    axios.get.mockResolvedValueOnce({
      data: {
        issued: true,
        connected: true,
        lastUsedAt: new Date().toISOString(),
        connectedAgent: { agentName: 'old-agent', instanceId: 'default', podId: 'p9' },
      },
    });
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.queryByTestId('byo-listen-ok')).not.toBeInTheDocument();

    // Second poll: the just-issued agent (sam-claude: your own agent defaults
    // to `<user>-<adapter>`) authenticates.
    axios.get.mockResolvedValueOnce({
      data: {
        issued: true,
        connected: true,
        lastUsedAt: new Date().toISOString(),
        connectedAgent: { agentName: 'sam-claude', instanceId: 'default', podId: 'p1' },
      },
    });
    await act(async () => { jest.advanceTimersByTime(4000); });

    expect(screen.getByTestId('byo-listen-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-cta-warning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-waiting')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to your pod' })).toHaveClass('v2-byo__submit');
    expect(screen.getAllByRole('button', { name: 'Copy' })[0]).not.toHaveClass('v2-byo__copy--next');
    // ...and the rail follows it out of waiting, since it reads the same state.
    expect(rail.querySelector('.v2-byo__preview-status--live')).not.toBeNull();
    expect(rail.querySelector('.v2-byo__preview-status--waiting')).toBeNull();

    // Polling stops after success — no further connection reads.
    const readsAfterFlip = axios.get.mock.calls.filter(
      ([url]) => url === '/api/users/me/agent-connection',
    ).length;
    await act(async () => { jest.advanceTimersByTime(12000); });
    expect(axios.get.mock.calls.filter(
      ([url]) => url === '/api/users/me/agent-connection',
    ).length).toBe(readsAfterFlip);
  });

  // TASK-721: a stranger copied the MCP snippet three times and never the
  // Terminal command (walk 2026-10-31). After three minutes the page names it.
  describe('the missed Terminal command', () => {
    // The missed-command line quotes the command too, so pick the snippet itself.
    const snippetBlock = (matcher) => screen.getAllByText(matcher)
      .find((el) => el.classList.contains('v2-byo__pre')).closest('.v2-byo__command');
    const copyBlock = (matcher) => fireEvent.copy(snippetBlock(matcher));
    const waitingText = () => screen.getByTestId('byo-listen-waiting').textContent;

    test('MCP snippet copied, listener command not, after three minutes: names the Terminal command', async () => {
      jest.useFakeTimers();
      await issueToken();
      copyBlock(/claude mcp add/);

      await act(async () => { jest.advanceTimersByTime(2 * 60 * 1000); });
      expect(waitingText()).not.toMatch(/not the Terminal command/);

      await act(async () => { jest.advanceTimersByTime(61 * 1000); });
      expect(waitingText()).toMatch(/copied the MCP snippet, but not the Terminal command that starts sam-claude, the one that ends in commonly agent run sam-claude/);
    });

    test('the Copy buttons count the same way as a manual copy', async () => {
      jest.useFakeTimers();
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) },
      });
      await issueToken();
      const copyButtonFor = (matcher) => snippetBlock(matcher).querySelector('button');

      await act(async () => { fireEvent.click(copyButtonFor(/claude mcp add/)); });
      await act(async () => { jest.advanceTimersByTime(3 * 60 * 1000 + 1000); });
      expect(waitingText()).toMatch(/not the Terminal command that starts sam-claude/);

      await act(async () => { fireEvent.click(copyButtonFor(/commonly agent run sam-claude/)); });
      expect(waitingText()).not.toMatch(/not the Terminal command/);
    });

    test('the listener command copied too: keeps the plain waiting line', async () => {
      jest.useFakeTimers();
      await issueToken();
      copyBlock(/claude mcp add/);
      copyBlock(/commonly agent run sam-claude/);

      await act(async () => { jest.advanceTimersByTime(4 * 60 * 1000); });
      expect(waitingText()).not.toMatch(/not the Terminal command/);
    });

    test('nothing copied at all: keeps the plain waiting line', async () => {
      jest.useFakeTimers();
      await issueToken();

      await act(async () => { jest.advanceTimersByTime(4 * 60 * 1000); });
      expect(waitingText()).not.toMatch(/not the Terminal command/);
    });
  });

  test('a transient poll failure keeps waiting rather than erroring', async () => {
    jest.useFakeTimers();
    await issueToken();

    axios.get.mockRejectedValueOnce(new Error('network blip'));
    await act(async () => { jest.advanceTimersByTime(4000); });

    expect(screen.getByTestId('byo-listen-waiting')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-ok')).not.toBeInTheDocument();
  });

  test('the listen snippet carries the CLI install line for first-time machines', async () => {
    jest.useFakeTimers();
    await issueToken();
    // Scoped to the listen snippet: the result page's Other ways block also shows an npm line.
    expect(screen.getByText(/commonly agent run sam-claude/)).toHaveTextContent(/npm i -g @commonlyai\/cli/);
  });
});
