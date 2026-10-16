// @ts-nocheck
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

const issueToken = async () => {
  axios.get.mockResolvedValue({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
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
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
  await screen.findByText(/your connect command for/i);
};

describe('BYO listener snippet', () => {
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

  test('what it needs is said before the copy, and Codex users get a Codex command', async () => {
    await issueToken();
    expect(screen.getByTestId('byo-listen-needs'))
      .toHaveTextContent(/Node 18\+ with npm, and Claude Code installed and signed in/);
    fireEvent.click(screen.getByTestId('byo-listen-adapter-switch'));
    const pre = Array.from(document.querySelectorAll('.v2-byo__pre'))
      .find((el) => /commonly agent run /.test(el.textContent || ''));
    expect((pre.textContent || '').split('\n')[3]).toMatch(/ --adapter codex$/);
    expect(screen.getByTestId('byo-listen-needs')).toHaveTextContent(/the Codex CLI installed and signed in/);
    // The Claude Code MCP line is for Claude Code; it goes with the switch.
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

  // Windows (windows-latest runs, 2026-10-16): the listener needs WSL, and the
  // MCP command must be PowerShell lines that start the server through cmd /c.
  describe('setting up on Windows', () => {
    const realUserAgent = window.navigator.userAgent;
    const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
    afterEach(() => setUserAgent(realUserAgent));
    const mcpBox = () => screen.getByTestId('byo-mcp-claude').querySelector('.v2-byo__pre').textContent || '';

    test('a Windows browser is pointed at WSL for the listener, and gets PowerShell lines for the MCP connection', async () => {
      setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36');
      await issueToken();
      expect(screen.getByTestId('byo-setup-os-windows')).toHaveAttribute('aria-pressed', 'true');
      const needs = screen.getByTestId('byo-listen-needs');
      expect(needs).toHaveTextContent(/paste this into a WSL 2 \(Ubuntu\) terminal, not PowerShell/);
      expect(needs).toHaveTextContent(/sudo apt install bubblewrap/);
      // The listener itself runs in WSL, so it stays the bash lines.
      const listener = Array.from(document.querySelectorAll('.v2-byo__pre'))
        .find((el) => /commonly agent run /.test(el.textContent || ''));
      expect((listener.textContent || '').split('\n')[1]).toMatch(/^export COMMONLY_API_URL=/);
      const lines = mcpBox().split('\n');
      expect(lines).toEqual([
        'npm i -g @commonlyai/mcp',
        expect.stringMatching(/^claude mcp add commonly -e COMMONLY_API_URL=\S+ -e COMMONLY_AGENT_TOKEN=cm_agent_test_token -- cmd \/c commonly-mcp$/),
      ]);
      expect(mcpBox()).not.toContain('\\');
      expect(screen.getByTestId('byo-mcp-claude')).toHaveTextContent(/Paste both lines in PowerShell/);
    });

    test('the switch flips both boxes back to Mac or Linux', async () => {
      setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
      await issueToken();
      fireEvent.click(screen.getByTestId('byo-setup-os-unix'));
      expect(screen.getByTestId('byo-setup-os-unix')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('byo-listen-needs')).toHaveTextContent(/Before you paste \(Mac or Linux\)/);
      expect(screen.getByTestId('byo-listen-needs')).not.toHaveTextContent(/bubblewrap/);
      expect(mcpBox()).toMatch(/-- npx -y @commonlyai\/mcp$/);
    });

    test('a Mac browser starts on Mac or Linux', async () => {
      setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
      await issueToken();
      expect(screen.getByTestId('byo-setup-os-unix')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('byo-listen-needs')).not.toHaveTextContent(/WSL/);
    });

    test('Codex on Windows is pointed at WSL without the Claude Code bubblewrap line', async () => {
      setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
      await issueToken();
      fireEvent.click(screen.getByTestId('byo-listen-adapter-switch'));
      expect(screen.getByTestId('byo-listen-needs')).toHaveTextContent(/WSL 2 \(Ubuntu\)/);
      expect(screen.getByTestId('byo-listen-needs')).toHaveTextContent(/the Codex CLI installed and signed in/);
      expect(screen.getByTestId('byo-listen-needs')).not.toHaveTextContent(/bubblewrap/);
    });
  });
});
