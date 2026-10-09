import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
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

  test('provider key access changes the profile by one exact read-only literal', () => {
    const keyFile = join(root, 'operator-secrets', 'provider-key');
    mkdirSync(join(root, 'operator-secrets'), { recursive: true });
    writeFileSync(keyFile, 'provider-key');
    const baseline = buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
      mcpConfigDir: mcp,
    });
    const withKey = buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
      mcpConfigDir: mcp,
      readOnlyPaths: [keyFile],
    });
    const baselineLines = new Set(baseline.split('\n').filter(Boolean));
    const addedRules = withKey.split('\n').filter((line) => line && !baselineLines.has(line));
    const resolvedKey = realpathSync(keyFile);
    expect(addedRules).toEqual([
      `(allow file-read* file-test-existence (literal "${resolvedKey}"))`,
    ]);
    expect(withKey).not.toContain(`(subpath "${realpathSync(join(root, 'operator-secrets'))}")`);
    expect(withKey).not.toContain(`file-write* (literal "${resolvedKey}")`);
  });

  test('Claude-only Keychain and temp access are granted only on request', () => {
    const profile = buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
    });
    const claudeTmp = `/private/tmp/claude-${typeof process.getuid === 'function' ? process.getuid() : '0'}`;
    expect(profile).not.toContain(join(homedir(), 'Library', 'Keychains'));
    expect(profile).not.toContain(claudeTmp);

    const claudeProfile = buildSeatbeltProfile({
      workspacePath: workspace,
      executablePath: '/usr/bin/true',
      statePath: state,
      allowClaudeRuntimeAccess: true,
    });
    expect(claudeProfile).toContain(join(homedir(), 'Library', 'Keychains'));
    expect(claudeProfile).toContain(claudeTmp);
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
