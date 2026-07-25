/**
 * adapters.claude.environment.test.mjs — ADR-008 Phase 1
 *
 * Asserts the claude adapter honours ctx.environment:
 *   - sandbox.mode='bwrap' → spawn binary is `bwrap`, not `claude`
 *   - mcp[]               → --mcp-config <path> added to inner argv,
 *                            and a mode-0600 temp file outside the workspace
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
const { spawnSync } = await import('child_process');

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

const makeSpawnImpl = ({ code = 0 } = {}) => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const configIndex = args.indexOf('--mcp-config');
    const configPath = configIndex === -1 ? null : args[configIndex + 1];
    const config = configPath
      ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
      : null;
    calls.push({
      cmd,
      args,
      opts,
      configPath,
      config,
      configMode: configPath ? fs.statSync(configPath).mode & 0o777 : null,
      configDirMode: configPath ? fs.statSync(path.dirname(configPath)).mode & 0o777 : null,
    });
    return fakeChild({ stdout: 'ok', code });
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

  test('keeps MCP config outside the workspace at 0600 for only the spawn lifetime', async () => {
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

    expect(calls).toHaveLength(1);
    const {
      args: innerArgs,
      configPath: cfgPath,
      config: parsed,
      configMode,
      configDirMode,
    } = calls[0];
    expect(path.isAbsolute(cfgPath)).toBe(true);
    expect(path.relative(cwd, cfgPath).startsWith('..')).toBe(true);
    expect(configMode).toBe(0o600);
    expect(configDirMode).toBe(0o700);
    expect(parsed.mcpServers.github).toMatchObject({ type: 'http', url: 'http://localhost:3000/github-mcp' });
    expect(parsed.mcpServers['local-db']).toMatchObject({
      type: 'stdio', command: 'postgres-mcp', args: ['--db', 'mydb'],
    });
    expect(innerArgs).toContain('--mcp-config');
    const idx = innerArgs.indexOf('--mcp-config');
    expect(innerArgs[idx + 1]).toBe(cfgPath);
    expect(fs.existsSync(path.join(cwd, '.commonly'))).toBe(false);
    expect(fs.existsSync(cfgPath)).toBe(false);
    expect(fs.existsSync(path.dirname(cfgPath))).toBe(false);
  });

  test('removes the transient MCP config when the claude spawn fails', async () => {
    const { impl, calls } = makeSpawnImpl({ code: 1 });

    await expect(claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: {
        mcp: [{ name: 'commonly', transport: 'stdio', command: ['commonly-mcp'] }],
      },
      _spawnImpl: impl,
    })).rejects.toThrow(/claude exited with code 1/);

    expect(calls).toHaveLength(1);
    expect(fs.existsSync(calls[0].configPath)).toBe(false);
    expect(fs.existsSync(path.dirname(calls[0].configPath))).toBe(false);
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

  test('public workspace mode wraps Claude in deny-default Seatbelt with isolated state and env', async () => {
    const originalPlatform = process.platform;
    const publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-public-state-'));
    const { impl, calls } = makeSpawnImpl();
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      spawnSync.mockImplementation((cmd) => (
        cmd === 'which'
          ? { status: 0, stdout: '/usr/bin/true\n' }
          : { status: 0, stdout: '' }
      ));

      await claude.spawn('hi', {
        agentName: 'public-test',
        sessionId: null,
        cwd,
        env: {
          PATH: process.env.PATH,
          USER: 'safe-user',
          LOGNAME: 'safe-user',
          COMMONLY_HOST_SECRET: 'must-not-inherit',
          cm_agent_probe: 'must-not-inherit',
        },
        environment: {
          sandbox: { mode: 'workspace', trust: 'public' },
          mcp: [{
            name: 'capture',
            transport: 'stdio',
            command: [process.execPath, path.join(cwd, 'server.mjs')],
          }],
        },
        _publicClaudeState: publicState,
        _spawnImpl: impl,
      });

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.cmd).toBe('/usr/bin/sandbox-exec');
      expect(call.args[0]).toBe('-p');
      const profile = call.args[1];
      expect(profile).toContain('(deny default)');
      expect(profile).toContain(`(subpath "${fs.realpathSync(cwd)}")`);
      expect(profile).toContain(
        `(deny file-read* file-write* (subpath "${path.join(fs.realpathSync(cwd), '.commonly')}"))`,
      );
      expect(call.args).toContain('--setting-sources');
      expect(call.args).toContain('--strict-mcp-config');
      expect(call.args).toContain('--permission-mode');
      expect(call.args).toContain('Read(./**)');
      expect(call.args).toContain('mcp__capture__*');
      expect(call.args).toContain('Bash');
      expect(call.opts.env.HOME).toBe(publicState);
      expect(call.opts.env.TMPDIR).toBe(path.join(publicState, 'tmp'));
      expect(call.opts.env.USER).toBe('safe-user');
      expect(call.opts.env.COMMONLY_HOST_SECRET).toBeUndefined();
      expect(call.opts.env.cm_agent_probe).toBeUndefined();

      const sanitized = JSON.parse(
        fs.readFileSync(path.join(publicState, '.claude.json'), 'utf8'),
      );
      expect(sanitized.hasCompletedOnboarding).toBe(true);
      expect(Object.keys(sanitized).every((key) => [
        'hasCompletedOnboarding',
        'installMethod',
        'userID',
        'machineID',
        'oauthAccount',
      ].includes(key))).toBe(true);
      expect(fs.statSync(path.join(publicState, '.claude.json')).mode & 0o777).toBe(0o600);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      spawnSync.mockReset();
      fs.rmSync(publicState, { recursive: true, force: true });
    }
  });

  test('public trust with sandbox.mode=none refuses to spawn', async () => {
    const { impl, calls } = makeSpawnImpl();
    await expect(claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { sandbox: { mode: 'none', trust: 'public' } },
      _spawnImpl: impl,
    })).rejects.toThrow(/require an enforced sandbox mode/);
    expect(calls).toHaveLength(0);
  });

  // ── ${COMMONLY_*} native MCP environment expansion ────────────────────────
  // Values exist only in Claude's per-spawn environment. The JSON retains
  // placeholders so a cm_agent_* bearer token never exists on disk.

  test('${COMMONLY_AGENT_TOKEN} stays literal on disk and is supplied only in child env', async () => {
    const { impl, calls } = makeSpawnImpl();
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
    const cfg = calls[0].config;
    expect(cfg.mcpServers.commonly.env.COMMONLY_AGENT_TOKEN).toBe('${COMMONLY_AGENT_TOKEN}');
    expect(cfg.mcpServers.commonly.env.COMMONLY_API_URL).toBe('${COMMONLY_API_URL}');
    expect(cfg.mcpServers.commonly.env.CUSTOM).toBe(
      'literal-value-${COMMONLY_AGENT_TOKEN}-suffix',
    );
    expect(JSON.stringify(cfg)).not.toContain('cm_agent_real_token_12345');
    expect(JSON.stringify(calls[0].args)).not.toContain('cm_agent_real_token_12345');
    expect(calls[0].opts.env.COMMONLY_AGENT_TOKEN).toBe('cm_agent_real_token_12345');
    expect(calls[0].opts.env.COMMONLY_API_URL).toBe('https://api-dev.commonly.me');
  });

  test('${COMMONLY_INSTANCE_URL} alias is supplied to native expansion', async () => {
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { mcp: [{ name: 'x', transport: 'stdio', command: ['m'], env: { U: '${COMMONLY_INSTANCE_URL}' } }] },
      runtimeToken: 'cm_agent_t',
      instanceUrl: 'http://localhost:5000',
      _spawnImpl: impl,
    });
    const cfg = calls[0].config;
    expect(cfg.mcpServers.x.env.U).toBe('${COMMONLY_INSTANCE_URL}');
    expect(calls[0].opts.env.COMMONLY_INSTANCE_URL).toBe('http://localhost:5000');
  });

  test('placeholders in command args + url stay token-free and receive expansion env', async () => {
    const { impl, calls } = makeSpawnImpl();
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
    const cfg = calls[0].config;
    expect(cfg.mcpServers['sse-server'].url).toBe('${COMMONLY_API_URL}/mcp/sse');
    expect(cfg.mcpServers['arg-server'].args).toEqual(['--token', '${COMMONLY_AGENT_TOKEN}']);
    expect(calls[0].opts.env.COMMONLY_API_URL).toBe('https://api-dev.commonly.me');
    expect(calls[0].opts.env.COMMONLY_AGENT_TOKEN).toBe('cm_agent_x');
  });

  test('unknown ${COMMONLY_*} placeholders are left intact (so misspellings surface as MCP errors, not silent empties)', async () => {
    const { impl, calls } = makeSpawnImpl();
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
    const cfg = calls[0].config;
    expect(cfg.mcpServers.x.env.TYPO).toBe('${COMMONLY_AGNT_TOKEN}');
    expect(calls[0].opts.env.COMMONLY_AGNT_TOKEN).toBeUndefined();
  });

  test('missing runtime context never creates a token environment entry', async () => {
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      env: { PATH: process.env.PATH },
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
    const cfg = calls[0].config;
    expect(cfg.mcpServers.x.env.LITERAL).toBe('plain-string');
    expect(cfg.mcpServers.x.env.PLACEHOLDER).toBe('${COMMONLY_AGENT_TOKEN}');
    expect(calls[0].opts.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
  });
});
