import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  installExitFromBash, liftConnectSnippet, linuxLineProblems, linuxPasteScript, runsAtWorkspaceTrust,
  walkAdapter, walkModelEnv, codexSystemConfig, walkHomeRoot,
} from '../scripts/linux-byo-prod.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(HERE, '../../frontend/src/v2/components/V2AgentBYO.tsx'), 'utf8');
const sample = { agentName: 'linux-walk', apiUrl: 'https://api.commonly.me', token: 'cm_agent_t' };

describe('the Linux prod walk', () => {
  test('reads the page\'s Linux lines for Claude Code in the shape it pastes', () => {
    const lines = liftConnectSnippet(page)({ os: 'linux', ...sample, adapter: 'claude' }).split('\n');
    expect(linuxLineProblems(lines, sample)).toEqual([]);
    expect(lines[3]).toBe('commonly agent run linux-walk --adapter claude');
  });

  test('stops when the page\'s lines change shape', () => {
    const lines = ['npm i -g @commonlyai/cli@latest', 'export COMMONLY_API_URL=https://api.commonly.me',
      'export COMMONLY_AGENT_TOKEN=cm_agent_t', 'commonly agent run linux-walk --adapter claude --unsandboxed'];
    expect(linuxLineProblems(lines, sample)).toEqual([expect.stringMatching(/line 4 is not a sandboxed Claude Code run/)]);
    expect(linuxLineProblems(lines.slice(0, 3), sample)).toEqual([expect.stringMatching(/3 lines, not 4/)]);
    // The token never appears in a problem the walk logs.
    expect(linuxLineProblems([lines[0], lines[1], 'export COMMONLY_AGENT_TOKEN=other', lines[3]], sample).join(' '))
      .not.toMatch(/other|cm_agent_t/);
  });

  test('throws naming the piece of the page that moved', () => {
    expect(() => liftConnectSnippet(page.replace('export const connectSnippet', 'export const linesFor')))
      .toThrow(/connectSnippet not found/);
  });

  test('a failed install stops the paste and is reported as the install', () => {
    const script = linuxPasteScript(['npm i -g x', 'a', 'b', 'c']);
    expect(script).toHaveLength(5);
    expect(script[1]).toMatch(/exit 97/);
    expect(installExitFromBash('noise\nlinux-byo-walk: the install line exited 243\n')).toBe(243);
    expect(installExitFromBash('polling')).toBeNull();
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
    expect(lines[3]).toBe('commonly agent run linux-walk --adapter codex');
    // The Claude check does not pass a Codex line, and the reverse.
    expect(linuxLineProblems(lines, sample)).toEqual([expect.stringMatching(/line 4/)]);
  });

  test('takes the adapter from the dispatch, Claude Code unless it names Codex', () => {
    expect(walkAdapter({})).toBe('claude');
    expect(walkAdapter({ COMMONLY_BYO_PROD_ADAPTER: 'claude' })).toBe('claude');
    expect(walkAdapter({ COMMONLY_BYO_PROD_ADAPTER: 'codex' })).toBe('codex');
    expect(() => walkAdapter({ COMMONLY_BYO_PROD_ADAPTER: 'opencode' })).toThrow(/claude or codex/);
  });

  test('hands the gateway key to each adapter under its own names, and only those', () => {
    expect(walkModelEnv('claude', 'k', 'https://gw')).toEqual({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://gw' });
    // The CLI keeps this key on the host behind its proxy (D250).
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
    const toml = codexSystemConfig('https://gw');
    expect(toml).toMatch(/^model_provider = "commonly-gateway"$/m);
    expect(toml).toMatch(/^base_url = "https:\/\/gw\/v1"$/m);
    expect(toml).toMatch(/^wire_api = "responses"$/m);
    expect(toml).toMatch(/^env_key = "LITELLM_API_KEY"$/m);
  });
});

