// The connect command, built as a pure string for bash/zsh and for PowerShell
// (D245, #2141 part 1). PowerShell has no `export`, and its double-quoted
// strings treat ` as the escape and expand $, so the key is escaped without
// assuming anything about its alphabet.
import { connectSnippet, powerShellQuote } from '../components/V2AgentBYO';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

const base = {
  apiUrl: 'https://api.commonly.me',
  token: 'cm_agent_abc123',
  agentName: 'my-claude',
  adapter: 'claude' as const,
};

describe('connectSnippet', () => {
  test('macOS / Linux: the install line, two exports, the run line', () => {
    expect(connectSnippet({ ...base, os: 'unix' }).split('\n')).toEqual([
      'npm i -g @commonlyai/cli@latest',
      'export COMMONLY_API_URL=https://api.commonly.me',
      'export COMMONLY_AGENT_TOKEN=cm_agent_abc123',
      'commonly agent run my-claude --adapter claude',
    ]);
  });

  test('Windows: the same install line, $env: assignments in place of export, and --unsandboxed on the run line', () => {
    expect(connectSnippet({ ...base, os: 'windows' }).split('\n')).toEqual([
      'npm i -g @commonlyai/cli@latest',
      '$env:COMMONLY_API_URL="https://api.commonly.me"',
      '$env:COMMONLY_AGENT_TOKEN="cm_agent_abc123"',
      'commonly agent run my-claude --adapter claude --unsandboxed',
    ]);
    expect(connectSnippet({ ...base, os: 'windows' })).not.toMatch(/export /);
  });

  // Codex keeps its own permission profile, which --unsandboxed doesn't change,
  // so only Claude Code's Windows line carries the flag.
  test('--adapter and --allow ride on the run line; --unsandboxed comes last, for Claude Code on Windows only', () => {
    expect(connectSnippet({ ...base, os: 'unix', allow: 'write,web' }).split('\n')[3])
      .toBe('commonly agent run my-claude --adapter claude --allow write,web');
    expect(connectSnippet({ ...base, os: 'unix', adapter: 'codex' }).split('\n')[3])
      .toBe('commonly agent run my-claude --adapter codex');
    expect(connectSnippet({ ...base, os: 'unix' })).not.toContain('--unsandboxed');
    expect(connectSnippet({ ...base, os: 'windows', allow: 'write' }).split('\n')[3])
      .toBe('commonly agent run my-claude --adapter claude --allow write --unsandboxed');
    expect(connectSnippet({ ...base, os: 'windows', adapter: 'codex' }).split('\n')[3])
      .toBe('commonly agent run my-claude --adapter codex');
  });
});

describe('powerShellQuote', () => {
  test('a plain value is just wrapped in double quotes', () => {
    expect(powerShellQuote('cm_agent_abc123')).toBe('"cm_agent_abc123"');
  });

  test('backtick, double quote and $ each get a backtick', () => {
    expect(powerShellQuote('a`b"c$d')).toBe('"a``b`"c`$d"');
    expect(powerShellQuote('$(Remove-Item x)')).toBe('"`$(Remove-Item x)"');
    expect(powerShellQuote('$env:HOME')).toBe('"`$env:HOME"');
  });

  test('the typographic quotes PowerShell also reads as a double quote are escaped', () => {
    expect(powerShellQuote('a“b”c„d')).toBe('"a`“b`”c`„d"');
  });

  test('a single quote, backslash and other symbols pass through unchanged', () => {
    expect(powerShellQuote("a'b\\c%d&e;f|g")).toBe('"a\'b\\c%d&e;f|g"');
  });

  test('the escaped token lands in the Windows snippet', () => {
    expect(connectSnippet({ ...base, os: 'windows', token: 'cm_$x`"y' }).split('\n')[2])
      .toBe('$env:COMMONLY_AGENT_TOKEN="cm_`$x```"y"');
  });
});
