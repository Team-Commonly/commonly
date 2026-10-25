import {
  mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import {
  buildSeatbeltProfile,
  detectSeatbelt,
  wrapArgvWithSeatbelt,
} from '../src/lib/sandbox/seatbelt.js';

describe('macOS Seatbelt profile', () => {
  let root;
  let workspace;
  let state;
  let mcp;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'commonly-seatbelt-test-'));
    workspace = join(root, 'workspace');
    state = join(root, 'state');
    mcp = join(root, 'mcp');
    for (const path of [workspace, state, mcp]) {
      mkdirSync(path, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('builds a deny-default write profile with only explicit dynamic roots', () => {
    const profile = buildSeatbeltProfile({
      workspacePath: workspace,
      workspaceAccess: 'write',
      executablePath: '/usr/bin/true',
      statePath: state,
      mcpConfigDir: mcp,
      executablePaths: [process.execPath],
    });
    const resolvedWorkspace = realpathSync(workspace);
    const resolvedState = realpathSync(state);
    const resolvedMcp = realpathSync(mcp);

    expect(profile).toContain('(deny default)');
    expect(profile).not.toContain('(allow default)');
    expect(profile).toContain(
      `(allow file-read* file-test-existence file-write* (subpath "${resolvedWorkspace}"))`,
    );
    expect(profile).toContain(
      `(allow file-read* file-test-existence file-write* (subpath "${resolvedState}"))`,
    );
    expect(profile).toContain(
      `(allow file-read* file-test-existence (subpath "${resolvedMcp}"))`,
    );
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${join(resolvedWorkspace, '.commonly')}"))`,
    );
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${join(resolvedWorkspace, '.codex')}"))`,
    );
    expect(profile).not.toContain(`(subpath "${process.env.HOME}")`);
  });

  test('read-only mode never grants workspace writes', () => {
    const profile = buildSeatbeltProfile({
      workspacePath: workspace,
      workspaceAccess: 'read',
      executablePath: '/usr/bin/true',
      statePath: state,
    });
    const resolvedWorkspace = realpathSync(workspace);

    expect(profile).toContain(
      `(allow file-read* file-test-existence (subpath "${resolvedWorkspace}"))`,
    );
    expect(profile).not.toContain(
      `(allow file-read* file-test-existence file-write* (subpath "${resolvedWorkspace}"))`,
    );
  });

  // TASK-294: a workspace seat granted write keeps its project's .git
  // read-only, so every change it makes shows in `git status`.
  test('a writable workspace can hold named entries read-only', () => {
    const profile = buildSeatbeltProfile({
      workspacePath: workspace,
      workspaceAccess: 'write',
      executablePath: '/usr/bin/true',
      statePath: state,
      readOnlyWorkspaceEntries: ['.git'],
    });
    const resolvedWorkspace = realpathSync(workspace);

    expect(profile).toContain(
      `(allow file-read* file-test-existence file-write* (subpath "${resolvedWorkspace}"))`,
    );
    expect(profile).toContain(`(deny file-write* (subpath "${join(resolvedWorkspace, '.git')}"))`);
    // The deny must come after the allow it narrows: in SBPL the last match wins.
    expect(profile.indexOf(`(deny file-write* (subpath "${join(resolvedWorkspace, '.git')}"))`))
      .toBeGreaterThan(profile.indexOf(`file-write* (subpath "${resolvedWorkspace}"))`));
  });

  test('a symlinked read-only entry is held at its target too', () => {
    const target = join(root, 'elsewhere-git');
    mkdirSync(target);
    symlinkSync(target, join(workspace, '.git'));
    const profile = buildSeatbeltProfile({
      workspacePath: workspace,
      workspaceAccess: 'write',
      executablePath: '/usr/bin/true',
      statePath: state,
      readOnlyWorkspaceEntries: ['.git'],
    });

    expect(profile).toContain(`(deny file-write* (subpath "${join(realpathSync(workspace), '.git')}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${realpathSync(target)}"))`);
  });

  test.each(['', '.', '..', 'a/b', '../x', 7])('rejects %p as a read-only workspace entry', (entry) => {
    expect(() => buildSeatbeltProfile({
      workspacePath: workspace,
      workspaceAccess: 'write',
      executablePath: '/usr/bin/true',
      statePath: state,
      readOnlyWorkspaceEntries: [entry],
    })).toThrow(/readOnlyWorkspaceEntries entries must be names inside the workspace/);
  });

  test('OpenCode config roots remain read-only in the generated profile', () => {
    const configRoot = join(root, 'opencode-temp');
    const configDir = join(configRoot, 'config-dir');
    const xdgConfigHome = join(configRoot, 'xdg-config');
    const xdgConfigDir = join(xdgConfigHome, 'opencode');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(xdgConfigDir, { recursive: true });
    const profile = buildSeatbeltProfile({
      workspacePath: workspace,
      workspaceAccess: 'write',
      executablePath: '/usr/bin/true',
      statePath: state,
      mcpConfigDir: configRoot,
    });
    const writableRules = profile.split('\n')
      .filter((line) => line.includes('file-write*'))
      .join('\n');

    // A write rule for any ancestor of these config directories would cover
    // them too, so pin the whole per-spawn config root as non-writable.
    for (const path of [configRoot, configDir, xdgConfigHome, xdgConfigDir]) {
      expect(writableRules).not.toContain(realpathSync(path));
    }
  });

  test('admits only the explicit provider auth file outside public seat state', () => {
    const authFile = join(root, 'operator-data', 'opencode', 'auth.json');
    mkdirSync(join(root, 'operator-data', 'opencode'), { recursive: true });
    writeFileSync(authFile, 'dummy-auth');
    const profile = buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
      readOnlyPaths: [authFile],
    });

    const resolvedAuthFile = realpathSync(authFile);
    expect(profile).toContain(`(allow file-read* file-test-existence (literal "${resolvedAuthFile}"))`);
    expect(profile).not.toContain(`file-write* (literal "${resolvedAuthFile}")`);
  });

  test('adds an exact loopback allow rule for the per-spawn provider proxy port', () => {
    const port = 54321;
    const baseline = buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
      mcpConfigDir: mcp,
    });
    const withProxyPort = buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
      mcpConfigDir: mcp,
      loopbackNetworkPorts: [port],
    });
    const baselineLines = new Set(baseline.split('\n').filter(Boolean));
    const addedRules = withProxyPort.split('\n').filter((line) => line && !baselineLines.has(line));
    expect(addedRules).toEqual([
      `(allow network-outbound (remote tcp "localhost:${port}"))`,
    ]);
    expect(() => buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
      loopbackNetworkPorts: [0],
    })).toThrow(/valid TCP ports/);
  });

  test('Claude gets the login-keychain file on request, and never the shared Claude temp root', () => {
    const keychains = join(homedir(), 'Library', 'Keychains');
    const claudeTmp = `/private/tmp/claude-${typeof process.getuid === 'function' ? process.getuid() : '0'}`;
    const profile = buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
    });
    expect(profile).not.toContain(keychains);
    expect(profile).not.toContain(claudeTmp);

    const claudeProfile = buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
      allowClaudeRuntimeAccess: true,
    });
    // The one database Claude's login reads, not the folder of keychains.
    expect(claudeProfile).toContain(`(literal "${join(keychains, 'login.keychain-db')}")`);
    expect(claudeProfile).not.toContain(`(subpath "${keychains}")`);
    // Every Claude session on the machine keeps its temp files under this
    // root; the seat uses its own (CLAUDE_CODE_TMPDIR under statePath).
    expect(claudeProfile).not.toContain(claudeTmp);
  });

  test('admits user preferences only through a domain filter', () => {
    // Top-level SBPL forms, skipping comment lines and quoted strings (regex
    // strings in the baseline contain parentheses).
    const sbplRules = (profile) => {
      const text = profile.split('\n')
        .filter((line) => !line.trimStart().startsWith(';'))
        .join('\n');
      const rules = [];
      let depth = 0;
      let start = -1;
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '"') {
          for (i += 1; i < text.length && text[i] !== '"'; i += 1) {
            if (text[i] === '\\') i += 1;
          }
        } else if (ch === '(') {
          if (depth === 0) start = i;
          depth += 1;
        } else if (ch === ')') {
          depth -= 1;
          if (depth === 0) rules.push(text.slice(start, i + 1));
        }
      }
      expect(depth).toBe(0);
      return rules;
    };

    for (const allowClaudeRuntimeAccess of [false, true]) {
      const profile = buildSeatbeltProfile({
        workspacePath: workspace,
        executablePath: '/usr/bin/true',
        statePath: state,
        allowClaudeRuntimeAccess,
      });
      // A bare rule lets a confined agent read every app's domain through
      // cfprefsd, which reads ~/Library/Preferences on the agent's behalf.
      expect(profile).not.toMatch(/\(allow\s+user-preference-read\s*\)/);

      const preferenceRules = sbplRules(profile)
        .filter((rule) => rule.includes('user-preference-'));
      expect(preferenceRules.length).toBeGreaterThan(0);
      for (const rule of preferenceRules) {
        expect(rule).toMatch(/^\(allow\s+user-preference-read\s+\(preference-domain\s+"[^"]+"/);
      }
      // Widening this list needs a measured reason in seatbelt.js.
      const domains = preferenceRules.flatMap((rule) => (
        [...rule.matchAll(/"([^"]+)"/g)].map((match) => match[1])
      ));
      expect(domains).toEqual(['kCFPreferencesAnyApplication']);
    }
  });

  test('rejects relative dynamic paths', () => {
    expect(() => buildSeatbeltProfile({
      workspacePath: 'relative',
      executablePath: '/usr/bin/true',
      statePath: state,
    })).toThrow(/workspacePath must be an absolute path/);
  });

  test('wrapper is fail-closed off macOS and invokes sandbox-exec on macOS', () => {
    if (process.platform !== 'darwin') {
      expect(() => wrapArgvWithSeatbelt(['/usr/bin/true'], {
        workspacePath: workspace,
        executablePath: '/usr/bin/true',
        statePath: state,
      })).toThrow(/available only on macOS/);
      expect(detectSeatbelt()).toMatchObject({ available: false });
      return;
    }

    const detected = detectSeatbelt();
    expect(detected).toMatchObject({ available: true, path: '/usr/bin/sandbox-exec' });
    const argv = wrapArgvWithSeatbelt(['/usr/bin/true'], {
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
    });
    expect(argv[0]).toBe('/usr/bin/sandbox-exec');
    expect(argv[1]).toBe('-p');
    expect(argv.at(-1)).toBe('/usr/bin/true');
  });
});
