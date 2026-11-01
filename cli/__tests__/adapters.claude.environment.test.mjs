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

const makeSpawnImpl = ({ code = 0, stdout = 'ok' } = {}) => {
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
    return fakeChild({ stdout, code });
  };
  return { impl, calls };
};

// A public seat's turn posts only on a stream whose init shows Commonly connected (TASK-256).
const COMMONLY_CONNECTED = [
  { type: 'system', subtype: 'init', mcp_servers: [{ name: 'commonly', status: 'connected' }] },
  { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
].map((event) => JSON.stringify(event)).join('\n');

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
      // TASK-287: a public seat is not offered attach_file.
      expect(call.args.slice(call.args.indexOf('--disallowedTools')))
        .toContain('mcp__capture__commonly_attach_file');
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

  // #2247: the refusal must hold for every public seat, whatever
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
    const { impl, calls } = makeSpawnImpl({ stdout: COMMONLY_CONNECTED });
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

  // A mode-less public block used to fall straight through to the
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
      // that happened to be on the other side of a branch.
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
      // adapter skipped Seatbelt entirely and spawned a bare, unconfined claude.
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

  // TASK-545. A public seat has no subagent to spawn and works no board
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

  // #2354: every arm above forces darwin, so dropping the bwrap
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

  const workspaceSpawn = (impl, sandbox = { mode: 'workspace', trust: 'workspace' }, extra = {}) => claude.spawn('hi', {
    ...extra,
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
      'Read(./.env)', 'Read(./.env.*)', 'Read(./**/.env)', 'Read(./**/.env.*)',
      'Read(./.env/**)', 'Read(./**/.env/**)', 'Read(./**/.env.*/**)',
      'Read(./.git/**)', 'Read(./**/.git/**)',
      'mcp__commonly__commonly_self_install_into_pod',
    ]));
    // Workspace seats follow the same list as public ones (TASK-287).
    expect(denied).toContain('mcp__commonly__commonly_attach_file');
    expect(opts.env.HOME).toBe(publicState);
    expect(opts.env.COMMONLY_HOST_SECRET).toBeUndefined();
  });

  test('a workspace seat\'s turn that runs public gets no memory and no memory tool', async () => {
    const memoryTools = ['mcp__commonly__commonly_read_agent_memory', 'mcp__commonly__commonly_write_agent_memory',
      'mcp__commonly__commonly_save_my_memory'];
    const withheld = makeSpawnImpl();
    await workspaceSpawn(withheld.impl, { mode: 'workspace', trust: 'public' }, {
      memoryWithheld: true, memoryLongTerm: 'notes from the project',
    });
    const { args } = withheld.calls[0];
    const denied = args.slice(args.indexOf('--disallowedTools') + 1);
    expect(denied).toEqual(expect.arrayContaining(memoryTools));
    // The last -p: sandbox-exec's own -p carries the profile.
    const prompt = args[args.lastIndexOf('-p') + 1];
    expect(prompt).toContain('withheld this turn');
    expect(prompt).not.toContain('notes from the project');
    expect(prompt).not.toContain('(empty');

    // Control: the same public spawn, not withheld, injects the memory and keeps the tools.
    const kept = makeSpawnImpl();
    await workspaceSpawn(kept.impl, { mode: 'workspace', trust: 'public' }, { memoryLongTerm: 'notes from the project' });
    const keptArgs = kept.calls[0].args;
    expect(keptArgs[keptArgs.lastIndexOf('-p') + 1]).toContain('notes from the project');
    for (const tool of memoryTools) expect(keptArgs).not.toContain(tool);
  });

  test('a public seat keeps the denies it had, without the workspace ones', async () => {
    const { impl, calls } = makeSpawnImpl();
    await workspaceSpawn(impl, { mode: 'workspace', trust: 'public' });

    const { args } = calls[0];
    expect(args).not.toContain('Read(./.env.*)');
    expect(args).not.toContain('Read(./.git/**)');
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

  const toolLists = (args) => ({
    allowed: args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')),
    denied: args.slice(args.indexOf('--disallowedTools') + 1),
  });

  test('a write grant hands it Edit, Write and Bash and a writable project, with .git held read-only', async () => {
    const { impl, calls } = makeSpawnImpl();
    await workspaceSpawn(impl, { mode: 'workspace', trust: 'workspace', allow: ['write'] });

    const { args } = calls[0];
    const { allowed, denied } = toolLists(args);
    expect(allowed).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']));
    expect(denied).not.toContain('Edit');
    expect(denied).not.toContain('Write');
    expect(denied).not.toContain('Bash');
    expect(denied).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'Read(./.env.*)']));
    const realCwd = fs.realpathSync(cwd);
    expect(args[1]).toContain(`(allow file-read* file-test-existence file-write* (subpath "${realCwd}"))`);
    expect(args[1]).toContain(`(deny file-write* (subpath "${path.join(realCwd, '.git')}"))`);
  });

  test('a web grant hands it WebFetch alone, with the project still read-only', async () => {
    const { impl, calls } = makeSpawnImpl();
    await workspaceSpawn(impl, { mode: 'workspace', trust: 'workspace', allow: ['web'] });

    const { args } = calls[0];
    const { allowed, denied } = toolLists(args);
    expect(allowed).toContain('WebFetch');
    expect(denied).not.toContain('WebFetch');
    expect(denied).toEqual(expect.arrayContaining(['WebSearch', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'Task']));
    expect(args[1]).not.toContain(`file-write* (subpath "${fs.realpathSync(cwd)}"))`);
  });

  test('a public seat whose record carries grants gets none of them', async () => {
    const { impl, calls } = makeSpawnImpl();
    await workspaceSpawn(impl, { mode: 'workspace', trust: 'public', allow: ['write', 'web'] });

    const { allowed, denied } = toolLists(calls[0].args);
    for (const tool of ['Edit', 'Write', 'Bash', 'WebFetch']) {
      expect(allowed).not.toContain(tool);
      expect(denied).toContain(tool);
    }
  });

  test('under bwrap on a Mac it refuses before preparing any state', async () => {
    const { impl, calls } = makeSpawnImpl();
    await expect(workspaceSpawn(impl, { mode: 'bwrap', trust: 'workspace' }))
      .rejects.toThrow(/workspace Claude agents require bwrap: bwrap is Linux-only/);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(publicState)).toEqual([]);
  });

  test('with an unenforced mode it refuses rather than falls through to a bare spawn', async () => {
    const { impl, calls } = makeSpawnImpl();
    await expect(workspaceSpawn(impl, { mode: 'none', trust: 'workspace' }))
      .rejects.toThrow(/workspace Claude agents require an enforced sandbox mode/);
    expect(calls).toHaveLength(0);
  });
});

