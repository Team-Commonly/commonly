// @ts-nocheck
// D247: the add page offers every harness `commonly agent run --adapter`
// accepts, lets the person pick model and effort, and says plainly what works
// for each one. Claude Code and Codex keep their listener command; OpenCode
// gets its own Mac lines; the rest say what can answer instead.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO, { opencodeKeySnippet, opencodeSnippet } from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../components/V2NavRail', () => () => null);
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
  currentUser: { _id: 'u1', username: 'sam' }, user: { _id: 'u1', username: 'sam' },
  token: 'user-jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};
const ladder = ['low', 'medium', 'high', 'xhigh', 'max'];
const CATALOG = [
  { id: 'claude', label: 'Claude Code', models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], efforts: ladder },
  { id: 'codex', label: 'Codex', models: ['gpt-6.1-sol', 'gpt-6-sol'], efforts: ladder },
  { id: 'opencode', label: 'OpenCode', models: null, efforts: [] },
  { id: 'qwen', label: 'Qwen Code', models: null, efforts: [] },
  { id: 'goose', label: 'Goose', models: null, efforts: [] },
  { id: 'hermes', label: 'Hermes', models: null, efforts: [] },
  { id: 'pi', label: 'pi', models: null, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'dsh', label: 'DeepSeek Harness', models: null, efforts: ladder },
];
const INSTALL_BUTTON = /get my connect command/i;

const renderPage = async () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
    if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: false, caps: { agentsPerUser: 3, turnsPerDay: 20 } } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    if (url === '/api/registry/harness-catalog') return Promise.resolve({ data: { harnesses: CATALOG } });
    return Promise.resolve({ data: {} });
  });
  render(<AuthContext.Provider value={authValue}><MemoryRouter><V2AgentBYO /></MemoryRouter></AuthContext.Provider>);
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('byo-runner-dsh')).toBeInTheDocument());
};

afterEach(() => { jest.clearAllMocks(); axios.get.mockReset(); axios.post.mockReset(); });

describe('every harness on the add page', () => {
  test('the runner choice lists every harness, Claude Code and Codex first, with no tested marks', async () => {
    await renderPage();
    const runners = Array.from(screen.getByTestId('byo-runner').querySelectorAll('button')).map((b) => b.textContent);
    expect(runners).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Qwen Code', 'Goose', 'Hermes', 'pi', 'DeepSeek Harness']);
    expect(document.body.textContent).not.toMatch(/Tested on a Mac|Not tested yet/);
  });

  test('Codex: the picked model and effort are saved with the agent', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('byo-runner-codex'));
    await waitFor(() => expect(screen.getByRole('button', { name: INSTALL_BUTTON })).toBeEnabled());
    fireEvent.change(screen.getByTestId('byo-model-select'), { target: { value: 'gpt-6.1-sol' } });
    fireEvent.change(screen.getByTestId('byo-effort-select'), { target: { value: 'high' } });
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } });
    fireEvent.click(screen.getByRole('button', { name: INSTALL_BUTTON }));
    await screen.findByText(/your connect command for/i);
    expect(axios.post.mock.calls[0][0]).toBe('/api/registry/install');
    expect(axios.post.mock.calls[0][1].config.runtime).toEqual({
      runtimeType: 'webhook', adapter: 'codex', model: 'gpt-6.1-sol', effort: 'high',
    });
    // The listener line itself is unchanged.
    expect(document.body.textContent).toContain('commonly agent run sam-codex --adapter codex');
  });

  test('OpenCode on a Mac shows its own lines, pinned, and creates nothing from the page', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('byo-runner-opencode'));
    await waitFor(() => expect(screen.getByTestId('byo-opencode-lines')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: INSTALL_BUTTON })).toBeNull();
    expect(screen.getByTestId('byo-opencode-key').textContent).toBe(
      "(umask 077; mkdir -p ~/.config/commonly; printf 'Anthropic API key: '; stty -echo; IFS= read -r KEY; stty echo; echo;"
      + " printf '%s' \"$KEY\" > ~/.config/commonly/anthropic-key)",
    );
    expect(screen.getByTestId('byo-opencode-lines').textContent).toBe([
      'npm i -g @commonlyai/cli@latest opencode-ai',
      'commonly login',
      'cat > ~/.config/commonly/sam-opencode.json <<EOF',
      '{"provider":{"id":"anthropic-compat","baseURL":"https://api.anthropic.com/v1","keyFile":"$HOME/.config/commonly/anthropic-key"},"model":"claude-haiku-5-5","sandbox":{"trust":"public"}}',
      'EOF',
      'commonly agent attach opencode --pod p1 --name sam-opencode --env ~/.config/commonly/sam-opencode.json',
      'commonly agent run sam-opencode',
    ].join('\n'));
    fireEvent.change(screen.getByTestId('byo-model-select'), { target: { value: 'claude-sonnet-5-5' } });
    expect(screen.getByTestId('byo-opencode-lines').textContent).toContain('"model":"claude-sonnet-5-5"');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('an OpenCode model id that could break the file falls back to the walked default', () => {
    expect(opencodeSnippet({ agentName: 'a', podId: 'p', model: 'x","sandbox":{}' })).toContain('"model":"claude-haiku-5-5"');
    expect(opencodeKeySnippet()).not.toContain('pbpaste');
  });

  test.each([
    ['qwen', 'Qwen Code works as a public agent, but it’s set up from Terminal, not from this page yet. Claude Code, Codex or OpenCode can answer from here, or choose “Run it here”.'],
    ['dsh', 'DeepSeek Harness runs only as a private agent you set up from Terminal, and agents added here are public. Claude Code, Codex or OpenCode can answer from here, or choose “Run it here”.'],
    ['pi', 'pi can’t answer as a public agent yet, and agents added here are public. Claude Code, Codex or OpenCode can, or choose “Run it here”.'],
    ['goose', 'Goose 1.56 isn’t supported in open pods yet. Goose 1.54 works, but it’s set up from Terminal, not from this page yet. Claude Code, Codex or OpenCode can answer from here, or choose “Run it here”.'],
  ])('%s says in plain words what works instead, with no install button', async (runner, line) => {
    await renderPage();
    fireEvent.click(screen.getByTestId(`byo-runner-${runner}`));
    expect(screen.getByTestId('byo-runner-refused')).toHaveTextContent(line);
    expect(screen.getByTestId('byo-runner-refused').textContent).not.toMatch(/--|sandbox|trust|Error/);
    expect(screen.queryByRole('button', { name: INSTALL_BUTTON })).toBeNull();
  });
});

