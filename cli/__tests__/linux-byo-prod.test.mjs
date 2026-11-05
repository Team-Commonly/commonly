import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  installExitFromBash, liftConnectSnippet, linuxLineProblems, linuxPasteScript, linuxRouteEnv, runsAtWorkspaceTrust,
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

  test('reads the page\'s Linux lines for Codex in the shape it pastes (D250)', () => {
    const lines = liftConnectSnippet(page)({ os: 'linux', ...sample, adapter: 'codex' }).split('\n');
    expect(linuxLineProblems(lines, { ...sample, adapter: 'codex' })).toEqual([]);
    expect(lines[3]).toBe('commonly agent run linux-walk --adapter codex');
    // A Codex walk handed Claude Code's line says so rather than walk the wrong harness.
    const claude = liftConnectSnippet(page)({ os: 'linux', ...sample, adapter: 'claude' }).split('\n');
    expect(linuxLineProblems(claude, { ...sample, adapter: 'codex' }))
      .toEqual([expect.stringMatching(/line 4 is not a sandboxed Codex run/)]);
  });

  test('routes each harness to the gateway its own way, the key under its own name only', () => {
    expect(linuxRouteEnv('claude', { gateway: 'https://gw.example', key: 'sk-k' }))
      .toEqual({ ANTHROPIC_API_KEY: 'sk-k', ANTHROPIC_BASE_URL: 'https://gw.example' });
    expect(linuxRouteEnv('codex', { gateway: 'https://gw.example', key: 'sk-k' }))
      .toEqual({ CODEX_API_KEY: 'sk-k', OPENAI_BASE_URL: 'https://gw.example/v1' });
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
});
