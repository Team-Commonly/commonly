/**
 * F661: the boot sweep and a turn's preparation can both clear one seat's
 * legacy `<seat>.login-turns` markers. When the other one removes the folder
 * after this one's existence check and before its read, the cleanup must
 * count it as cleared instead of rejecting (which would fail the turn).
 *
 * The race is made deterministic: `fs/promises.readdir` is wrapped so that a
 * read of the markers folder removes the folder first, exactly as the other
 * cleanup would. The cleanup runs through its real entry point, so a revert
 * of the read to a bare `readdir(turns)` fails this test.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const actualFsp = await import('fs/promises');
let raceOn = null;
await jest.unstable_mockModule('fs/promises', () => ({
  ...actualFsp,
  default: actualFsp.default,
  readdir: async (dir, ...rest) => {
    if (raceOn && dir === raceOn) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return actualFsp.readdir(dir, ...rest);
  },
}));

const claudeModule = await import('../src/lib/adapters/claude.js');

describe('the legacy marker cleanup races the other cleanup (F661)', () => {
  let root;
  let homes;
  let turns;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f661-race-'));
    homes = path.join(root, 'claude-homes');
    turns = path.join(homes, 'seat-a.login-turns');
    fs.mkdirSync(turns, { recursive: true });
    fs.writeFileSync(path.join(turns, '12345-0b5e9a4c-1111-4222-8333-944455556666'), '');
  });
  afterEach(() => {
    raceOn = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a markers folder removed between the check and the read leaves the sweep resolved', async () => {
    raceOn = turns;
    await expect(claudeModule.removeLegacyClaudeLoginCopies({ root: homes, platform: 'linux' }))
      .resolves.toBeUndefined();
    expect(fs.existsSync(turns)).toBe(false);
  });

  test('without the race the markers are still removed', async () => {
    await claudeModule.removeLegacyClaudeLoginCopies({ root: homes, platform: 'linux' });
    expect(fs.existsSync(turns)).toBe(false);
  });
});
