// The Windows prod walk (windows-byo-prod.mjs) walks the page's Windows lines
// for Claude Code or Codex. Codex ignores OPENAI_BASE_URL and a public seat
// skips the user's config.toml, so the gateway provider goes in Codex's
// Windows system layer, %ProgramData%\OpenAI\Codex\config.toml.

import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { liftConnectSnippet } from '../scripts/linux-byo-prod.mjs';
import {
  windowsCodexConfigPath, windowsLineProblems, windowsProfileRoot, windowsWalkEnv,
} from '../scripts/windows-byo-prod.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(HERE, '../../frontend/src/v2/components/V2AgentBYO.tsx'), 'utf8');
const sample = { agentName: 'win-walk', apiUrl: 'https://api.commonly.me', token: 'cm_agent_t' };

describe('the Windows prod walk', () => {
  test("reads the page's Windows lines for each adapter, and only that adapter's", () => {
    const snippet = liftConnectSnippet(page);
    const claude = snippet({ os: 'windows', ...sample, adapter: 'claude' }).split('\n');
    const codex = snippet({ os: 'windows', ...sample, adapter: 'codex' }).split('\n');
    expect(windowsLineProblems(claude, { agentName: 'win-walk', adapter: 'claude' })).toEqual([]);
    expect(windowsLineProblems(codex, { agentName: 'win-walk', adapter: 'codex' })).toEqual([]);
    // Codex runs in its own Windows sandbox; Claude Code runs unsandboxed.
    expect(codex[3]).toBe('commonly agent run win-walk --adapter codex');
    expect(windowsLineProblems(codex, { agentName: 'win-walk', adapter: 'claude' }))
      .toEqual([expect.stringMatching(/line 4/)]);
    expect(windowsLineProblems(claude.slice(0, 3), { agentName: 'win-walk', adapter: 'claude' }))
      .toEqual([expect.stringMatching(/3 lines, not 4/)]);
  });

  test("puts Codex's gateway provider in the Windows system layer", () => {
    expect(windowsCodexConfigPath({ ProgramData: 'D:\\PD' })).toBe('D:\\PD\\OpenAI\\Codex\\config.toml');
    expect(windowsCodexConfigPath({})).toBe('C:\\ProgramData\\OpenAI\\Codex\\config.toml');
  });

  test('hands Codex the gateway key as LITELLM_API_KEY, and Claude Code nothing in the env', () => {
    expect(windowsWalkEnv('codex', 'k')).toEqual({ LITELLM_API_KEY: 'k' });
    // Claude Code's key goes in its managed settings, since a public seat drops ANTHROPIC_*.
    expect(windowsWalkEnv('claude', 'k')).toEqual({});
  });

  // Codex will not create its sandbox helpers under the temp dir (run 41994410063 on Linux).
  test('puts the walk profile outside the temp dir', () => {
    expect(windowsProfileRoot().startsWith(tmpdir())).toBe(false);
  });
});
