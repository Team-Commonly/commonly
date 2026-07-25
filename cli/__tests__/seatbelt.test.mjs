import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
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
      claudePath: '/usr/bin/true',
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
      claudePath: '/usr/bin/true',
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

  test('rejects relative dynamic paths', () => {
    expect(() => buildSeatbeltProfile({
      workspacePath: 'relative',
      claudePath: '/usr/bin/true',
      statePath: state,
    })).toThrow(/workspacePath must be an absolute path/);
  });

  test('wrapper is fail-closed off macOS and invokes sandbox-exec on macOS', () => {
    if (process.platform !== 'darwin') {
      expect(() => wrapArgvWithSeatbelt(['/usr/bin/true'], {
        workspacePath: workspace,
        claudePath: '/usr/bin/true',
        statePath: state,
      })).toThrow(/available only on macOS/);
      expect(detectSeatbelt()).toMatchObject({ available: false });
      return;
    }

    const detected = detectSeatbelt();
    expect(detected).toMatchObject({ available: true, path: '/usr/bin/sandbox-exec' });
    const argv = wrapArgvWithSeatbelt(['/usr/bin/true'], {
      workspacePath: workspace,
      claudePath: '/usr/bin/true',
      statePath: state,
    });
    expect(argv[0]).toBe('/usr/bin/sandbox-exec');
    expect(argv[1]).toBe('-p');
    expect(argv.at(-1)).toBe('/usr/bin/true');
  });
});
