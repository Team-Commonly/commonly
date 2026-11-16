// The connect command, built as a pure string for bash/zsh and for PowerShell
// (#2141 part 1). PowerShell has no `export`, and its double-quoted
// strings treat ` as the escape and expand $, so the key is escaped without
// assuming anything about its alphabet.
import { checkedInSinceIssue, connectSnippet, powerShellQuote } from '../components/V2AgentBYO';

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

  // npm.cmd and commonly.cmd, not the .ps1 shims a bare name resolves to:
  // Windows 11's default script policy refuses those (F342).
  test('Windows: the .cmd shims, $env: assignments in place of export, and --unsandboxed on the run line', () => {
    expect(connectSnippet({ ...base, os: 'windows' }).split('\n')).toEqual([
      'npm.cmd i -g @commonlyai/cli@latest',
      '$env:COMMONLY_API_URL="https://api.commonly.me"',
      '$env:COMMONLY_AGENT_TOKEN="cm_agent_abc123"',
      'commonly.cmd agent run my-claude --adapter claude --unsandboxed',
    ]);
    expect(connectSnippet({ ...base, os: 'windows' })).not.toMatch(/export /);
  });

  // Both Windows lines carry the flag. The page offers Codex's only in an
  // invite-only pod (V2AgentBYOListenSnippet), and the CLI refuses any other.
  test('--adapter and --allow ride on the run line; --unsandboxed comes last, on Windows only', () => {
    expect(connectSnippet({ ...base, os: 'unix', allow: 'write,web' }).split('\n')[3])
      .toBe('commonly agent run my-claude --adapter claude --allow write,web');
    expect(connectSnippet({ ...base, os: 'unix', adapter: 'codex' }).split('\n')[3])
      .toBe('commonly agent run my-claude --adapter codex');
    expect(connectSnippet({ ...base, os: 'unix' })).not.toContain('--unsandboxed');
    expect(connectSnippet({ ...base, os: 'windows', allow: 'write' }).split('\n')[3])
      .toBe('commonly.cmd agent run my-claude --adapter claude --allow write --unsandboxed');
    expect(connectSnippet({ ...base, os: 'windows', adapter: 'codex' }).split('\n')[3])
      .toBe('commonly.cmd agent run my-claude --adapter codex --unsandboxed');
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

describe('connectSnippet for a second instance (F306 part 2)', () => {
  test('the run line names the instance, on both systems', () => {
    expect(connectSnippet({ ...base, os: 'unix', instanceId: 'nova' }).split('\n').at(-1))
      .toBe('commonly agent run my-claude --instance-id nova --adapter claude');
    expect(connectSnippet({ ...base, os: 'windows', instanceId: 'nova' }).split('\n').at(-1))
      .toBe('commonly.cmd agent run my-claude --instance-id nova --adapter claude --unsandboxed');
  });

  test('the default instance, no instance, or an id the CLI would refuse adds nothing', () => {
    for (const instanceId of [undefined, null, 'default', 'has space', 'a;rm -rf', 'x'.repeat(65)]) {
      expect(connectSnippet({ ...base, os: 'unix', instanceId }).split('\n').at(-1))
        .toBe('commonly agent run my-claude --adapter claude');
    }
  });
});

describe('connectSnippet with a connect code: one line, no key', () => {
  const CODE = 'cmc_AbCdEfGhIjKlMnOpQr_-1z';
  test('on a Mac or Linux it installs, then runs with the code, joined by &&', () => {
    const line = connectSnippet({ ...base, os: 'unix', connectCode: CODE.slice(0, 26) });
    expect(line).not.toContain('\n');
    expect(line).toBe(`npm i -g @commonlyai/cli@latest && commonly agent run my-claude --adapter claude --api-url ${base.apiUrl} --connect ${CODE.slice(0, 26)}`);
  });
  test('on Windows PowerShell 5.1, which has no &&, the run waits on the install with if ($?)', () => {
    const code = CODE.slice(0, 26);
    expect(connectSnippet({ ...base, os: 'windows', connectCode: code, instanceId: 'nova', allow: 'write' }))
      .toBe(`npm.cmd i -g @commonlyai/cli@latest; if ($?) { commonly.cmd agent run my-claude --instance-id nova --adapter claude --allow write --api-url "${base.apiUrl}" --connect "${code}" --unsandboxed }`);
  });
  test('the line never carries the key', () => {
    for (const os of ['unix', 'windows'] as const) {
      expect(connectSnippet({ ...base, os, connectCode: CODE.slice(0, 26) })).not.toContain(base.token);
    }
  });
  test('a code in any other shape falls back to the four lines with the key', () => {
    for (const connectCode of [null, '', 'cmc_short', 'cm_' + 'a'.repeat(22), 'cmc_' + 'a'.repeat(21) + ';', 'cmc_' + 'a'.repeat(23)]) {
      const lines = connectSnippet({ ...base, os: 'unix', connectCode }).split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[2]).toContain(base.token);
    }
  });
});

describe('checkedInSinceIssue: only this agent\'s own instance counts', () => {
  const issuedAt = Date.parse('2026-11-14T20:00:00Z');
  const at = '2026-11-14T20:10:00Z';
  test('the default instance checking in does not mark a second instance connected', () => {
    const data = { connected: true, connectedAgent: { agentName: 'my-claude', instanceId: 'default' }, lastUsedAt: at };
    expect(checkedInSinceIssue(data, { agentName: 'my-claude', issuedAt, instanceId: 'alpha' })).toBe(false);
    expect(checkedInSinceIssue(data, { agentName: 'my-claude', issuedAt, instanceId: null })).toBe(true);
  });
  test('the second instance checking in counts for it, in any case', () => {
    const data = { connected: true, connectedAgent: { agentName: 'My-Claude', instanceId: 'Alpha' }, lastUsedAt: at };
    expect(checkedInSinceIssue(data, { agentName: 'my-claude', issuedAt, instanceId: 'alpha' })).toBe(true);
    expect(checkedInSinceIssue(data, { agentName: 'my-claude', issuedAt })).toBe(false);
  });
  test('a check-in from before the key was issued does not count', () => {
    const data = { connected: true, connectedAgent: { agentName: 'my-claude', instanceId: 'default' }, lastUsedAt: '2026-11-14T19:00:00Z' };
    expect(checkedInSinceIssue(data, { agentName: 'my-claude', issuedAt })).toBe(false);
  });
});