// A workspace seat on Linux runs under bwrap. bwrap used to make the project
// its HOME, so its transcripts landed in the person's project and it had no
// login, and the adapter refused the combination. The seat now gets the same
// per-seat state folder macOS uses, outside the project, with a copy of the
// person's Claude login in it.
describe('claude adapter — a workspace seat on Linux', () => {
  const originalPlatform = process.platform;
  let cwd;
  let state;
  let operatorClaude;
  const login = '{"claudeAiOauth":{"accessToken":"test-only"}}\n';

  let claudeInstall;
  // `which claude` answers with a real file, as on a host with Claude Code
  // installed; the jail binds its folder.
  const whichFinds = (bin) => spawnSync.mockImplementation((cmd) => (cmd === 'which'
    ? { status: 0, stdout: `${bin}\n` } : undefined));

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-linux-ws-'));
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-linux-state-'));
    operatorClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-linux-login-'));
    claudeInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-linux-install-'));
    fs.writeFileSync(path.join(claudeInstall, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(operatorClaude, '.credentials.json'), login, { mode: 0o600 });
    whichFinds(path.join(claudeInstall, 'claude'));
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    for (const dir of [cwd, state, operatorClaude, claudeInstall]) fs.rmSync(dir, { recursive: true, force: true });
  });

  // TASK-027: a jail that cannot carry claude fails closed before the login
  // is copied, never spawning a namespace claude cannot start in.
  test.each([
    ['not on PATH', () => spawnSync.mockImplementation(() => undefined), /`claude` could not be resolved/],
    ['a dangling link', () => whichFinds(path.join(os.tmpdir(), 'cli-claude-missing', 'claude')), /cli-claude-missing\/claude` could not be resolved/],
  ])('refuses when claude is %s, before the login is copied', async (_label, arrange, message) => {
    arrange();
    const { impl, calls } = childImpl();
    await expect(linuxSpawn(impl)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(state, '.claude', '.credentials.json'))).toBe(false);
  });

  test('binds the folder claude is installed in, read-only', async () => {
    const { impl, calls } = childImpl();
    await linuxSpawn(impl);
    expect(calls).toHaveLength(1);
    const outer = calls[0].args.slice(0, calls[0].args.indexOf('--'));
    const binds = outer.flatMap((arg, i) => (/^--ro-bind/.test(arg) ? [outer[i + 1]] : []));
    expect(binds).toContain(fs.realpathSync(claudeInstall));
  });

  // Plays the child: it looks for its login under the HOME it was given and
  // writes its transcript there, as claude does.
  const childImpl = () => {
    const calls = [];
    const impl = (cmd, args, opts) => {
      // bwrap sets the child's HOME with --setenv; that is the one it sees.
      const home = args[args.indexOf('HOME') + 1];
      const loginPath = path.join(home, '.claude', '.credentials.json');
      const foundLogin = fs.existsSync(loginPath) ? fs.readFileSync(loginPath, 'utf8') : null;
      const sid = args[args.indexOf('--session-id') + 1];
      const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 40 } },
      })}\n`);
      calls.push({ cmd, args, opts, foundLogin });
      return fakeChild({ stdout: 'ok' });
    };
    return { impl, calls };
  };

  const linuxSpawn = (impl, sandbox = { trust: 'workspace' }, env = {}) => claude.spawn('hi', {
    agentName: 'linux-workspace-test',
    sessionId: null,
    cwd,
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: operatorClaude, ...env },
    environment: { model: 'test-model', sandbox },
    memoryLongTerm: '',
    _publicClaudeState: state,
    _detectBwrap: () => ({ available: true, path: 'bwrap' }),
    _spawnImpl: impl,
  });

  const flagTriples = (args, flag) => args.flatMap((arg, i) => (
    arg === flag ? [[args[i + 1], args[i + 2]]] : []
  ));

  test('runs in bwrap with a HOME outside the project, finds its login, and writes nothing into the project', async () => {
    const { impl, calls } = childImpl();
    const res = await linuxSpawn(impl);

    expect(calls).toHaveLength(1);
    const { cmd, args, opts, foundLogin } = calls[0];
    expect(cmd).toBe('bwrap');
    const outer = args.slice(0, args.indexOf('--'));
    expect(outer.slice(outer.indexOf('HOME') - 1, outer.indexOf('HOME') + 2))
      .toEqual(['--setenv', 'HOME', state]);
    expect(opts.env.HOME).toBe(state);
    expect(opts.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // The state folder is the only writable bind; with no write grant the
    // project is read-only.
    expect(flagTriples(outer, '--bind')).toEqual([[state, state]]);
    expect(flagTriples(outer, '--ro-bind')).toContainEqual([cwd, cwd]);

    expect(foundLogin).toBe(login);
    const copy = path.join(state, '.claude', '.credentials.json');
    expect(fs.lstatSync(copy).isFile()).toBe(true);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(state, '.claude')).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(cwd)).toEqual([]);
    // TASK-440 reads the transcript from the HOME the child wrote under.
    expect(res.contextTokens).toBe(43);

    // The seat runs the workspace tier's policy, not the public seat's.
    const inner = args.slice(args.indexOf('--') + 1);
    expect(inner).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
    expect(inner.join(' ')).toContain('Read(./.env)');
  });

  // TASK-284: the host env stays outside the jail. The CLAUDE_CONFIG_DIR check
  // above covers one key; a spawn that dropped that key and kept the rest of
  // the host env passed it. This one plants secrets and pins the whole set.
  test('gets only the safe part of the host env, never its secrets', async () => {
    const planted = {
      AWS_SECRET_ACCESS_KEY: 'host-secret', GH_TOKEN: 'host-secret', OPENAI_API_KEY: 'host-secret',
    };
    const { impl, calls } = childImpl();
    await linuxSpawn(impl, { trust: 'workspace' }, { ...planted, LANG: 'C.UTF-8' });

    expect(calls).toHaveLength(1);
    const { args, opts } = calls[0];
    expect(Object.keys(opts.env).sort()).toEqual([
      'CLAUDE_CODE_TMPDIR', 'HOME', 'LANG', 'PATH', 'TMPDIR',
      'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    ]);
    expect(Object.values(opts.env)).not.toContain('host-secret');
    // Nor through bwrap's argv: --setenv carries HOME and nothing else.
    expect(args).not.toContain('host-secret');
    expect(flagTriples(args, '--setenv')).toEqual([['HOME', state]]);
  });

  test('a write grant makes the project writable and keeps its .git read-only', async () => {
    const gitDir = path.join(cwd, '.git');
    fs.mkdirSync(gitDir);
    const { impl, calls } = childImpl();
    await linuxSpawn(impl, { trust: 'workspace', allow: ['write'] });

    const outer = calls[0].args.slice(0, calls[0].args.indexOf('--'));
    expect(flagTriples(outer, '--bind')).toEqual([[state, state], [cwd, cwd]]);
    // Strict, not -try: a .git that vanished must stop bwrap, not go unbound.
    expect(flagTriples(outer, '--ro-bind')).toContainEqual([gitDir, gitDir]);
    // .git is bound after the project, so it lands on top of it.
    const bindAt = (flag, p) => outer.findIndex((arg, i) => arg === flag && outer[i + 1] === p);
    expect(bindAt('--ro-bind', gitDir)).toBeGreaterThan(bindAt('--bind', cwd));
  });

  test('a write grant on a project with no .git refuses, and creates nothing in it', async () => {
    const { impl, calls } = childImpl();
    await expect(linuxSpawn(impl, { trust: 'workspace', allow: ['write'] }))
      .rejects.toThrow(/need the project to be a git repository/);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  test('a write grant refuses a .git that is a symlink', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-linux-git-'));
    try {
      fs.symlinkSync(elsewhere, path.join(cwd, '.git'));
      const { impl, calls } = childImpl();
      await expect(linuxSpawn(impl, { trust: 'workspace', allow: ['write'] }))
        .rejects.toThrow(/need the project to be a git repository/);
      expect(calls).toHaveLength(0);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('without a write grant a project with no .git still runs, read-only', async () => {
    const { impl, calls } = childImpl();
    await linuxSpawn(impl);
    const outer = calls[0].args.slice(0, calls[0].args.indexOf('--'));
    expect(flagTriples(outer, '--ro-bind')).toContainEqual([cwd, cwd]);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  test('refuses a login that is a symlink, and spawns nothing', async () => {
    const real = path.join(operatorClaude, 'elsewhere.json');
    fs.renameSync(path.join(operatorClaude, '.credentials.json'), real);
    fs.symlinkSync(real, path.join(operatorClaude, '.credentials.json'));
    const { impl, calls } = childImpl();

    await expect(linuxSpawn(impl)).rejects.toThrow(/refusing a Claude login that is not a regular file/);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(state, '.claude', '.credentials.json'))).toBe(false);
  });

  test('refuses a login that is not a regular file, checked on the opened file', async () => {
    const login = path.join(operatorClaude, '.credentials.json');
    fs.rmSync(login);
    fs.mkdirSync(login);
    const { impl, calls } = childImpl();
    await expect(linuxSpawn(impl)).rejects.toThrow(/refusing a Claude login that is not a regular file/);
    expect(calls).toHaveLength(0);
  });

  test('replaces a symlink the jail left at the copy, rather than writing through it', async () => {
    const victim = path.join(operatorClaude, 'victim.txt');
    fs.writeFileSync(victim, 'untouched');
    fs.mkdirSync(path.join(state, '.claude'), { mode: 0o700 });
    fs.symlinkSync(victim, path.join(state, '.claude', '.credentials.json'));
    const { impl, calls } = childImpl();

    await linuxSpawn(impl);
    expect(calls[0].foundLogin).toBe(login);
    expect(fs.lstatSync(path.join(state, '.claude', '.credentials.json')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
  });

  test('a person who logged out is not still signed in here', async () => {
    fs.rmSync(path.join(operatorClaude, '.credentials.json'));
    fs.mkdirSync(path.join(state, '.claude'), { mode: 0o700 });
    fs.writeFileSync(path.join(state, '.claude', '.credentials.json'), login, { mode: 0o600 });
    const { impl, calls } = childImpl();

    await linuxSpawn(impl);
    expect(calls[0].foundLogin).toBeNull();
  });

  test('a host with no usable bwrap refuses before preparing any state', async () => {
    const { impl, calls } = childImpl();
    await expect(claude.spawn('hi', {
      agentName: 'linux-workspace-test',
      sessionId: null,
      cwd,
      env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: operatorClaude },
      environment: { model: 'test-model', sandbox: { trust: 'workspace' } },
      _publicClaudeState: state,
      _detectBwrap: () => ({ available: false, error: 'bwrap not found on PATH.' }),
      _spawnImpl: impl,
    })).rejects.toThrow(/workspace Claude agents require bwrap: bwrap not found/);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(state)).toEqual([]);
  });

  test('a public Linux seat keeps its old jail: the project is its HOME and nothing else is writable', async () => {
    const { impl, calls } = childImpl();
    await linuxSpawn(impl, { trust: 'public' });

    const outer = calls[0].args.slice(0, calls[0].args.indexOf('--'));
    expect(outer.slice(outer.indexOf('HOME') - 1, outer.indexOf('HOME') + 2))
      .toEqual(['--setenv', 'HOME', cwd]);
    expect(flagTriples(outer, '--bind')).toEqual([[cwd, cwd]]);
    expect(fs.readdirSync(state)).toEqual([]);
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

// TASK-256: a public seat posts only when its own stream shows the Commonly MCP
// working. The stream shapes are the ones Claude Code 2.1.314 wrote against a
// stub MCP server: `mcp_servers[].status` in init, and a failed call as a
// `tool_result` with `is_error: true` whose content is the server's text.
describe('claude adapter: the public seat Commonly MCP witness (TASK-256)', () => {
  const COMMONLY_MCP = [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }];
  const stream = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
  const init = (status) => ({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'commonly', status }] });
  const call = (id, name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
  const failed = (id, content) => ({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] },
  });
  const succeeded = (id, content = '[]') => ({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  const result = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text });
  const API_503 = JSON.stringify({ status: 503, body: '<html>503 Service Unavailable</html>', message: 'HTTP 503' });
  const API_404 = JSON.stringify({ status: 404, body: { error: 'Pod not found' }, message: 'Pod not found' });

  let cwd;
  let home;
  let publicState;
  let prior;
  const originalPlatform = process.platform;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-witness-'));
    publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-public-state-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-mcp-home-'));
    const pkgDir = path.join(home, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
    }));
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.js'), '');
    fs.writeFileSync(path.join(home, 'current'), '0.3.13\n');
    prior = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = home;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    spawnSync.mockImplementation((cmd) => (cmd === 'which'
      ? { status: 0, stdout: '/usr/bin/true\n' } : { status: 0, stdout: '' }));
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
    else process.env.COMMONLY_MCP_HOME = prior;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    for (const dir of [cwd, publicState, home]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const turn = (stdout, { trust = 'public', mcp = COMMONLY_MCP, impl = makeSpawnImpl({ stdout }).impl, sessionId } = {}) => (
    claude.spawn('hi', {
      agentName: 'public-test', cwd, ...(sessionId ? { sessionId } : {}),
      env: { PATH: process.env.PATH, USER: 'safe-user', LOGNAME: 'safe-user' },
      environment: { model: 'test-model', ...(trust ? { sandbox: { mode: 'workspace', trust } } : {}), mcp },
      _publicClaudeState: publicState,
      _spawnImpl: impl,
    })
  );

  test('posts when init shows Commonly connected and no Commonly call failed', async () => {
    await expect(turn(stream(init('connected'), result('Here you go.')))).resolves.toMatchObject({ text: 'Here you go.' });
  });

  test.each([
    ['the server failed to start', stream(init('failed'), result('HELLO')), /status failed/],
    ['the stream carries no init event', stream(result('HELLO')), /no init event/],
    ['the output is plain text', 'HELLO', /no init event/],
  ])('withholds the turn when %s', async (_label, stdout, reason) => {
    const outcome = turn(stdout);
    await expect(outcome).rejects.toMatchObject({ code: 'public_mcp_not_ready' });
    await expect(outcome).rejects.toThrow(reason);
  });

  test.each([
    ['an API 503', API_503],
    ['a transport error with no status', 'MCP error -32000: Connection closed'],
    ['an empty error', ''],
    ['an error as text parts', [{ type: 'text', text: API_503 }]],
  ])('withholds the turn when a Commonly call fails with %s', async (_label, content) => {
    const stdout = stream(init('connected'), call('t1', 'mcp__commonly__list_pods'), failed('t1', content), result('Every call is failing.'));
    await expect(turn(stdout)).rejects.toMatchObject({ code: 'public_tool_failed' });
  });

  // `pending` at init is not a failure: the server may finish starting during
  // the turn. Only a Commonly call that returned shows it working, so that is
  // the evidence a pending server needs.
  test('posts when init shows Commonly pending and a Commonly call then returned', async () => {
    const stdout = stream(init('pending'), call('t1', 'mcp__commonly__list_pods'), succeeded('t1'), result('Two pods.'));
    await expect(turn(stdout)).resolves.toMatchObject({ text: 'Two pods.' });
  });

  test.each([
    ['no Commonly call was made', stream(init('pending'), result('HELLO'))],
    ['only another server\'s call returned', stream(init('pending'), call('t1', 'mcp__other__ping'), succeeded('t1'), result('HELLO'))],
  ])('withholds the turn when init shows Commonly pending and %s', async (_label, stdout) => {
    const outcome = turn(stdout);
    await expect(outcome).rejects.toMatchObject({ code: 'public_mcp_not_ready' });
    await expect(outcome).rejects.toThrow(/status pending/);
  });

  test('withholds a pending server whose Commonly call failed, even beside one that returned', async () => {
    const stdout = stream(
      init('pending'),
      call('t1', 'mcp__commonly__list_pods'), succeeded('t1'),
      call('t2', 'mcp__commonly__read_context'), failed('t2', API_503),
      result('Every call is failing.'),
    );
    await expect(turn(stdout)).rejects.toMatchObject({ code: 'public_tool_failed' });
  });

  test('posts an answer to a refusal the person can be told about (a 404)', async () => {
    const stdout = stream(init('connected'), call('t1', 'mcp__commonly__read_context'), failed('t1', API_404), result('I cannot see that pod.'));
    await expect(turn(stdout)).resolves.toMatchObject({ text: 'I cannot see that pod.' });
  });

  test('withholds a failed call from a server whose name Claude Code normalises in tool names', async () => {
    const mcp = [{ ...COMMONLY_MCP[0], name: 'commonly.me' }];
    const stdout = stream(
      { type: 'system', subtype: 'init', mcp_servers: [{ name: 'commonly.me', status: 'connected' }] },
      call('t1', 'mcp__commonly_me__list_pods'), failed('t1', API_503), result('Every call is failing.'),
    );
    await expect(turn(stdout, { mcp })).rejects.toMatchObject({ code: 'public_tool_failed' });
  });

  test('the fresh-session retry is witnessed too', async () => {
    // The resumed session is refused, the retry runs fresh, and its server failed.
    let spawns = 0;
    const impl = () => {
      spawns += 1;
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      const first = spawns === 1;
      setTimeout(() => {
        if (first) proc.stderr.emit('data', Buffer.from('Error: Session ID abc-123 is already in use.'));
        else proc.stdout.emit('data', Buffer.from(stream(init('failed'), result('HELLO'))));
        proc.emit('close', first ? 1 : 0);
      }, 0);
      return proc;
    };
    await expect(turn('', { impl, sessionId: 'abc-123' })).rejects.toMatchObject({ code: 'public_mcp_not_ready' });
    expect(spawns).toBe(2);
  });

  test("ignores another server's failed call", async () => {
    const stdout = stream(init('connected'), call('t1', 'mcp__other__lookup'), failed('t1', API_503), result('Done.'));
    await expect(turn(stdout)).resolves.toMatchObject({ text: 'Done.' });
  });

  // As in the OpenCode check: only the shipped server's error contract is known,
  // so a server run some other way is not judged by it.
  test('a seat that does not run the shipped Commonly MCP is not witnessed', async () => {
    const mcp = [{ name: 'commonly', transport: 'stdio', command: ['commonly-mcp'] }];
    await expect(turn(stream(init('failed'), result('HELLO')), { mcp })).resolves.toMatchObject({ text: 'HELLO' });
  });

  // A record still carrying `internal` is read as public (environment.js), so it is witnessed.
  test('a legacy internal-trust seat is witnessed as public', async () => {
    await expect(turn(stream(init('failed'), result('HELLO')), { trust: 'internal' }))
      .rejects.toMatchObject({ code: 'public_mcp_not_ready' });
  });

  test.each([['a workspace seat', 'workspace'], ['an unconfined seat', null]])('%s is not witnessed', async (_label, trust) => {
    await expect(turn(stream(init('failed'), result('HELLO')), { trust })).resolves.toMatchObject({ text: 'HELLO' });
  });
});