// F175a: a harness that can't be sandboxed says so, plainly, instead of the
// page leaving connectors unmentioned.
describe('the connector line for a harness with no sandbox', () => {
  const asBrowser = (userAgent) => jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36';
  const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  afterEach(async () => {
    jest.restoreAllMocks();
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test.each([
    ['dsh', 'Connectors need a sandboxed harness. DeepSeek Harness runs without a sandbox, so it can’t use connectors.'],
    ['hermes', 'Connectors need a sandboxed harness. Hermes runs without a sandbox, so it can’t use connectors.'],
  ])('%s gets the line on any computer', async (runner, line) => {
    asBrowser(MAC);
    await renderPage();
    fireEvent.click(screen.getByTestId(`byo-runner-${runner}`));
    expect(screen.getByTestId('byo-no-connectors')).toHaveTextContent(line);
  });

  // F175c: pi holds a grant as a public agent on a Mac, and has no sandbox on
  // Linux, so its line follows the computer.
  test.each([
    [MAC, 'pi can use connectors only as a public agent on a Mac.'],
    [LINUX, 'Connectors need a sandboxed harness. pi runs without a sandbox, so it can’t use connectors.'],
  ])('pi says when it can use connectors (%s)', async (ua, line) => {
    asBrowser(ua);
    await renderPage();
    fireEvent.click(screen.getByTestId('byo-runner-pi'));
    expect(screen.getByTestId('byo-no-connectors')).toHaveTextContent(line);
  });

  test.each([MAC, LINUX])('Goose and Qwen say connectors need a public agent, on any computer (%s)', async (ua) => {
    asBrowser(ua);
    await renderPage();
    for (const [runner, line] of [
      ['goose', 'Goose can use connectors only as a public agent.'],
      ['qwen', 'Qwen Code can use connectors only as a public agent, on version 0.26.2.'],
    ]) {
      fireEvent.click(screen.getByTestId(`byo-runner-${runner}`));
      expect(screen.getByTestId('byo-no-connectors')).toHaveTextContent(line);
    }
  });

  test('reverse: every harness that can hold a grant gets no line', async () => {
    asBrowser(MAC);
    await renderPage();
    for (const runner of ['claude', 'codex', 'opencode']) {
      fireEvent.click(screen.getByTestId(`byo-runner-${runner}`));
      expect(screen.queryByTestId('byo-no-connectors')).toBeNull();
    }
  });

  // CodeRabbit (#3487): on native Windows the CLI gives no seat a grant
  // broker, Claude Code and Codex included, so the page says so there.
  test('on Windows, Claude Code and Codex say connectors don\'t work there yet; not on a Mac', async () => {
    asBrowser(WINDOWS);
    await renderPage();
    for (const runner of ['claude', 'codex']) {
      fireEvent.click(screen.getByTestId(`byo-runner-${runner}`));
      expect(screen.getByTestId('byo-no-connectors')).toHaveTextContent('Connectors don’t work on Windows yet.');
    }
    fireEvent.click(screen.getByTestId('byo-runner-goose'));
    expect(screen.getByTestId('byo-no-connectors')).toHaveTextContent('Connectors don’t work on Windows yet.');
    fireEvent.click(screen.getByTestId('byo-runner-hermes'));
    expect(screen.getByTestId('byo-no-connectors')).toHaveTextContent('Hermes runs without a sandbox');
  });

  test('reads in Chinese under zh-CN', async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    asBrowser(LINUX);
    await renderPage();
    fireEvent.click(screen.getByTestId('byo-runner-hermes'));
    expect(screen.getByTestId('byo-no-connectors')).toHaveTextContent('连接器需要带沙箱的运行器。Hermes 运行时没有沙箱，所以用不了连接器。');
    fireEvent.click(screen.getByTestId('byo-runner-pi'));
    expect(screen.getByTestId('byo-no-connectors')).toHaveTextContent('连接器需要带沙箱的运行器。pi 运行时没有沙箱，所以用不了连接器。');
    fireEvent.click(screen.getByTestId('byo-runner-goose'));
    expect(screen.getByTestId('byo-no-connectors')).toHaveTextContent('Goose 只有作为公开智能体时才能用连接器。');
  });
});
