/**
 * adapters.claude.environment.test.mjs — ADR-008 Phase 1
 *
 * Asserts the claude adapter honours ctx.environment:
 *   - sandbox.mode='bwrap' → spawn binary is `bwrap`, not `claude`
 *   - mcp[]               → --mcp-config <path> added to inner argv,
 *                            and a mode-0600 temp file outside the workspace
 *   - skills.claude[]     → mountSkills called against the workspace
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
      model: 'test-model',
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
      environment: { model: 'test-model',
        mcp: [{ name: 'commonly', transport: 'stdio', command: ['commonly-mcp'] }],
      },
      _spawnImpl: impl,
    })).rejects.toThrow(/claude exited with code 1/);

    expect(calls).toHaveLength(1);
    expect(fs.existsSync(calls[0].configPath)).toBe(false);
    expect(fs.existsSync(path.dirname(calls[0].configPath))).toBe(false);
  });

  test('TASK-174: a warmed MCP home makes claude execute the home build, not npx @latest', async () => {
    // The control for this arm is the rest of this file: every other test here
    // declares the shipped `npx -y @commonlyai/mcp@latest`, and the jest setup
    // points COMMONLY_MCP_HOME at a home with no installed build, so they all see it unchanged.
    // This arm is the same call with a populated home.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mcp-home-'));
    const pkgDir = path.join(home, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.13', type: 'module', bin: { 'commonly-mcp': 'src/index.js' },
    }));
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.js'), '');
    fs.writeFileSync(path.join(home, 'current'), '0.3.13\n');
    fs.writeFileSync(path.join(home, '.warm.lock'), 'warming\n');
    const previous = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = home;
    try {
      const { impl, calls } = makeSpawnImpl();
      await claude.spawn('hi', {
        sessionId: null,
        cwd,
        instanceUrl: 'https://api.example.test',
        runtimeToken: 'cm_agent_secret',
        environment: { model: 'test-model',
          mcp: [{
            name: 'commonly',
            transport: 'stdio',
            command: ['npx', '-y', '@commonlyai/mcp@latest'],
            env: {
              COMMONLY_API_URL: '${COMMONLY_API_URL}',
              COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
            },
          }],
        },
        _spawnImpl: impl,
      });

      const entry = calls[0].config.mcpServers.commonly;
      const bin = path.join(pkgDir, 'src', 'index.js');
      expect(entry.command).toBe('node');
      expect(entry.args).toEqual([bin]);
      expect(JSON.stringify(calls[0].config)).not.toContain('@latest');
      // And the credential channel did NOT move with it: the executed build is
      // 0.3.13, which reads the file, exactly as the unpinned declaration did.
      expect(entry.env.COMMONLY_TOKEN_FILE).toBeDefined();
      expect(entry.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
    } finally {
      // `process.env.X = undefined` does not unset X — it sets the STRING
      // "undefined", which is how a warm came to write ./undefined/ (TASK-174).
      if (previous === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = previous;
    }
  });

  test('TASK-174: the cold path materialises an EXACT spec — the spawn never names @latest', async () => {
    // The home has no installed build, only the registry cache and warm lock: this is the
    // one state where the declaration still runs through npx, and `@latest` is
    // the one spec whose npx dir every seat shares and a publish rewrites in
    // place. So the config this adapter writes names the version the host
    // resolved, which gets a dir of its own. The control is the whole rest of
    // this file: the same call with no cache in the home lands on the declared
    // `@latest` unchanged.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mcp-pin-'));
    fs.writeFileSync(path.join(home, '.registry.json'), JSON.stringify({
      version: '0.3.13', checkedAt: Date.now(),
    }));
    fs.writeFileSync(path.join(home, '.warm.lock'), 'warming\n');
    const previous = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = home;
    try {
      const { impl, calls } = makeSpawnImpl();
      await claude.spawn('hi', {
        sessionId: null,
        cwd,
        instanceUrl: 'https://api.example.test',
        runtimeToken: 'cm_agent_secret',
        environment: { model: 'test-model',
          mcp: [{
            name: 'commonly',
            transport: 'stdio',
            command: ['npx', '-y', '@commonlyai/mcp@latest'],
            env: {
              COMMONLY_API_URL: '${COMMONLY_API_URL}',
              COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
            },
          }],
        },
        _spawnImpl: impl,
      });

      const entry = calls[0].config.mcpServers.commonly;
      expect(entry.command).toBe('npx');
      expect(entry.args).toEqual(['-y', '@commonlyai/mcp@0.3.13']);
      expect(JSON.stringify(calls[0].config)).not.toContain('@latest');
      // The credential channel still follows the DECLARED build here: nothing in
      // the home proves which reader the pinned version has, and `@0.3.13` reads
      // the file (mcp-credential-delivery's floor is 0.3.12) — so the token
      // travels as a path, not in the env.
      expect(entry.env.COMMONLY_TOKEN_FILE).toBeDefined();
      expect(entry.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
    } finally {
      // `process.env.X = undefined` does not unset X — it sets the STRING
      // "undefined" (the TASK-174 footgun).
      if (previous === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = previous;
    }
  });

  test('TASK-174: an OLD build in the home keeps the env channel — the channel follows what RUNS', async () => {
    // The interesting case, and the one that makes the coupling observable: the
    // declaration is the unpinned `@latest` (which is never treated as old, so it
    // lands on the file channel), while the home points at 0.3.7, whose reader
    // only understands the environment. Deciding the channel on the declaration
    // would hand that build a path it cannot read and take the seat's tools away;
    // deciding it on the executed command keeps the token in the env for exactly
    // that build (mcp-credential-delivery only does this below 0.3.12).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mcp-home-old-'));
    const pkgDir = path.join(home, '0.3.7', 'node_modules', '@commonlyai', 'mcp');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.7', type: 'module', bin: { 'commonly-mcp': 'src/index.js' },
    }));
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.js'), '');
    fs.writeFileSync(path.join(home, 'current'), '0.3.7\n');
    fs.writeFileSync(path.join(home, '.warm.lock'), 'warming\n');
    const previous = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = home;
    try {
      const { impl, calls } = makeSpawnImpl();
      await claude.spawn('hi', {
        sessionId: null,
        cwd,
        instanceUrl: 'https://api.example.test',
        runtimeToken: 'cm_agent_secret',
        environment: { model: 'test-model',
          mcp: [{
            name: 'commonly',
            transport: 'stdio',
            command: ['npx', '-y', '@commonlyai/mcp@latest'],
            env: {
              COMMONLY_API_URL: '${COMMONLY_API_URL}',
              COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
            },
          }],
        },
        _spawnImpl: impl,
      });

      const entry = calls[0].config.mcpServers.commonly;
      expect(entry.command).toBe('node');
      expect(entry.args[0]).toContain(path.join('0.3.7', 'node_modules'));
      expect(entry.env.COMMONLY_AGENT_TOKEN).toBe('${COMMONLY_AGENT_TOKEN}');
      expect(entry.env.COMMONLY_TOKEN_FILE).toBeUndefined();
      // The token rides in the CHILD ENV for this build, because claude expands
      // `${VAR}` from its own environment — the channel is observable in two
      // places, and asserting only the config would miss the child env.
      expect(calls[0].opts.env.COMMONLY_AGENT_TOKEN).toBe('cm_agent_secret');
    } finally {
      // `process.env.X = undefined` does not unset X — it sets the STRING
      // "undefined", which is how a warm came to write ./undefined/ (TASK-174).
      if (previous === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = previous;
    }
  });

  test('mounts skills.claude entries into <cwd>/.claude/skills/ as read-only copies', async () => {
    const { impl } = makeSpawnImpl();
    const onSkillsLinked = jest.fn();
    const skillSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-skill-'));
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), 'x', 'utf8');

    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { model: 'test-model', skills: { claude: [skillSrc] } },
      onSkillsLinked,
      _spawnImpl: impl,
    });

    const slot = path.join(cwd, '.claude', 'skills', path.basename(skillSrc));
    // A copy, never a symlink — a symlink is writable through, which lets an
    // agent edit its own governing skill in the operator's checkout (#702
    // guardrail was lost from cli 0.1.4 exactly this way).
    expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(slot, 'SKILL.md'), 'utf8')).toBe('x');
    expect(onSkillsLinked).toHaveBeenCalledWith({ mounted: [skillSrc], conflicted: [] });

    fs.rmSync(skillSrc, { recursive: true, force: true });
  });

  (onLinux ? test : test.skip)('sandbox.mode=bwrap → spawn binary is `bwrap`, claude moves into inner argv', async () => {
    const { impl, calls } = makeSpawnImpl();

    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { model: 'test-model',
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
    await claude.spawn('hi', { environment: { model: 'test-model' }, sessionId: null, cwd, _spawnImpl: impl });
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).not.toContain('--mcp-config');
    expect(fs.existsSync(path.join(cwd, '.commonly'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
  });

  test('public workspace mode wraps Claude in deny-default Seatbelt with isolated state and env', async () => {
    const originalPlatform = process.platform;
    const publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-public-state-'));
    const hooksPath = path.join(cwd, '.git', 'commonly-agent-hooks-test');
    const originalHooksPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-existing-hooks-'));
    const originalPreCommit = path.join(originalHooksPath, 'pre-commit');
    fs.writeFileSync(originalPreCommit, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const commitAttributionEnv = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooksPath,
      COMMONLY_AGENT_GIT_CONFIG_INDEX: '0',
      COMMONLY_AGENT_GIT_CONFIG_BASE_COUNT: '0',
      COMMONLY_AGENT_HOOKS_PATH: hooksPath,
      COMMONLY_AGENT_ORIGINAL_HOOKS_PATH: originalHooksPath,
      COMMONLY_AGENT_SEAT_NAME: 'Public Seat',
      COMMONLY_AGENT_SEAT_ID: 'public%3Adefault',
      COMMONLY_AGENT_ADAPTER: 'claude',
      COMMONLY_AGENT_MODEL: 'model-test',
      COMMONLY_AGENT_EFFORT: 'high',
    };
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
        commitAttributionEnv,
        environment: { model: 'test-model',
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
      expect(profile).toContain(`(literal "${path.join(hooksPath, 'prepare-commit-msg')}")`);
      expect(profile).toContain(`(literal "${fs.realpathSync(originalPreCommit)}")`);
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
      // Without it Claude creates /tmp/claude-<uid>, which the profile denies.
      expect(call.opts.env.CLAUDE_CODE_TMPDIR).toBe(path.join(publicState, 'tmp'));
      expect(call.opts.env.USER).toBe('safe-user');
      expect(call.opts.env.COMMONLY_HOST_SECRET).toBeUndefined();
      expect(call.opts.env.cm_agent_probe).toBeUndefined();
      expect(call.opts.env.GIT_CONFIG_COUNT).toBe('1');
      expect(call.opts.env.GIT_CONFIG_VALUE_0).toBe(hooksPath);
      expect(call.opts.env.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH).toBe(originalHooksPath);
      expect(call.opts.env.COMMONLY_AGENT_SEAT_NAME).toBe('Public Seat');

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
      fs.rmSync(originalHooksPath, { recursive: true, force: true });
    }
  });

  test('public workspace mode tolerates an HTTP MCP server beside the stdio one (grant broker)', async () => {
    // The grant broker rides in `environment.mcp` as `{ transport: 'http', url }`
    // with no `command`. The Seatbelt executable allow-list is derived from
    // `command[0]`, and `isAbsolute(undefined)` throws ERR_INVALID_ARG_TYPE —
    // measured 2026-09-18 on c4-smoke: every confined spawn died at argv
    // construction with `The "path" argument must be of type string`.
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
        env: { PATH: process.env.PATH, USER: 'safe-user', LOGNAME: 'safe-user' },
        environment: { model: 'test-model',
          sandbox: { mode: 'workspace', trust: 'public' },
          mcp: [
            {
              name: 'commonly',
              transport: 'stdio',
              command: [process.execPath, path.join(cwd, 'server.mjs')],
            },
            {
              name: 'commonly-grant-broker',
              transport: 'http',
              url: 'https://api.example.test/api/mcp/grants/grant_x',
              headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
            },
          ],
        },
        _publicClaudeState: publicState,
        _spawnImpl: impl,
      });

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.cmd).toBe('/usr/bin/sandbox-exec');
      const profile = call.args[1];
      expect(profile).toContain(`(literal "${fs.realpathSync(process.execPath)}")`);
      expect(call.args).toContain('mcp__commonly__*');
      expect(call.args).toContain('mcp__commonly-grant-broker__*');
      expect(call.args).toContain('--mcp-config');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      spawnSync.mockReset();
      fs.rmSync(publicState, { recursive: true, force: true });
    }
  });

  // TASK-273: this used to spawn with a notice appended, and the model narrated
  // the failure to a stranger (Commonly HQ, 2026-10-15). Now the turn is refused
  // before Claude runs, so there is nothing to post.
  test('a public cold MCP refuses the turn before Claude runs', async () => {
    const originalPlatform = process.platform;
    const publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-public-state-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-mcp-home-'));
    fs.writeFileSync(path.join(home, '.warm.lock'), 'warming\n');
    const prior = process.env.COMMONLY_MCP_HOME;
    const { impl, calls } = makeSpawnImpl();
    try {
      process.env.COMMONLY_MCP_HOME = home;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      spawnSync.mockImplementation((cmd) => (cmd === 'which'
        ? { status: 0, stdout: '/usr/bin/true\n' } : { status: 0, stdout: '' }));
      await expect(claude.spawn('hi', {
        agentName: 'public-test', cwd,
        env: { PATH: process.env.PATH, USER: 'safe-user', LOGNAME: 'safe-user' },
        environment: { model: 'test-model',
          sandbox: { mode: 'workspace', trust: 'public' },
          mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }],
        },
        _publicClaudeState: publicState,
        _spawnImpl: impl,
      })).rejects.toMatchObject({ code: 'public_mcp_unavailable' });
      expect(calls).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = prior;
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      spawnSync.mockReset();
      fs.rmSync(publicState, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // Rhea on #2247: the refusal must hold for every public seat, whatever
  // confines it, and must not be mistaken for a session-store failure.
  const withColdMcpHome = async (fn) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-mcp-home-'));
    fs.writeFileSync(path.join(home, '.warm.lock'), 'warming\n');
    const prior = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = home;
    try {
      await fn();
    } finally {
      if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = prior;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  const COLD_MCP = [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }];

  test.each([
    ['with no mode (bwrap by default off darwin)', { trust: 'public' }],
    ['with an explicit bwrap mode', { trust: 'public', mode: 'bwrap' }],
  ])('a public Linux seat %s refuses a cold MCP before Claude runs', async (_label, sandbox) => {
    const originalPlatform = process.platform;
    const { impl, calls } = makeSpawnImpl();
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      await withColdMcpHome(async () => {
        await expect(claude.spawn('hi', {
          sessionId: null,
          cwd,
          env: { PATH: process.env.PATH },
          environment: { model: 'test-model', sandbox, mcp: COLD_MCP },
          _spawnImpl: impl,
          _detectBwrap: () => ({ available: true, path: 'bwrap' }),
        })).rejects.toMatchObject({ code: 'public_mcp_unavailable' });
      });
      expect(calls).toHaveLength(0);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  test('a resumed public seat whose cold MCP name matches the session-recovery text still refuses', async () => {
    const originalPlatform = process.platform;
    const publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-public-state-'));
    const { impl, calls } = makeSpawnImpl();
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      spawnSync.mockImplementation((cmd) => (cmd === 'which'
        ? { status: 0, stdout: '/usr/bin/true\n' } : { status: 0, stdout: '' }));
      await withColdMcpHome(async () => {
        await expect(claude.spawn('hi', {
          sessionId: '11111111-1111-4111-8111-111111111111',
          agentName: 'public-test',
          cwd,
          env: { PATH: process.env.PATH, USER: 'safe-user', LOGNAME: 'safe-user' },
          environment: { model: 'test-model',
            sandbox: { mode: 'workspace', trust: 'public' },
            mcp: [{ ...COLD_MCP[0], name: 'no session' }],
          },
          _publicClaudeState: publicState,
          _spawnImpl: impl,
        })).rejects.toMatchObject({ code: 'public_mcp_unavailable' });
      });
      expect(calls).toHaveLength(0);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      spawnSync.mockReset();
      fs.rmSync(publicState, { recursive: true, force: true });
    }
  });

  test('a public warm MCP grants only its selected version directory to Claude', async () => {
    const originalPlatform = process.platform;
    const publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-public-state-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-mcp-home-'));
    const versionDir = path.join(home, '0.3.13');
    const pkgDir = path.join(versionDir, 'node_modules', '@commonlyai', 'mcp');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
    }));
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.js'), '');
    fs.writeFileSync(path.join(home, 'current'), '0.3.13\n');
    fs.writeFileSync(path.join(home, '.warm.lock'), 'warming\n');
    const prior = process.env.COMMONLY_MCP_HOME;
    const { impl, calls } = makeSpawnImpl();
    try {
      process.env.COMMONLY_MCP_HOME = home;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      spawnSync.mockImplementation((cmd) => (cmd === 'which'
        ? { status: 0, stdout: '/usr/bin/true\n' } : { status: 0, stdout: '' }));
      await claude.spawn('hi', {
        agentName: 'public-test', cwd,
        env: { PATH: process.env.PATH, USER: 'safe-user', LOGNAME: 'safe-user' },
        environment: { model: 'test-model',
          sandbox: { mode: 'workspace', trust: 'public' },
          mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }],
        },
        _publicClaudeState: publicState,
        _spawnImpl: impl,
      });
      expect(calls[0].config.mcpServers.commonly).toMatchObject({
        command: 'node', args: [path.join(pkgDir, 'src', 'index.js')],
      });
      expect(calls[0].args).toContain('-p');
      expect(calls[0].args[calls[0].args.indexOf('-p') + 1]).toContain(`(subpath "${fs.realpathSync(versionDir)}")`);
      expect(calls[0].args[calls[0].args.indexOf('-p') + 1]).not.toContain(`(subpath "${fs.realpathSync(home)}")`);
    } finally {
      if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = prior;
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      spawnSync.mockReset();
      fs.rmSync(publicState, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('public trust with sandbox.mode=none refuses to spawn', async () => {
    const { impl, calls } = makeSpawnImpl();
    await expect(claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { model: 'test-model', sandbox: { mode: 'none', trust: 'public' } },
      _spawnImpl: impl,
    })).rejects.toThrow(/require an enforced sandbox mode/);
    expect(calls).toHaveLength(0);
  });

  // Vera 69548: a mode-less public block used to fall straight through to the
  // bare `claude` spawn — a record claiming confinement it never got. The
  // derived record stores trust only (the block is portable, the host is not),
  // so the adapter has to resolve the mode here.
  test('public trust with NO mode resolves to Seatbelt workspace on darwin', async () => {
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
        agentName: 'derived-sandbox',
        sessionId: null,
        cwd,
        env: { PATH: process.env.PATH },
        environment: { model: 'test-model', sandbox: { trust: 'public' } },
        _publicClaudeState: publicState,
        _spawnImpl: impl,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('/usr/bin/sandbox-exec');
      expect(calls[0].args[1]).toContain('(deny default)');
      expect(calls[0].args).toContain('--setting-sources');
      expect(calls[0].args).toContain('--permission-mode');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      spawnSync.mockReset();
      fs.rmSync(publicState, { recursive: true, force: true });
    }
  });

  test('public trust with NO mode resolves to bwrap off darwin, with the same tool policy macOS gets', async () => {
    const originalPlatform = process.platform;
    const { impl, calls } = makeSpawnImpl();
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      await claude.spawn('hi', {
        sessionId: null,
        cwd,
        env: {
          PATH: process.env.PATH,
          COMMONLY_HOST_SECRET: 'must-not-reach-public-seat',
          AWS_SECRET_ACCESS_KEY: 'must-not-reach-public-seat',
        },
        commitAttributionEnv: { COMMONLY_AGENT_SEAT_NAME: 'Public Linux Seat' },
        environment: { model: 'test-model', sandbox: { trust: 'public' } },
        _spawnImpl: impl,
        _detectBwrap: () => ({ available: true, path: 'bwrap' }),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('bwrap');
      expect(calls[0].args).toContain('--unshare-all');
      expect(calls[0].args).toContain('--die-with-parent');
      // The adapter passes its filtered environment to bwrap as the process
      // environment; values are not serialized into bwrap argv.
      expect(calls[0].args).not.toContain('--clearenv');
      expect(calls[0].args).not.toContain('must-not-reach-public-seat');
      expect(calls[0].opts.env).toEqual({
        PATH: process.env.PATH,
        COMMONLY_AGENT_SEAT_NAME: 'Public Linux Seat',
      });
      // The inner claude argv rides after `--`, inside the namespace.
      const inner = calls[0].args.slice(calls[0].args.indexOf('--') + 1);
      expect(inner[0]).toMatch(/claude$/);
      // The jail bounds the filesystem, the policy bounds the tools — the
      // Linux seat gets the same floor as the macOS one, not the half of it
      // that happened to be on the other side of a branch (Vera 69578).
      const settingSources = inner.indexOf('--setting-sources');
      expect(settingSources).toBeGreaterThan(-1);
      expect(inner[settingSources + 1]).toBe('');
      expect(inner).toContain('--strict-mcp-config');
      expect(inner).toContain('--no-chrome');
      expect(inner).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
      expect(inner).toContain('--disallowedTools');
      expect(inner.join(' ')).toContain('Read(./.env)');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  test('a public Linux seat whose host has no bwrap refuses to derive, rather than failing per spawn', async () => {
    const originalPlatform = process.platform;
    const { impl, calls } = makeSpawnImpl();
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      await expect(claude.spawn('hi', {
        sessionId: null,
        cwd,
        env: { PATH: process.env.PATH },
        environment: { model: 'test-model', sandbox: { trust: 'public' } },
        _spawnImpl: impl,
        _detectBwrap: () => ({ available: false, error: 'bwrap not found on PATH.' }),
      })).rejects.toThrow(/require bwrap: bwrap not found/);
      expect(calls).toHaveLength(0);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  test('a bwrap seat with no public trust gets the jail without the public tool policy', async () => {
    const originalPlatform = process.platform;
    const { impl, calls } = makeSpawnImpl();
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      await claude.spawn('hi', {
        sessionId: null,
        cwd,
        env: { PATH: process.env.PATH },
        environment: { model: 'test-model', sandbox: { mode: 'bwrap' } },
        _spawnImpl: impl,
        _detectBwrap: () => ({ available: true, path: 'bwrap' }),
      });
      expect(calls).toHaveLength(1);
      const inner = calls[0].args.slice(calls[0].args.indexOf('--') + 1);
      expect(inner).not.toContain('--setting-sources');
      expect(inner).not.toContain('--permission-mode');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  test('a legacy trust=internal record is resolved as public and confined, never run unconfined', async () => {
    const originalPlatform = process.platform;
    const publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-internal-state-'));
    const { impl, calls } = makeSpawnImpl();
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      spawnSync.mockImplementation((cmd) => (
        cmd === 'which'
          ? { status: 0, stdout: '/usr/bin/true\n' }
          : { status: 0, stdout: '' }
      ));

      await claude.spawn('hi', {
        agentName: 'legacy-internal',
        sessionId: null,
        cwd,
        env: { PATH: process.env.PATH },
        environment: { model: 'test-model', sandbox: { mode: 'workspace', trust: 'internal' } },
        _publicClaudeState: publicState,
        _spawnImpl: impl,
      });

      // It reads as "confine me" and used to mean the opposite: before this the
      // adapter skipped Seatbelt entirely and spawned a bare, unconfined claude
      // (Vera 69592).
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('/usr/bin/sandbox-exec');
      expect(calls[0].args).toContain('--setting-sources');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      spawnSync.mockReset();
      fs.rmSync(publicState, { recursive: true, force: true });
    }
  });

  test('public trust with an unresolvable explicit mode refuses rather than falls through', async () => {
    const { impl, calls } = makeSpawnImpl();
    await expect(claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { model: 'test-model', sandbox: { mode: 'unconfined', trust: 'public' } },
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
      model: 'test-model',
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

  test('projected broker headers use a helper while the token stays out of Claude env', async () => {
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { model: 'test-model',
        mcp: [{
          name: 'github-grant',
          transport: 'http',
          url: 'https://api.commonly.me/api/mcp/grants/grant-live',
          headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
        }],
      },
      runtimeToken: 'cm_agent_test',
      _spawnImpl: impl,
    });

    const server = calls[0].config.mcpServers['github-grant'];
    expect(server.url).toBe('https://api.commonly.me/api/mcp/grants/grant-live');
    expect(server.headers).toBeUndefined();
    expect(typeof server.headersHelper).toBe('string');
    expect(JSON.stringify(calls[0].config)).not.toContain('cm_agent_test');
    expect(calls[0].opts.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(calls[0].opts.env.COMMONLY_TOKEN_FILE).toMatch(/\/token$/);
  });

  test('${COMMONLY_INSTANCE_URL} alias is supplied to native expansion', async () => {
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { model: 'test-model', mcp: [{ name: 'x', transport: 'stdio', command: ['m'], env: { U: '${COMMONLY_INSTANCE_URL}' } }] },
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
      environment: { model: 'test-model',
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
      environment: { model: 'test-model',
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
      environment: { model: 'test-model',
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

// A public seat runs with `--disable-slash-commands` ("Disable all skills") and
// `--setting-sources ''`, so the skill this adapter mounts never loaded there:
// a Bring your own page seat said "I don't see a skill named commonly" on
// 2026-10-19, and the same workspace with `--setting-sources project` found it.
// The declared text now rides as an appended system prompt while both flags stay.
describe('claude adapter — a public seat gets its declared skills as prompt text', () => {
  let cwd;
  let skillSrc;
  let publicState;
  const originalPlatform = process.platform;
  const appended = (args) => {
    const at = args.indexOf('--append-system-prompt');
    return at === -1 ? null : args[at + 1];
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-skill-prompt-'));
    publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-public-state-'));
    skillSrc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-skill-src-')), 'house-rules');
    fs.mkdirSync(skillSrc);
    fs.writeFileSync(
      path.join(skillSrc, 'SKILL.md'),
      '---\nname: house-rules\ndescription: How to behave in a pod.\n---\n\n# Being a member\n\nOrient before you post.\n',
      'utf8',
    );
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    spawnSync.mockImplementation((cmd) => (
      cmd === 'which' ? { status: 0, stdout: '/usr/bin/true\n' } : { status: 0, stdout: '' }
    ));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    for (const dir of [cwd, publicState, path.dirname(skillSrc)]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const publicSpawn = (impl, extra = {}) => claude.spawn('hi', {
    agentName: 'public-skill-test',
    sessionId: null,
    cwd,
    env: { PATH: process.env.PATH },
    environment: { model: 'test-model',
      sandbox: { mode: 'workspace', trust: 'public' },
      skills: { claude: [skillSrc] },
    },
    _publicClaudeState: publicState,
    _spawnImpl: impl,
    ...extra,
  });

  test('the skill body is appended, without its frontmatter, and skills stay disabled', async () => {
    const { impl, calls } = makeSpawnImpl();
    await publicSpawn(impl);

    expect(calls).toHaveLength(1);
    const { args } = calls[0];
    const text = appended(args);
    expect(text).toContain('## Skill: house-rules');
    expect(text).toContain('# Being a member\n\nOrient before you post.');
    expect(text).not.toContain('description: How to behave');
    expect(args).toContain('--disable-slash-commands');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  // D48 (TASK-545). A public seat has no subagent to spawn and works no board
  // rows, so its fresh session carries the memory cues and not the habits. The
  // legacy `internal` record reads as public, so it is held to the same line.
  // Seatbelt wraps argv and spends `-p` on its profile, so the prompt is found
  // by its content rather than by the flag.
  // A workspace seat holds its project read-only and is denied the Agent tool,
  // so both cues would teach it things it cannot do: parallel subagents, and
  // slicing a row before writing code.
  test.each(['public', 'internal', 'workspace'])('a fresh trust=%s seat is not taught the row-working habits', async (trust) => {
    const { impl, calls } = makeSpawnImpl();
    await publicSpawn(impl, {
      environment: { model: 'test-model',
        sandbox: { mode: 'workspace', trust },
        skills: { claude: [skillSrc] },
      },
    });

    expect(calls[0].cmd).toBe('/usr/bin/sandbox-exec');
    const promptArg = calls[0].args.find((arg) => String(arg).includes('=== Current turn ==='));
    expect(promptArg).toBeDefined();
    expect(promptArg).toContain('=== Fresh session ===');
    expect(promptArg).not.toContain('=== Working a row ===');
    expect(promptArg).not.toContain('Agent tool');
  });

  test('a private seat loads skills natively and gets no appended prompt', async () => {
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { model: 'test-model', skills: { claude: [skillSrc] } },
      _spawnImpl: impl,
    });

    expect(appended(calls[0].args)).toBeNull();
    expect(calls[0].args).not.toContain('--disable-slash-commands');
  });

  test('a public seat that declares no skills gets no appended prompt', async () => {
    const { impl, calls } = makeSpawnImpl();
    await publicSpawn(impl, {
      environment: { model: 'test-model', sandbox: { mode: 'workspace', trust: 'public' } },
    });

    expect(appended(calls[0].args)).toBeNull();
  });

  test('a declared skill with no SKILL.md is skipped, not fatal', async () => {
    fs.rmSync(path.join(skillSrc, 'SKILL.md'));
    const { impl, calls } = makeSpawnImpl();
    await publicSpawn(impl);

    expect(calls).toHaveLength(1);
    expect(appended(calls[0].args)).toBeNull();
  });

  // Vera on #2354: every arm above forces darwin, so dropping the bwrap
  // branch's carry alone stayed green. Linux public seats are bwrap seats.
  test('a public Linux (bwrap) seat carries the skill text inside the namespace', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', {
      agentName: 'public-skill-test',
      sessionId: null,
      cwd,
      env: { PATH: process.env.PATH },
      environment: { model: 'test-model', sandbox: { trust: 'public' }, skills: { claude: [skillSrc] } },
      _spawnImpl: impl,
      _detectBwrap: () => ({ available: true, path: 'bwrap' }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('bwrap');
    const inner = calls[0].args.slice(calls[0].args.indexOf('--') + 1);
    expect(appended(inner)).toContain('## Skill: house-rules');
    expect(inner).toContain('--disable-slash-commands');
  });

  // Linux caps one argv string at 128 KiB, so the inlined total is capped at
  // 96 KiB: a skill that would cross it is skipped, and later ones still fit.
  test('a skill over the 96 KiB total is skipped, and a later smaller one still inlines', async () => {
    const big = path.join(path.dirname(skillSrc), 'big-skill');
    fs.mkdirSync(big);
    fs.writeFileSync(path.join(big, 'SKILL.md'), `---\nname: big-skill\n---\n\n${'x'.repeat(100 * 1024)}\n`, 'utf8');
    const { impl, calls } = makeSpawnImpl();
    const onSkillsLinked = jest.fn();
    await publicSpawn(impl, {
      environment: { model: 'test-model',
        sandbox: { mode: 'workspace', trust: 'public' },
        skills: { claude: [big, skillSrc] },
      },
      onSkillsLinked,
    });

    const text = appended(calls[0].args);
    expect(text).not.toContain('## Skill: big-skill');
    expect(text).toContain('## Skill: house-rules');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(128 * 1024);
    expect(onSkillsLinked).toHaveBeenCalledWith({
      mounted: [skillSrc],
      conflicted: [{ path: big, reason: 'not-inlined' }],
    });
  });

  test('the fresh-session retry carries the same skill text', async () => {
    const calls = [];
    const impl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      const first = calls.length === 1;
      setTimeout(() => {
        if (first) proc.stderr.emit('data', Buffer.from('Error: Session ID abc-123 is already in use.'));
        else proc.stdout.emit('data', Buffer.from('recovered'));
        proc.emit('close', first ? 1 : 0);
      }, 0);
      return proc;
    };
    await publicSpawn(impl, { sessionId: 'abc-123' });

    expect(calls).toHaveLength(2);
    expect(appended(calls[1].args)).toBe(appended(calls[0].args));
    expect(appended(calls[1].args)).toContain('## Skill: house-rules');
  });
});

// TASK-294: a workspace seat is confined as a public one is, with the person's
// project held read-only, and nothing written into that project by the host.
describe('claude adapter — a workspace seat', () => {
  let cwd;
  let skillSrc;
  let publicState;
  let scratch;
  const originalPlatform = process.platform;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-workspace-'));
    publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-public-state-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-workspace-scratch-'));
    skillSrc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-skill-src-')), 'house-rules');
    fs.mkdirSync(skillSrc);
    fs.writeFileSync(
      path.join(skillSrc, 'SKILL.md'),
      '---\nname: house-rules\ndescription: How to behave in a pod.\n---\n\n# Being a member\n\nOrient before you post.\n',
      'utf8',
    );
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    spawnSync.mockImplementation((cmd) => (
      cmd === 'which' ? { status: 0, stdout: '/usr/bin/true\n' } : { status: 0, stdout: '' }
    ));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    for (const dir of [cwd, publicState, scratch, path.dirname(skillSrc)]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const workspaceSpawn = (impl, sandbox = { mode: 'workspace', trust: 'workspace' }) => claude.spawn('hi', {
    agentName: 'workspace-test',
    sessionId: null,
    cwd,
    skillMountDir: scratch,
    env: { PATH: process.env.PATH, COMMONLY_HOST_SECRET: 'must-not-inherit' },
    environment: { model: 'test-model',
      sandbox,
      skills: { claude: [skillSrc] },
      mcp: [{
        name: 'commonly',
        transport: 'stdio',
        command: [process.execPath, path.join(scratch, 'server.mjs')],
      }],
    },
    _publicClaudeState: publicState,
    _spawnImpl: impl,
  });

  test('runs in Seatbelt with its project read-only and the public tool policy', async () => {
    const { impl, calls } = makeSpawnImpl();
    await workspaceSpawn(impl);

    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0];
    expect(cmd).toBe('/usr/bin/sandbox-exec');
    const realCwd = fs.realpathSync(cwd);
    expect(args[1]).toContain(`(allow file-read* file-test-existence (subpath "${realCwd}"))`);
    expect(args[1]).not.toContain(`(allow file-read* file-test-existence file-write* (subpath "${realCwd}"))`);
    expect(args).toContain('Read(./**)');
    expect(args).toContain('mcp__commonly__*');
    const denied = args.slice(args.indexOf('--disallowedTools') + 1);
    expect(denied).toEqual(expect.arrayContaining([
      'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task',
      'Read(./.env)', 'Read(./.env.*)', 'mcp__commonly__commonly_self_install_into_pod',
    ]));
    expect(opts.env.HOME).toBe(publicState);
    expect(opts.env.COMMONLY_HOST_SECRET).toBeUndefined();
  });

  test('a public seat keeps the denies it had, without the workspace ones', async () => {
    const { impl, calls } = makeSpawnImpl();
    await workspaceSpawn(impl, { mode: 'workspace', trust: 'public' });

    const { args } = calls[0];
    expect(args).not.toContain('Read(./.env.*)');
    expect(args).not.toContain('mcp__commonly__commonly_self_install_into_pod');
    expect(args[1]).toContain(`(allow file-read* file-test-existence file-write* (subpath "${fs.realpathSync(cwd)}"))`);
  });

  test('its skills are copied to the scratch folder, never into the project, and arrive as prompt text', async () => {
    const { impl, calls } = makeSpawnImpl();
    await workspaceSpawn(impl);

    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(scratch, '.claude', 'skills', 'house-rules', 'SKILL.md'))).toBe(true);
    const { args } = calls[0];
    const text = args[args.indexOf('--append-system-prompt') + 1];
    expect(text).toContain('## Skill: house-rules');
  });

  test('without a scratch folder its skills are skipped rather than written into the project', async () => {
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', {
      agentName: 'workspace-test',
      sessionId: null,
      cwd,
      env: { PATH: process.env.PATH },
      environment: { model: 'test-model',
        sandbox: { mode: 'workspace', trust: 'workspace' },
        skills: { claude: [skillSrc] },
      },
      _publicClaudeState: publicState,
      _spawnImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false);
  });

  test('under bwrap it refuses to spawn', async () => {
    const { impl, calls } = makeSpawnImpl();
    await expect(workspaceSpawn(impl, { mode: 'bwrap', trust: 'workspace' }))
      .rejects.toThrow(/workspace Claude agents run on macOS only for now/);
    expect(calls).toHaveLength(0);
  });

  test('with an unenforced mode it refuses rather than falls through to a bare spawn', async () => {
    const { impl, calls } = makeSpawnImpl();
    await expect(workspaceSpawn(impl, { mode: 'none', trust: 'workspace' }))
      .rejects.toThrow(/workspace Claude agents require an enforced sandbox mode/);
    expect(calls).toHaveLength(0);
  });
});

describe('claude adapter — a workspace seat\'s git tool', () => {
  let cwd;
  let publicState;
  let fakeGitDirs;
  let realGit;
  let gitExecDir;
  const originalPlatform = process.platform;
  const serverPath = path.resolve('src/lib/git-readonly-server.js');

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-git-workspace-'));
    publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-git-state-'));
    // `git --exec-path` names a dir whose `git` links to the binary git runs,
    // which is what the jail must admit — never the link, never a shim.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-git-bin-'));
    gitExecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-git-exec-'));
    fakeGitDirs = [binDir, gitExecDir];
    const binary = path.join(binDir, 'git');
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(binary, path.join(gitExecDir, 'git'));
    realGit = fs.realpathSync(binary);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    jest.restoreAllMocks();
    for (const dir of [cwd, publicState, ...fakeGitDirs]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const gitOnMachine = (execDir) => spawnSync.mockImplementation((cmd, args) => {
    if (cmd === 'which') return { status: 0, stdout: '/usr/bin/true\n' };
    if (cmd === 'git' && args?.[0] === '--exec-path') {
      return execDir ? { status: 0, stdout: `${execDir}\n` } : { status: 1, stdout: '' };
    }
    return { status: 0, stdout: '' };
  });

  const seatSpawn = (impl, trust) => claude.spawn('hi', {
    agentName: 'workspace-git-test',
    sessionId: null,
    cwd,
    env: { PATH: process.env.PATH },
    environment: {
      model: 'test-model',
      sandbox: { mode: 'workspace', trust },
      mcp: [{ name: 'commonly', transport: 'stdio', command: [process.execPath, path.join(cwd, 'server.mjs')] }],
    },
    _publicClaudeState: publicState,
    _spawnImpl: impl,
  });

  test('gets one read-only git tool, whose server code and real git binary the jail admits', async () => {
    gitOnMachine(gitExecDir);
    const { impl, calls } = makeSpawnImpl();
    await seatSpawn(impl, 'workspace');

    expect(calls).toHaveLength(1);
    const { args, config } = calls[0];
    expect(config.mcpServers.workspace_git).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: [serverPath, '--root', cwd, '--git', realGit],
    });
    expect(fs.existsSync(serverPath)).toBe(true);
    expect(args.slice(args.indexOf('--allowedTools'))).toContain('mcp__workspace_git__*');
    const profile = args[1];
    expect(profile).toContain(`(allow file-read* file-test-existence file-map-executable (literal "${realGit}"))`);
    expect(profile).toContain(`(allow file-read* file-test-existence (subpath "${fs.realpathSync(path.dirname(serverPath))}"))`);
    expect(profile).toContain(`(allow file-read* file-test-existence (literal "${fs.realpathSync(path.resolve('package.json'))}"))`);
  });

  test('a public seat gets no git tool, even on a machine with git', async () => {
    gitOnMachine(gitExecDir);
    const { impl, calls } = makeSpawnImpl();
    await seatSpawn(impl, 'public');

    expect(calls).toHaveLength(1);
    expect(calls[0].config.mcpServers.workspace_git).toBeUndefined();
    expect(calls[0].args).not.toContain('mcp__workspace_git__*');
    expect(calls[0].args[1]).not.toContain(realGit);
  });

  test('without git on the machine, a workspace seat still runs, with no git tool', async () => {
    gitOnMachine(null);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { impl, calls } = makeSpawnImpl();
    await seatSpawn(impl, 'workspace');

    expect(calls).toHaveLength(1);
    expect(calls[0].config.mcpServers.workspace_git).toBeUndefined();
    expect(calls[0].args[1]).not.toContain(fs.realpathSync(path.dirname(serverPath)));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('git was not found'));
  });
});
