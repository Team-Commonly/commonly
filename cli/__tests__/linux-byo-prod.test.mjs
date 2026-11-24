import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  commandExitFromBash, liftConnectSnippet, linuxLineProblems, linuxPasteScript, neverPolledProblem,
  npxCliVersion, runsAtWorkspaceTrust, walkAdapter, walkModelEnv, codexSystemConfig, walkHomeRoot,
} from '../scripts/linux-byo-prod.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(HERE, '../../frontend/src/v2/components/V2AgentBYO.tsx'), 'utf8');
const sample = { agentName: 'linux-walk', apiUrl: 'https://api.commonly.me', token: 'cm_agent_t' };

describe('the Linux prod walk', () => {
  test('reads the page\'s Linux lines for Claude Code in the shape it pastes', () => {
    const lines = liftConnectSnippet(page)({ os: 'linux', ...sample, adapter: 'claude' }).split('\n');
    expect(linuxLineProblems(lines, sample)).toEqual([]);
    // One line fetches the CLI through npx and runs it: no global install.
    expect(lines[2]).toBe('npx -y @commonlyai/cli@latest agent run linux-walk --adapter claude');
  });

  test('stops when the page\'s lines change shape', () => {
    const lines = ['export COMMONLY_API_URL=https://api.commonly.me',
      'export COMMONLY_AGENT_TOKEN=cm_agent_t', 'npx -y @commonlyai/cli@latest agent run linux-walk --adapter claude --unsandboxed'];
    expect(linuxLineProblems(lines, sample)).toEqual([expect.stringMatching(/line 3 is not a sandboxed Claude Code run/)]);
    expect(linuxLineProblems(lines.slice(0, 2), sample)).toEqual([expect.stringMatching(/2 lines, not 3/)]);
    // The old four lines (a global install first) are not the shape any more.
    expect(linuxLineProblems(['npm i -g @commonlyai/cli@latest', ...lines], sample))
      .toEqual([expect.stringMatching(/4 lines, not 3/)]);
    // A bare `commonly` run with no npx is not the page's line.
    expect(linuxLineProblems([lines[0], lines[1], 'commonly agent run linux-walk --adapter claude'], sample))
      .toEqual([expect.stringMatching(/line 3/)]);
    // The token never appears in a problem the walk logs.
    expect(linuxLineProblems([lines[0], 'export COMMONLY_AGENT_TOKEN=other', lines[2]], sample).join(' '))
      .not.toMatch(/other|cm_agent_t/);
  });

  test('throws naming the piece of the page that moved', () => {
    expect(() => liftConnectSnippet(page.replace('export const connectSnippet', 'export const linesFor')))
      .toThrow(/connectSnippet not found/);
  });

  test('the guard follows the run line and reads back as the page\'s command exit', () => {
    const lines = ['export A=1', 'export B=2', 'npx -y @commonlyai/cli@latest agent run x --adapter claude'];
    const script = linuxPasteScript(lines);
    expect(script).toHaveLength(4);
    expect(script.slice(0, 3)).toEqual(lines);
    expect(script[3]).toMatch(/exit 97/);
    expect(commandExitFromBash('noise\nlinux-byo-walk: the page\'s command exited 243\n')).toBe(243);
    expect(commandExitFromBash('polling')).toBeNull();
  });

  // npx fetching nothing, or the CLI quitting before its poll loop, is the
  // page's command failing, not a CLI that silently never polled.
  test('a failed npx run is reported as the page\'s command, not as "never polled"', () => {
    const out = 'npm error code E404\nlinux-byo-walk: the page\'s command exited 1\n';
    const failed = neverPolledProblem({
      commandExit: commandExitFromBash(out), api: 'https://api.x', shell: 'bash', exited: 97, seconds: 4,
    });
    expect(failed).toBe('the page\'s command exited 1 before the CLI polled https://api.x');
    expect(failed).not.toMatch(/never started polling/);
    expect(neverPolledProblem({
      commandExit: commandExitFromBash('still fetching'), api: 'https://api.x', shell: 'bash', exited: null, seconds: 480,
    })).toBe('the CLI never started polling https://api.x (480 s)');
    expect(neverPolledProblem({
      commandExit: null, api: 'https://api.x', shell: 'bash', exited: 0, seconds: 3,
    })).toBe('the CLI never started polling https://api.x (bash exited 0)');
  });

  // `npm ls -g` sees nothing npx fetched, so the version comes from npx's cache.
  test('reads the CLI version from npx\'s cache, newest first, with no second fetch', () => {
    const cache = mkdtempSync(join(tmpdir(), 'npx-cache-'));
    try {
      expect(npxCliVersion([cache])).toBe('unknown');
      const put = (hash, version, secondsAgo) => {
        const dir = join(cache, '_npx', hash, 'node_modules', '@commonlyai', 'cli');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@commonlyai/cli', version }));
        const at = new Date(Date.now() - secondsAgo * 1000);
        utimesSync(join(dir, 'package.json'), at, at);
      };
      put('aaa', '0.1.100', 600);
      put('bbb', '0.1.200', 5);
      mkdirSync(join(cache, '_npx', 'ccc', 'node_modules'), { recursive: true });
      expect(npxCliVersion([undefined, join(cache, 'missing'), cache])).toBe('0.1.200');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  // A workspace-trust turn drops ANTHROPIC_API_KEY, so the walk needs a public turn.
  test('knows when the CLI would run the agent on a copied login instead of the key', () => {
    const closed = { publicRead: false, communityListed: false, joinPolicy: 'invite-only' };
    expect(runsAtWorkspaceTrust([closed])).toBe(true);
    expect(runsAtWorkspaceTrust([closed, { ...closed, joinPolicy: 'open' }])).toBe(false);
    expect(runsAtWorkspaceTrust([{ ...closed, publicRead: true }])).toBe(false);
    // A row with no visibility reported is not private, as the CLI reads it.
    expect(runsAtWorkspaceTrust([{ joinPolicy: 'invite-only' }])).toBe(false);
    expect(runsAtWorkspaceTrust([])).toBe(false);
  });

  // Codex walks the same lines with --adapter codex. Its public seat skips
  // config.toml (--ignore-user-config) but keeps its environment, so the key
  // and the gateway reach Codex's built-in provider under Codex's own names.
  test('reads the page\'s Linux lines for Codex in the shape it pastes', () => {
    const lines = liftConnectSnippet(page)({ os: 'linux', ...sample, adapter: 'codex' }).split('\n');
    expect(linuxLineProblems(lines, { ...sample, adapter: 'codex' })).toEqual([]);
    expect(lines[2]).toBe('npx -y @commonlyai/cli@latest agent run linux-walk --adapter codex');
    // The Claude check does not pass a Codex line, and the reverse.
    expect(linuxLineProblems(lines, sample)).toEqual([expect.stringMatching(/line 3/)]);
  });

  test('takes the adapter from the dispatch, Claude Code unless it names Codex', () => {
    expect(walkAdapter({})).toBe('claude');
    expect(walkAdapter({ COMMONLY_BYO_PROD_ADAPTER: 'claude' })).toBe('claude');
    expect(walkAdapter({ COMMONLY_BYO_PROD_ADAPTER: 'codex' })).toBe('codex');
    expect(() => walkAdapter({ COMMONLY_BYO_PROD_ADAPTER: 'opencode' })).toThrow(/claude or codex/);
  });

  test('hands the gateway key to each adapter under its own names, and only those', () => {
    expect(walkModelEnv('claude', 'k', 'https://gw')).toEqual({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://gw' });
    // The CLI keeps this key on the host behind its proxy.
    expect(walkModelEnv('codex', 'k', 'https://gw')).toEqual({ CODEX_API_KEY: 'k', OPENAI_BASE_URL: 'https://gw/v1' });
  });

  // Codex will not create its sandbox helpers under the temp dir, so a walk
  // home there fails every Codex turn before the model is called.
  test('puts the walk home outside the temp dir', () => {
    expect(walkHomeRoot().startsWith(tmpdir())).toBe(false);
    // And the walk makes its home there: the call site, not just the helper,
    // so reverting the home to tmpdir() fails here. Runs 41994410063 (home
    // under /tmp, every turn refused) and 41994906534 (passed) are the proof.
    const script = readFileSync(resolve(HERE, '../scripts/linux-byo-prod.mjs'), 'utf8');
    expect(script).toMatch(/const home = mkdtempSync\(join\(walkHomeRoot\(\), 'byo-linux-home-'\)\);/);
    expect(script).not.toMatch(/mkdtempSync\(join\(tmpdir\(\), 'byo-linux-home-'\)\)/);
  });

  test("names the gateway as Codex's provider in the system config, keyed by LITELLM_API_KEY, with no key in the file", () => {
    const toml = codexSystemConfig('https://gw', 'claude-haiku-5-5');
    // The model the key allows, set at the top level, before any table:
    // Codex's own default moves between releases and the key refuses it.
    expect(toml.split('[')[0]).toMatch(/^model = "claude-haiku-5-5"$/m);
    // No model, or one that could break out of the TOML string, is refused.
    expect(() => codexSystemConfig('https://gw')).toThrow(/name the model/);
    expect(() => codexSystemConfig('https://gw', 'a"\nmodel_provider = "x')).toThrow(/name the model/);
    expect(toml).toMatch(/^model_provider = "commonly-gateway"$/m);
    expect(toml).toMatch(/^base_url = "https:\/\/gw\/v1"$/m);
    expect(toml).toMatch(/^wire_api = "responses"$/m);
    expect(toml).toMatch(/^env_key = "LITELLM_API_KEY"$/m);
  });
});

