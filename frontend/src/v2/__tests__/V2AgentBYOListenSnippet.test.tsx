// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// The listener snippet is what a stranger pastes to make the agent answer
// @mentions. Every line of it has to execute: the CLI-install line was a shell
// comment until 2026-10-09, so a whole-snippet paste on a machine without the
// CLI skipped the install and failed on the last line with "command not found"
// (the #887 class the snippet was moved here to prevent).
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const issueToken = async (runner?: 'codex', pod = {}) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', ...pod }] });
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
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  if (runner) fireEvent.click(screen.getByTestId(`byo-runner-${runner}`));
  // The runner sets the default name, which re-checks it, so wait for the button again.
  if (runner) await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
  await screen.findByText(/your connect command for/i);
};

describe('BYO listener snippet', () => {
  test('connect commands use the configured staging API instead of production', async () => {
    const previousApiUrl = process.env.REACT_APP_API_URL;
    process.env.REACT_APP_API_URL = 'https://api-staging.commonly.me/';
    try {
      await issueToken();
      const commands = Array.from(document.querySelectorAll('.v2-byo__pre'))
        .map((el) => el.textContent || '')
        .filter((text) => text.includes('COMMONLY_API_URL='));
      expect(commands).toHaveLength(2);
      commands.forEach((command) => {
        expect(command).toContain('COMMONLY_API_URL=https://api-staging.commonly.me');
        expect(command).not.toContain('api.commonly.me');
      });
      const cursorConfig = Array.from(document.querySelectorAll('.v2-byo__pre'))
        .map((el) => el.textContent || '')
        .find((text) => text.includes('mcpServers'));
      expect(JSON.parse(cursorConfig || '').mcpServers.commonly.env.COMMONLY_API_URL)
        .toBe('https://api-staging.commonly.me');
    } finally {
      if (previousApiUrl === undefined) delete process.env.REACT_APP_API_URL;
      else process.env.REACT_APP_API_URL = previousApiUrl;
    }
  });

  test('the Cursor install link uses this instance without putting the issued key in its URL', async () => {
    const previousApiUrl = process.env.REACT_APP_API_URL;
    process.env.REACT_APP_API_URL = 'https://api.example.test/';
    try {
      await issueToken();
      const href = screen.getByRole('link', { name: 'Add to Cursor', hidden: true }).getAttribute('href') || '';
      const config = JSON.parse(atob(decodeURIComponent(href.split('config=')[1])));
      expect(config.env).toEqual({
        COMMONLY_API_URL: 'https://api.example.test',
        COMMONLY_AGENT_TOKEN: 'PASTE_AGENT_TOKEN_HERE',
      });
      expect(href).not.toContain('cm_agent_test_token');
      expect(href).not.toContain('api.commonly.me');
    } finally {
      if (previousApiUrl === undefined) delete process.env.REACT_APP_API_URL;
      else process.env.REACT_APP_API_URL = previousApiUrl;
    }
  });

  test('the Cursor link leads its guidance, while the JSON still names its destination', async () => {
    await issueToken();
    const link = screen.getByRole('link', { name: 'Add to Cursor', hidden: true });
    const hint = link.nextElementSibling;
    expect(hint).toHaveClass('v2-byo__hint');
    expect(hint).toHaveTextContent('The link adds Commonly with a placeholder key.');
    expect(link.closest('.v2-byo__snippet')).toHaveTextContent('~/.cursor/mcp.json');
  });

  // QA BYO walk 1 (2026-10-16): four equal Copy boxes, and the one titled
  // "Claude Code" was the MCP line, which does not make the agent answer. The
  // command that does is THE box: first, and the only one not marked optional
  // or folded away.
  test('the connect command is the first box; the MCP line is optional; the bare key is folded away', async () => {
    await issueToken();
    const pres = Array.from(document.querySelectorAll('.v2-byo__pre')).map((el) => el.textContent || '');
    const listener = pres.findIndex((txt) => /commonly agent run /.test(txt));
    const claudeMcp = pres.findIndex((txt) => /claude mcp add commonly/.test(txt));
    expect(listener).toBe(0);
    expect(claudeMcp).toBeGreaterThan(listener);
    expect(screen.getByTestId('byo-mcp-claude')).toHaveTextContent(/^Optional:/);
    const more = screen.getByTestId('byo-result-more-ways');
    expect(Array.from(more.querySelectorAll('.v2-byo__pre')).map((el) => el.textContent))
      .toContain('cm_agent_test_token');
  });

  // sprint-review on #2287: one test carried four properties, so a break named
  // the wrong one. One property per test.
  const listenCommand = () => Array.from(document.querySelectorAll('.v2-byo__pre'))
    .find((el) => /commonly agent run /.test(el.textContent || ''));

  test('what it needs is said before the command it is about', async () => {
    await issueToken();
    const needs = screen.getByTestId('byo-listen-needs');
    expect(needs).toHaveTextContent(new RegExp(`Needs Node ${CLI_NODE_FLOOR}\\+ with npm and Claude Code signed in`));
    // eslint-disable-next-line no-bitwise
    expect(needs.compareDocumentPosition(listenCommand()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The page renders in English here, so the English test above never reads the
  // zh-CN copy. Read the zh-CN string straight from the locale file.
  test('the zh-CN "needs" line names the same Node floor', () => {
    const zhNeeds: string = require('../../i18n/locales/zh-CN.json').agentByo.listen.needs;
    expect(zhNeeds).toMatch(new RegExp(`需要 Node ${CLI_NODE_FLOOR}\\+`));
  });

  test('an npm EACCES names the fix and says not to use sudo, right after the command', async () => {
    await issueToken();
    const hint = screen.getByTestId('byo-listen-npm-hint');
    expect(hint).toHaveTextContent(/npm stops with EACCES/);
    expect(hint).toHaveTextContent(/don’t add sudo/);
    // eslint-disable-next-line no-bitwise
    expect(listenCommand().compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('picking Codex before the install gives a Codex command named for Codex, and no runner switch after issue', async () => {
    await issueToken('codex');
    expect((listenCommand().textContent || '').split('\n')[3]).toMatch(/^commonly agent run sam-codex --adapter codex$/);
    expect(screen.getByTestId('byo-listen-needs')).toHaveTextContent(/the Codex CLI signed in/);
    expect(screen.queryByTestId('byo-runner')).toBeNull();
  });

  test('issue as Claude, go back, pick Codex, issue again: the second install is <user>-codex on --adapter codex', async () => {
    await issueToken();
    expect(axios.post.mock.calls.find(([url]) => url === '/api/registry/install')[1].agentName).toBe('sam-claude');
    fireEvent.click(screen.getByTestId('byo-use-different-runner'));
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token_codex' } });
    fireEvent.click(screen.getByTestId('byo-runner-codex'));
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    await screen.findByText(/your connect command for/i);
    const installs = axios.post.mock.calls.filter(([url]) => url === '/api/registry/install');
    expect(installs[installs.length - 1][1].agentName).toBe('sam-codex');
    expect((listenCommand().textContent || '').split('\n')[3]).toMatch(/^commonly agent run sam-codex --adapter codex$/);
  });

  test('after issue, the way back returns to the start and leaves the install alone', async () => {
    await issueToken();
    const postsBefore = axios.post.mock.calls.length;
    fireEvent.click(screen.getByTestId('byo-use-different-runner'));
    expect(screen.getByTestId('byo-runner-claude')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-needs')).toBeNull();
    expect(axios.post.mock.calls.length).toBe(postsBefore);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  test('a Claude Code listener says what it can reach and how --allow widens it; Codex gets its own note only', async () => {
    await issueToken();
    const reach = screen.getByTestId('byo-listen-reach');
    expect(screen.queryByTestId('byo-listen-reach-codex')).toBeNull();
    expect(reach).toHaveTextContent(/By default, on macOS, when every pod it's in is private, invite-only and not listed in Community, .+ reads only the folder you run this from\. Otherwise, or when you run it from your home folder, it works in its own scratch folder\./);
    // The folder bound is the default only: write's commands read past it.
    expect(reach).toHaveTextContent(/add --allow write to the last line\. Those commands can read beyond the folder\./);
    expect(reach).toHaveTextContent(/To let it fetch web pages, add --allow web\./);
    expect(reach).toHaveTextContent(/send what it reads off this computer/);
  });

  test('a Codex listener shows no Claude folder note', async () => {
    await issueToken('codex');
    expect(screen.queryByTestId('byo-listen-reach')).toBeNull();
    // Codex gets its own note: it runs in its scratch folder, and --allow is refused for it.
    expect(screen.getByTestId('byo-listen-reach-codex')).toHaveTextContent(/its own scratch folder under your temp directory/);
    expect(screen.getByTestId('byo-listen-reach-codex')).toHaveTextContent(/--allow does not apply to Codex/);
  });

  test('the Claude Code MCP line shows for Claude Code only', async () => {
    await issueToken();
    expect(screen.getByTestId('byo-mcp-claude')).toBeInTheDocument();
  });

  test('a Codex install shows no Claude Code MCP line', async () => {
    await issueToken('codex');
    expect(screen.queryByTestId('byo-mcp-claude')).toBeNull();
  });

  test('every line executes: the CLI install is a command, not a comment, and the run line is last', async () => {
    await issueToken();
    // Several <pre class="v2-byo__pre"> render on the issued screen (the token,
    // the MCP add command, the Cursor config, the listener); pick the listener.
    const pre = Array.from(document.querySelectorAll('.v2-byo__pre'))
      .find((el) => /commonly agent run /.test(el.textContent || ''));
    expect(pre).toBeDefined();
    const lines = (pre.textContent || '').split('\n');
    expect(lines).toHaveLength(4);
    // The install line must run when the whole snippet is pasted, in stock
    // interactive zsh too: no trailing comment, since zsh passes it to npm as
    // arguments unless `interactivecomments` is set (off by default on macOS).
    expect(lines[0]).toBe('npm i -g @commonlyai/cli@latest');
    expect(pre.textContent).not.toContain('#');
    expect(lines[1]).toMatch(/^export COMMONLY_API_URL=/);
    expect(lines[2]).toBe('export COMMONLY_AGENT_TOKEN=cm_agent_test_token');
    // The command names its tool, so a missing Claude Code is an error, not a
    // quiet switch to Codex (QA BYO walk 1).
    expect(lines[3]).toMatch(/^commonly agent run \S+ --adapter claude$/);
    // No line in the snippet is a bare comment.
    expect(lines.filter((l) => l.trimStart().startsWith('#'))).toHaveLength(0);
  });

  // Where the listener runs: Mac with either CLI, Linux with Codex, and Linux
  // with Claude Code in an invite-only pod (TASK-027: the CLI refuses a public
  // Claude Code seat under bubblewrap). Native Windows has no sandbox; there
  // the page says so and offers MCP and hosted. The Windows MCP command is
  // PowerShell lines through cmd /c (windows-latest).
  describe('where the listener runs', () => {
    const realUserAgent = window.navigator.userAgent;
    const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
    afterEach(() => setUserAgent(realUserAgent));
    const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
    const listener = () => Array.from(document.querySelectorAll('.v2-byo__pre'))
      .find((el) => /commonly agent run /.test(el.textContent || ''));
    const mcpBox = () => screen.getByTestId('byo-mcp-claude').querySelector('.v2-byo__pre').textContent || '';

    // jsdom puts its host's process.platform in the user agent, lower case. On
    // a Linux CI host that reads "(linux)", which must not flip the page; only
    // a browser's own spellings (X11, Linux x86_64, CrOS) mean Linux. Pinned
    // here so it holds on any host (sprint-review on #2289).
    test('jsdom\'s lower-case "(linux)" user agent is not a Linux browser: the page starts on Mac', async () => {
      setUserAgent('Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/20.0.3');
      await issueToken();
      expect(screen.getByTestId('byo-setup-os-mac')).toHaveAttribute('aria-pressed', 'true');
      expect(listener()).toBeDefined();
    });

    test('a Mac browser starts on Mac with the listener command', async () => {
      setUserAgent(MAC);
      await issueToken();
      expect(screen.getByTestId('byo-setup-os-mac')).toHaveAttribute('aria-pressed', 'true');
      expect(listener()).toBeDefined();
      expect(screen.getByTestId('byo-listen-needs')).toBeInTheDocument();
      expect(mcpBox()).toMatch(/-- npx -y @commonlyai\/mcp$/);
    });

    test('Windows: no listener command, the reason and both ways forward, and the PowerShell MCP lines', async () => {
      setUserAgent(WINDOWS);
      await issueToken();
      expect(screen.getByTestId('byo-setup-os-windows')).toHaveAttribute('aria-pressed', 'true');
      expect(listener()).toBeUndefined();
      expect(screen.queryByTestId('byo-listen-waiting')).toBeNull();
      expect(screen.queryByTestId('byo-cta-warning')).toBeNull();
      const notice = screen.getByTestId('byo-listen-unavailable');
      expect(notice).toHaveTextContent(/Claude Code can’t answer @mentions from Windows yet/);
      expect(notice).toHaveTextContent(/with the command below, or choose “Run it here”/);
      expect(notice).not.toHaveTextContent(/WSL/);
      expect(screen.queryByTestId('byo-listen-npm-hint')).toBeNull();
      expect(mcpBox().split('\n')).toEqual([
        'npm i -g @commonlyai/mcp',
        expect.stringMatching(/^claude mcp add commonly -e COMMONLY_API_URL=\S+ -e COMMONLY_AGENT_TOKEN=cm_agent_test_token -- cmd \/c commonly-mcp$/),
      ]);
      expect(screen.getByTestId('byo-mcp-claude')).toHaveTextContent(/Paste both lines in PowerShell/);
      // Here it is the way in: no "Optional", and no "command above" to point at.
      expect(screen.getByTestId('byo-mcp-claude')).toHaveTextContent(/^Let Claude Code use the pod in your own sessions/);
      expect(screen.getByTestId('byo-mcp-claude')).not.toHaveTextContent(/command above/);
    });

    test('Linux with Claude Code: no listener command, and the bash MCP command', async () => {
      setUserAgent(LINUX);
      await issueToken();
      expect(screen.getByTestId('byo-setup-os-linux')).toHaveAttribute('aria-pressed', 'true');
      expect(listener()).toBeUndefined();
      expect(screen.queryByTestId('byo-listen-reach')).toBeNull();
      expect(screen.getByTestId('byo-listen-unavailable'))
        .toHaveTextContent(/On Linux, Claude Code answers @mentions only in an invite-only pod, and this one isn’t/);
      expect(screen.queryByTestId('byo-listen-npm-hint')).toBeNull();
      expect(mcpBox()).toMatch(/-- npx -y @commonlyai\/mcp$/);
      expect(screen.getByTestId('byo-mcp-claude')).not.toHaveTextContent(/command above|Optional/);
    });

    test('Linux with Codex: no listener command, and Codex says it is not tested yet', async () => {
      setUserAgent(LINUX);
      await issueToken('codex');
      expect(listener()).toBeUndefined();
      expect(screen.getByTestId('byo-listen-unavailable')).toHaveTextContent(/The Codex CLI can’t answer @mentions from Linux yet\. .*Linux is not tested yet\./);
      expect(screen.queryByTestId('byo-listen-npm-hint')).toBeNull();
      expect(screen.queryByTestId('byo-listen-reach-codex')).toBeNull();
    });

    const PRIVATE_POD = { joinPolicy: 'invite-only', publicRead: false, communityListed: false };

    test('Linux with Claude Code in an invite-only pod: the listener command and the Linux reach note', async () => {
      setUserAgent(LINUX);
      await issueToken(undefined, PRIVATE_POD);
      expect(screen.getByTestId('byo-setup-os-linux')).toHaveAttribute('aria-pressed', 'true');
      expect((listener()?.textContent || '').split('\n')[3]).toMatch(/ --adapter claude$/);
      expect(screen.queryByTestId('byo-listen-unavailable')).toBeNull();
      expect(screen.getByTestId('byo-listen-reach')).toHaveTextContent(/^On Linux, .* answers only while every pod it's in is private, invite-only/);
      expect(screen.getByTestId('byo-listen-reach')).toHaveTextContent(/bubblewrap \(bwrap\)/);
    });

    test('Linux with Claude Code: the folder and bubblewrap requirement sits beside the command', async () => {
      setUserAgent(LINUX);
      await issueToken(undefined, PRIVATE_POD);
      expect(screen.getByTestId('byo-listen-needs'))
        .toHaveTextContent(/On Linux, open the window in your project folder first, with bubblewrap \(bwrap\) installed: run from your home folder, it won’t start\./);
    });

    test('Mac with Claude Code: no Linux folder note', async () => {
      setUserAgent(MAC);
      await issueToken(undefined, PRIVATE_POD);
      expect(screen.getByTestId('byo-listen-needs')).not.toHaveTextContent(/On Linux/);
    });

    // #2783: Codex stays Mac only, even in a pod the Claude Code check accepts.
    test('Linux with Codex in an invite-only pod: still no listener command', async () => {
      setUserAgent(LINUX);
      await issueToken('codex', PRIVATE_POD);
      expect(listener()).toBeUndefined();
      expect(screen.getByTestId('byo-listen-unavailable')).toHaveTextContent(/The Codex CLI can’t answer @mentions from Linux yet/);
    });

    test('Linux with Claude Code in a pod that is not private: the footnote names the pod rule, not the computer', async () => {
      setUserAgent(LINUX);
      axios.get.mockImplementation((url) => {
        if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', joinPolicy: 'open', publicRead: false, communityListed: false }] });
        if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
        return Promise.resolve({ data: {} });
      });
      render(
        <AuthContext.Provider value={authValue}>
          <MemoryRouter>
            <V2AgentBYO />
          </MemoryRouter>
        </AuthContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
      expect(screen.getByText(/On Linux, Claude Code answers @mentions only when every pod it’s in is invite-only/)).toBeInTheDocument();
      expect(screen.queryByText(/run the listener on a supported computer/)).toBeNull();
    });

    // The CLI treats a pod that does not report a flag as public, so the page
    // must not offer a listener the CLI would refuse.
    test.each([
      ['open to join', { ...PRIVATE_POD, joinPolicy: 'open' }],
      ['listed in Community', { ...PRIVATE_POD, communityListed: true }],
      ['publicRead not reported', { joinPolicy: 'invite-only', communityListed: false }],
      ['communityListed not reported', { joinPolicy: 'invite-only', publicRead: false }],
      // The CLI treats a missing joinPolicy as open.
      ['joinPolicy not reported', { publicRead: false, communityListed: false }],
    ])('Linux with Claude Code in a pod %s: no listener command', async (_label, pod) => {
      setUserAgent(LINUX);
      await issueToken(undefined, pod);
      expect(listener()).toBeUndefined();
      expect(screen.getByTestId('byo-listen-unavailable')).toHaveTextContent(/under “Who can join” in pod settings/);
    });

    test('Mac with Claude Code keeps the macOS reach note', async () => {
      setUserAgent(MAC);
      await issueToken(undefined, PRIVATE_POD);
      expect(screen.getByTestId('byo-listen-reach')).toHaveTextContent(/^By default, on macOS/);
    });

    test('Codex on Windows says so, and offers hosted or another machine', async () => {
      setUserAgent(WINDOWS);
      await issueToken('codex');
      expect(listener()).toBeUndefined();
      expect(screen.getByTestId('byo-listen-unavailable'))
        .toHaveTextContent(/The Codex CLI can’t answer @mentions from Windows yet\. Choose “Run it here”/);
      expect(screen.queryByTestId('byo-listen-npm-hint')).toBeNull();
      expect(screen.queryByTestId('byo-listen-reach-codex')).toBeNull();
      expect(screen.queryByTestId('byo-mcp-claude')).toBeNull();
    });

    test('the switch overrides the browser: Windows to Mac brings the listener back', async () => {
      setUserAgent(WINDOWS);
      await issueToken();
      fireEvent.click(screen.getByTestId('byo-setup-os-mac'));
      expect(screen.getByTestId('byo-setup-os-mac')).toHaveAttribute('aria-pressed', 'true');
      expect(listener()).toBeDefined();
      expect(screen.queryByTestId('byo-listen-unavailable')).toBeNull();
      expect(mcpBox()).toMatch(/-- npx -y @commonlyai\/mcp$/);
    });
  });
});

// TASK-705: "Work in my repo" only ever adds a folder step and the two existing
// opt-ins to the same command. It has no path that skips the sandbox.
describe('BYO listener: Work in my repo', () => {
  const PRIVATE_POD = { joinPolicy: 'invite-only', publicRead: false, communityListed: false };
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  const runLine = () => Array.from(document.querySelectorAll('.v2-byo__pre'))
    .map((el) => el.textContent || '')
    .find((txt) => /commonly agent run /.test(txt));

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', { value: MAC_UA, configurable: true });
  });

  test('off by default: the command is unchanged and carries no --allow', async () => {
    await issueToken(undefined, PRIVATE_POD);
    expect(screen.getByTestId('byo-repo-toggle')).not.toBeChecked();
    expect(runLine()).not.toMatch(/--allow|cd ~/);
  });

  test('choosing it adds the folder step, and write/web add only their own --allow', async () => {
    await issueToken(undefined, PRIVATE_POD);
    fireEvent.click(screen.getByTestId('byo-repo-toggle'));
    expect(runLine()).toMatch(/\ncd ~\/path\/to\/your-repo && commonly agent run \S+ --adapter claude$/);
    fireEvent.click(screen.getByTestId('byo-repo-write'));
    expect(runLine()).toMatch(/--adapter claude --allow write$/);
    fireEvent.click(screen.getByTestId('byo-repo-web'));
    expect(runLine()).toMatch(/--adapter claude --allow write,web$/);
    expect(runLine()).not.toMatch(/dangerously|skip-permissions/);
  });

  test('not offered in a pod that is not confirmed private', async () => {
    await issueToken(undefined, { joinPolicy: 'open', publicRead: false, communityListed: false });
    expect(screen.queryByTestId('byo-repo-choice')).toBeNull();
    expect(runLine()).not.toMatch(/--allow/);
  });

  test('not offered for Codex, where --allow does not apply', async () => {
    await issueToken('codex', PRIVATE_POD);
    expect(screen.queryByTestId('byo-repo-choice')).toBeNull();
    expect(runLine()).not.toMatch(/--allow/);
  });
});
