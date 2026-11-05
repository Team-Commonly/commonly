const { rmSync, rmdirSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');

// setupFiles creates one isolated MCP home per test file. Remove that home
// after the file so a full suite does not accumulate one directory per file.
afterAll(() => {
  globalThis.__commonlyRestoreTempTracking?.();
  const tempDirs = globalThis.__commonlyTempDirsForCleanup;
  if (tempDirs) {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
      // A temp dir used as a workspace seat's state folder gets its folder
      // record beside it (F200, sandbox/workspace-pin.js), outside the dir.
      const pins = join(dirname(tempDir), 'workspace-pins');
      rmSync(join(pins, `${basename(tempDir)}.json`), { force: true });
      try { rmdirSync(pins); } catch { /* absent, or still holds another file's record */ }
    }
    delete globalThis.__commonlyTempDirsForCleanup;
  }
  const mcpHome = globalThis.__commonlyMcpHomeForCleanup;
  if (!mcpHome) return;
  rmSync(mcpHome, { recursive: true, force: true });
  delete globalThis.__commonlyMcpHomeForCleanup;
});
