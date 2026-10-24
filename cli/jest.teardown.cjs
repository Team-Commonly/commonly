const { rmSync } = require('node:fs');

// setupFiles creates one isolated MCP home per test file. Remove that home
// after the file so a full suite does not accumulate one directory per file.
afterAll(() => {
  globalThis.__commonlyRestoreTempTracking?.();
  const tempDirs = globalThis.__commonlyTempDirsForCleanup;
  if (tempDirs) {
    for (const tempDir of tempDirs) rmSync(tempDir, { recursive: true, force: true });
    delete globalThis.__commonlyTempDirsForCleanup;
  }
  const mcpHome = globalThis.__commonlyMcpHomeForCleanup;
  if (!mcpHome) return;
  rmSync(mcpHome, { recursive: true, force: true });
  delete globalThis.__commonlyMcpHomeForCleanup;
});
