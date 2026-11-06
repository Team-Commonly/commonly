/**
 * sandbox.turn-dir.test.mjs — F219
 *
 * An adapter keeps a turn's credential in a folder under the temp root. A
 * workspace that holds that root hands the folder to the jail, whichever way
 * round it happened: the workspace set to the temp folder, or TMPDIR set
 * inside the workspace.
 */
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { refuseWorkspaceHoldingTurnDirs } from '../src/lib/sandbox/turn-dir.js';

describe('refuseWorkspaceHoldingTurnDirs', () => {
  let root;
  const seat = 'public test agents';
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'turn-dir-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('a workspace that is the temp folder is refused, naming what to change', async () => {
    const tempRoot = join(root, 'T');
    mkdirSync(tempRoot);
    const error = await refuseWorkspaceHoldingTurnDirs({ workspace: tempRoot, seat, tempRoot }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(seat);
    expect(error.message).toContain(tempRoot);
    expect(error.message).toMatch(/set TMPDIR outside it/);
    expect(error.message).toMatch(/project folder/);
  });

  test('a temp folder inside the workspace is refused, at any depth', async () => {
    const workspace = join(root, 'workspace');
    const tempRoot = join(workspace, 'a', 'tmp');
    mkdirSync(tempRoot, { recursive: true });
    await expect(refuseWorkspaceHoldingTurnDirs({ workspace, seat, tempRoot })).rejects.toThrow(/set TMPDIR outside it/);
  });

  test('links do not hide it, on either side', async () => {
    const tempRoot = join(root, 'T');
    mkdirSync(tempRoot);
    const workspaceLink = join(root, 'looks-like-a-project');
    symlinkSync(tempRoot, workspaceLink);
    await expect(refuseWorkspaceHoldingTurnDirs({ workspace: workspaceLink, seat, tempRoot }))
      .rejects.toThrow(/set TMPDIR outside it/);

    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    mkdirSync(join(workspace, 'tmp'));
    const tempLink = join(root, 'looks-elsewhere');
    symlinkSync(join(workspace, 'tmp'), tempLink);
    await expect(refuseWorkspaceHoldingTurnDirs({ workspace, seat, tempRoot: tempLink }))
      .rejects.toThrow(/set TMPDIR outside it/);
  });

  test('a temp folder that does not exist yet still counts', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    await expect(refuseWorkspaceHoldingTurnDirs({ workspace, seat, tempRoot: join(workspace, 'tmp') }))
      .rejects.toThrow(/set TMPDIR outside it/);
  });

  test('the name is compared as the disk spells it (macOS folds case)', async () => {
    if (process.platform !== 'darwin') return;
    const tempRoot = join(root, 'Temp');
    mkdirSync(tempRoot);
    await expect(refuseWorkspaceHoldingTurnDirs({ workspace: join(root, 'TEMP'), seat, tempRoot }))
      .rejects.toThrow(/set TMPDIR outside it/);
  });

  test('a sibling, a child of the temp folder and a shared name prefix all run, and the real path comes back', async () => {
    const tempRoot = join(root, 'T');
    mkdirSync(join(tempRoot, 'scratch'), { recursive: true });
    mkdirSync(join(root, 'T-project'));
    mkdirSync(join(root, 'project'));
    const link = join(root, 'project-link');
    symlinkSync(join(root, 'project'), link);
    expect(await refuseWorkspaceHoldingTurnDirs({ workspace: join(tempRoot, 'scratch'), seat, tempRoot }))
      .toBe(join(tempRoot, 'scratch'));
    expect(await refuseWorkspaceHoldingTurnDirs({ workspace: join(root, 'T-project'), seat, tempRoot }))
      .toBe(join(root, 'T-project'));
    expect(await refuseWorkspaceHoldingTurnDirs({ workspace: link, seat, tempRoot })).toBe(join(root, 'project'));
  });
});
