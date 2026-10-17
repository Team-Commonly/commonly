// @ts-nocheck
// QA BYO walk 2 (2026-10-16): after approving Scout's connect card, the page
// still asked "Where should it run?" and showed the name and pod fields, 127
// words before the button, most of them re-asking what the card settled.
// From a card (?from=card) the page is the act and where it lands. The key is
// still minted by the click, never on load.
import React from 'react';
import { render, screen, fireEvent, waitFor, act as act_ } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

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

const pods = [
  { _id: 'aaa111', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } },
  { _id: 'bbb222', name: 'Launch', type: 'chat', createdBy: { _id: 'u1' } },
];

beforeEach(() => {
  // Hosting is available, so a bare visit would ask where it should run.
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: pods });
    if (url === '/api/machines') return Promise.resolve({ data: { machines: [] } });
    return Promise.resolve({ data: {} });
  });
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } }); // runtime-tokens
});

afterEach(() => {
  jest.clearAllMocks();
  window.history.pushState({}, '', '/');
});

const renderAt = (url) => {
  window.history.pushState({}, '', url);
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={[url]}>
        <V2AgentBYO />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
};

const CARD = '/v2/agents/byo?pod=bbb222&name=sam-claude&from=card';

describe('BYO from an approved connect card', () => {
  test('asks nothing the card settled: no choice of where, no name or pod field', async () => {
    renderAt(CARD);
    const compact = await screen.findByTestId('byo-card-compact');
    await waitFor(() => expect(compact).toHaveTextContent('It joins Launch as sam-claude.'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Connect your Claude Code');
    expect(screen.queryByTestId('byo-mode-hosted')).toBeNull();
    expect(screen.queryByTestId('byo-mode-byo')).toBeNull();
    expect(screen.queryByRole('combobox', { name: /pod it joins/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('no key is minted on load; the click mints it for the card\'s name and pod', async () => {
    renderAt(CARD);
    const act = await screen.findByRole('button', { name: /get my connect command/i });
    await waitFor(() => expect(act).toBeEnabled());
    expect(axios.post).not.toHaveBeenCalled();
    fireEvent.click(act);
    await screen.findByTestId('byo-listen');
    const install = axios.post.mock.calls.find(([url]) => url === '/api/registry/install');
    expect(install[1]).toMatchObject({ agentName: 'sam-claude', podId: 'bbb222' });
    expect(axios.post.mock.calls.some(([url]) => /pods\/bbb222\/agents\/sam-claude\/runtime-tokens/.test(url))).toBe(true);
  });

  test('a card for Codex opens on Codex: the title and the command say so', async () => {
    renderAt('/v2/agents/byo?pod=bbb222&name=lee-codex&from=card&adapter=codex');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Connect your Codex');
    const act = await screen.findByRole('button', { name: /get my connect command/i });
    await waitFor(() => expect(act).toBeEnabled());
    fireEvent.click(act);
    await screen.findByTestId('byo-listen');
    const pre = Array.from(document.querySelectorAll('.v2-byo__pre'))
      .find((el) => /commonly agent run /.test(el.textContent || ''));
    expect((pre.textContent || '').split('\n')[3]).toBe('commonly agent run lee-codex --adapter codex');
  });

  // sprint-review on #2293: ?adapter= is a URL parameter anyone can type or
  // send, and the page puts it into the command a person pastes into their
  // shell. Only a listed tool may get there; anything else is Claude Code.
  const commandFor = async (adapter, beforeClick = () => {}) => {
    renderAt(`/v2/agents/byo?pod=bbb222&name=sam-claude&from=card&adapter=${encodeURIComponent(adapter)}`);
    await screen.findByTestId('byo-card-compact');
    beforeClick();
    const act = await screen.findByRole('button', { name: /get my connect command/i });
    await waitFor(() => expect(act).toBeEnabled());
    fireEvent.click(act);
    await screen.findByTestId('byo-listen');
    return Array.from(document.querySelectorAll('.v2-byo__pre'))
      .find((el) => /commonly agent run /.test(el.textContent || '')).textContent || '';
  };

  test('an unlisted ?adapter= is Claude Code', async () => {
    const command = await commandFor('cursor', () => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Connect your Claude Code');
    });
    expect(command.split('\n')[3]).toBe('commonly agent run sam-claude --adapter claude');
  });

  test('an ?adapter= carrying shell syntax never reaches the command', async () => {
    const command = await commandFor('codex;id');
    expect(command.split('\n')[3]).toBe('commonly agent run sam-claude --adapter claude');
    expect(command).not.toContain(';');
  });

  test('"Change" opens the full page with the card\'s choices still made', async () => {
    renderAt(CARD);
    const compact = await screen.findByTestId('byo-card-compact');
    await waitFor(() => expect(compact).toHaveTextContent('It joins Launch as sam-claude.'));
    fireEvent.click(screen.getByRole('button', { name: /^change$/i }));
    expect(await screen.findByTestId('byo-mode-byo')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: /pod it joins/i })).toHaveValue('bbb222');
    expect(screen.getByDisplayValue('sam-claude')).toBeInTheDocument();
  });

  test('a pod the person cannot install into is replaced before the act is enabled, and the line names the new one', async () => {
    renderAt('/v2/agents/byo?pod=deadbeef&name=sam-claude&from=card');
    const compact = await screen.findByTestId('byo-card-compact');
    await waitFor(() => expect(compact).toHaveTextContent('It joins Workspace as sam-claude.'));
    expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled();
  });

  test('the act waits for the pod list: nothing is minted for a pod the page has not confirmed', async () => {
    let answerPods;
    axios.get.mockImplementation((url) => {
      if (url === '/api/pods') return new Promise((resolve) => { answerPods = resolve; });
      if (url.startsWith('/api/hosted/availability')) {
        return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
      }
      return Promise.resolve({ data: {} });
    });
    renderAt(CARD);
    const act = await screen.findByRole('button', { name: /get my connect command/i });
    expect(act).toBeDisabled();
    await act_(async () => { answerPods({ data: pods }); });
    await waitFor(() => expect(act).toBeEnabled());
  });

  test('a link without from=card still gets the full page (the new-pod "connect an agent" button)', async () => {
    renderAt('/v2/agents/byo?pod=bbb222&name=sam-agent');
    expect(await screen.findByTestId('byo-mode-byo')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-card-compact')).toBeNull();
  });
});

// #2289: the listener runs on a Mac with either tool and on Linux with Codex
// only. The compact page promises "One command in Terminal", so it opens only
// where that command will be shown.
describe('the compact page opens only where the command exists', () => {
  const realUserAgent = window.navigator.userAgent;
  const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
  afterEach(() => setUserAgent(realUserAgent));
  const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

  test('a Claude Code card opened on Linux gets the full page, not the promise of one command', async () => {
    setUserAgent(LINUX);
    renderAt(CARD);
    expect(await screen.findByTestId('byo-mode-byo')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('byo-card-compact')).toBeNull();
  });

  test('a Codex card opened on Linux is compact: the listener runs there', async () => {
    setUserAgent(LINUX);
    renderAt('/v2/agents/byo?pod=bbb222&name=lee-codex&from=card&adapter=codex');
    expect(await screen.findByTestId('byo-card-compact')).toBeInTheDocument();
  });

  test('on Windows no card is compact, Codex included', async () => {
    setUserAgent(WINDOWS);
    renderAt('/v2/agents/byo?pod=bbb222&name=lee-codex&from=card&adapter=codex');
    expect(await screen.findByTestId('byo-mode-byo')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-card-compact')).toBeNull();
  });
});

describe('the command page puts only what the paste needs above the copy', () => {
  test('the key-once line and what the command does come after the command', async () => {
    renderAt(CARD);
    const act = await screen.findByRole('button', { name: /get my connect command/i });
    await waitFor(() => expect(act).toBeEnabled());
    fireEvent.click(act);
    await screen.findByTestId('byo-listen');
    const command = Array.from(document.querySelectorAll('.v2-byo__pre'))
      .find((el) => /commonly agent run /.test(el.textContent || ''));
    const after = (el) => {
      // eslint-disable-next-line no-bitwise
      expect(command.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    };
    after(screen.getByTestId('byo-key-once'));
    after(screen.getByText(/This is what makes sam-claude answer @mentions/));
    // The page lead is behind them now: no eyebrow or description above the copy.
    expect(document.querySelector('.v2-feature__description')).toBeNull();
    expect(document.querySelector('.v2-feature__eyebrow')).toBeNull();
  });
});
