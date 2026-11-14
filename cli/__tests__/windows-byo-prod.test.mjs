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
  walkInstallLines, windowsCodexConfigPath, windowsLineProblems, windowsProfileRoot, windowsWalkEnv,
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
    // Both run unsandboxed on Windows, by the flag the page's line carries.
    expect(codex[3]).toBe('commonly.cmd agent run win-walk --adapter codex --unsandboxed');
    // The .cmd shims, so Windows 11's default script policy never applies (F342).
    expect(claude[0]).toBe('npm.cmd i -g @commonlyai/cli@latest');
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

  test("installs the page's line, or with cli=tree this checkout's tarball in its place", () => {
    const lines = ['npm i -g @commonlyai/cli@latest', 'a', 'b', 'commonly agent run x --adapter codex'];
    expect(walkInstallLines(lines)).toBe(lines);
    expect(walkInstallLines(lines, { cli: 'published', tarball: 'C:\\t\\cli.tgz' })).toBe(lines);
    expect(walkInstallLines(lines, { cli: 'tree', tarball: 'C:\\t\\cli.tgz' }))
      .toEqual(['npm i -g C:\\t\\cli.tgz', 'a', 'b', 'commonly agent run x --adapter codex']);
    expect(() => walkInstallLines(lines, { cli: 'tree' })).toThrow(/packed/);
  });

  test("names the key's one model in Codex's system config", () => {
    const script = readFileSync(resolve(HERE, '../scripts/windows-byo-prod.mjs'), 'utf8');
    expect(script).toMatch(/writeFileSync\(codexConfig, codexSystemConfig\(MODEL_GATEWAY, MODEL\)\);/);
    expect(script).toMatch(/^const MODEL = 'claude-haiku-5-5';$/m);
  });

  // Codex will not create its sandbox helpers under the temp dir (run 41994410063 on Linux).
  test('puts the walk profile outside the temp dir', () => {
    expect(windowsProfileRoot().startsWith(tmpdir())).toBe(false);
    const script = readFileSync(resolve(HERE, '../scripts/windows-byo-prod.mjs'), 'utf8');
    expect(script).toMatch(/const profile = mkdtempSync\(join\(windowsProfileRoot\(\), 'byo-prod-profile-'\)\);/);
  });
});

// The walks' install steps pin the CLI each adapter runs, at the versions the
// walks passed on; a dropped branch or a moved pin fails here, not on a runner.
describe('the walk workflows install the CLI the dispatch names', () => {
  const workflow = (name) => readFileSync(resolve(HERE, `../../.github/workflows/${name}`), 'utf8');

  test('byo-linux.yml: Codex 0.164.0 for codex, Claude Code 2.1.318 otherwise', () => {
    const install = /if \[ "\$ADAPTER" = codex \]; then\n([\s\S]*?)\n\s*else\n([\s\S]*?)\n\s*fi/.exec(workflow('byo-linux.yml'));
    expect(install).not.toBeNull();
    expect(install[1].trim()).toBe('npm i -g @openai/codex@0.164.0');
    expect(install[2].trim()).toBe('npm i -g @anthropic-ai/claude-code@2.1.318');
  });

  test('byo-windows.yml: on a prod codex dispatch only, the Codex version the dispatch names, 0.169.0 by default', () => {
    const wf = workflow('byo-windows.yml');
    expect(wf).toMatch(/codex_version:\n\s+description: [^\n]+\n\s+type: string\n\s+default: '0\.169\.0'\n/);
    const step = /- name: Install Codex\n([\s\S]*?)\n\s+- name: /.exec(wf);
    expect(step).not.toBeNull();
    expect(step[1]).toMatch(/if: inputs\.target == 'prod' && inputs\.adapter == 'codex'\n/);
    expect(step[1]).toMatch(/CODEX_VERSION: \$\{\{ inputs\.codex_version \|\| '0\.169\.0' \}\}/);
    // The input reaches the shell only through env, after an x.y.z check.
    expect(step[1]).not.toMatch(/run:[\s\S]*\$\{\{/);
    expect(step[1]).toMatch(/\[\[ "\$CODEX_VERSION" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\] \|\| \{[^}]*exit 1; \}\n\s+npm i -g "@openai\/codex@\$CODEX_VERSION"/);
  });
});
