/**
 * adapters.claude.environment.test.mjs — ADR-008 Phase 1
 *
 * Asserts the claude adapter honours ctx.environment:
 *   - sandbox.mode='bwrap' → spawn binary is `bwrap`, not `claude`
 *   - mcp[]               → --mcp-config <path> added to inner argv,
 *                            and the JSON file written under <cwd>/.commonly/
 *   - skills.claude[]     → linkSkills called against the workspace
 *
 * Uses ctx._spawnImpl (the same test seam as adapters.claude.test.mjs) so
 * no real claude/bwrap binary runs.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import fs from 'fs';

const onLinux = process.platform === 'linux';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(),
  spawn: jest.fn(),
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;

const fakeChild = ({ stdout = '', code = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', code);
  }, 0);
  return proc;
};

const makeSpawnImpl = () => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild({ stdout: 'ok' });
  };
  return { impl, calls };
};

describe('claude adapter — ctx.environment', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-env-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('writes <cwd>/.commonly/mcp-config.json and adds --mcp-config when env.mcp declared', async () => {
    const { impl, calls } = makeSpawnImpl();
    const environment = {
      mcp: [
        { name: 'github', transport: 'http', url: 'http://localhost:3000/github-mcp' },
        { name: 'local-db', transport: 'stdio', command: ['postgres-mcp', '--db', 'mydb'] },
      ],
    };

    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment,
      _spawnImpl: impl,
    });

    const cfgPath = path.join(cwd, '.commonly', 'mcp-config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(parsed.mcpServers.github).toMatchObject({ type: 'http', url: 'http://localhost:3000/github-mcp' });
    expect(parsed.mcpServers['local-db']).toMatchObject({
      type: 'stdio', command: 'postgres-mcp', args: ['--db', 'mydb'],
    });

    expect(calls).toHaveLength(1);
    const innerArgs = calls[0].args;
    expect(innerArgs).toContain('--mcp-config');
    const idx = innerArgs.indexOf('--mcp-config');
    expect(innerArgs[idx + 1]).toBe(cfgPath);
  });

  test('symlinks skills.claude entries into <cwd>/.claude/skills/', async () => {
    const { impl } = makeSpawnImpl();
    const skillSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-skill-'));
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), 'x', 'utf8');

    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { skills: { claude: [skillSrc] } },
      _spawnImpl: impl,
    });

    const link = path.join(cwd, '.claude', 'skills', path.basename(skillSrc));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);

    fs.rmSync(skillSrc, { recursive: true, force: true });
  });

  (onLinux ? test : test.skip)('sandbox.mode=bwrap → spawn binary is `bwrap`, claude moves into inner argv', async () => {
    const { impl, calls } = makeSpawnImpl();

    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: {
        sandbox: { mode: 'bwrap', network: { policy: 'unrestricted' } },
      },
      _spawnImpl: impl,
    });

    expect(calls[0].cmd).toBe('bwrap');
    // Inner argv after `--` must invoke claude. We resolve to an absolute
    // path before wrapping (so bwrap's execvp doesn't depend on PATH being
    // set up correctly inside the sandbox), so the inner argv[0] is either
    // the bare `claude` (when `which` returns nothing) or an absolute path
    // ending in `/claude`.
    const sepIdx = calls[0].args.indexOf('--');
    expect(sepIdx).toBeGreaterThan(-1);
    const innerCmd = calls[0].args[sepIdx + 1];
    expect(innerCmd === 'claude' || innerCmd.endsWith('/claude')).toBe(true);
  });

  test('no environment → behaviour identical to pre-ADR-008 (cmd=claude, no MCP file)', async () => {
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', { sessionId: null, cwd, _spawnImpl: impl });
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).not.toContain('--mcp-config');
    expect(fs.existsSync(path.join(cwd, '.commonly'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
  });

  // ── ${COMMONLY_*} placeholder substitution ────────────────────────────────
  // Lets users keep their checked-in env files free of secrets — the
  // wrapper substitutes the runtime token + instance URL at spawn time
  // from values it already has on hand (the saved token record).

  test('${COMMONLY_AGENT_TOKEN} in MCP env values is substituted with ctx.runtimeToken', async () => {
    const { impl } = makeSpawnImpl();
    const environment = {
      mcp: [
        {
          name: 'commonly',
          transport: 'stdio',
          command: ['commonly-mcp'],
          env: {
            COMMONLY_API_URL: '${COMMONLY_API_URL}',
            COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
            CUSTOM: 'literal-value-${COMMONLY_AGENT_TOKEN}-suffix',
          },
        },
      ],
    };
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment,
      runtimeToken: 'cm_agent_real_token_12345',
      instanceUrl: 'https://api-dev.commonly.me',
      _spawnImpl: impl,
    });
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.commonly', 'mcp-config.json'), 'utf8'));
    expect(cfg.mcpServers.commonly.env.COMMONLY_AGENT_TOKEN).toBe('cm_agent_real_token_12345');
    expect(cfg.mcpServers.commonly.env.COMMONLY_API_URL).toBe('https://api-dev.commonly.me');
    // Substitution is literal — interpolation works inside larger strings.
    expect(cfg.mcpServers.commonly.env.CUSTOM).toBe(
      'literal-value-cm_agent_real_token_12345-suffix',
    );
  });

  test('${COMMONLY_INSTANCE_URL} alias substitutes to the same value as ${COMMONLY_API_URL}', async () => {
    const { impl } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { mcp: [{ name: 'x', transport: 'stdio', command: ['m'], env: { U: '${COMMONLY_INSTANCE_URL}' } }] },
      runtimeToken: 'cm_agent_t',
      instanceUrl: 'http://localhost:5000',
      _spawnImpl: impl,
    });
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.commonly', 'mcp-config.json'), 'utf8'));
    expect(cfg.mcpServers.x.env.U).toBe('http://localhost:5000');
  });

  test('placeholders in command args + url are also substituted', async () => {
    const { impl } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: {
        mcp: [
          {
            name: 'sse-server',
            transport: 'sse',
            url: '${COMMONLY_API_URL}/mcp/sse',
          },
          {
            name: 'arg-server',
            transport: 'stdio',
            command: ['some-bin', '--token', '${COMMONLY_AGENT_TOKEN}'],
          },
        ],
      },
      runtimeToken: 'cm_agent_x',
      instanceUrl: 'https://api-dev.commonly.me',
      _spawnImpl: impl,
    });
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.commonly', 'mcp-config.json'), 'utf8'));
    expect(cfg.mcpServers['sse-server'].url).toBe('https://api-dev.commonly.me/mcp/sse');
    expect(cfg.mcpServers['arg-server'].args).toEqual(['--token', 'cm_agent_x']);
  });

  test('unknown ${COMMONLY_*} placeholders are left intact (so misspellings surface as MCP errors, not silent empties)', async () => {
    const { impl } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: {
        mcp: [{
          name: 'x',
          transport: 'stdio',
          command: ['m'],
          env: { TYPO: '${COMMONLY_AGNT_TOKEN}' /* typo, not a real key */ },
        }],
      },
      runtimeToken: 'cm_agent_t',
      instanceUrl: 'http://localhost:5000',
      _spawnImpl: impl,
    });
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.commonly', 'mcp-config.json'), 'utf8'));
    expect(cfg.mcpServers.x.env.TYPO).toBe('${COMMONLY_AGNT_TOKEN}');
  });

  test('substitution is a no-op when ctx.runtimeToken / instanceUrl are absent (literal env values pass through)', async () => {
    const { impl } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: {
        mcp: [{
          name: 'x',
          transport: 'stdio',
          command: ['m'],
          env: { LITERAL: 'plain-string', PLACEHOLDER: '${COMMONLY_AGENT_TOKEN}' },
        }],
      },
      _spawnImpl: impl,
      // Note: no runtimeToken, no instanceUrl.
    });
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.commonly', 'mcp-config.json'), 'utf8'));
    expect(cfg.mcpServers.x.env.LITERAL).toBe('plain-string');
    // Empty token → placeholder left intact (not substituted with empty string).
    expect(cfg.mcpServers.x.env.PLACEHOLDER).toBe('${COMMONLY_AGENT_TOKEN}');
  });
});
