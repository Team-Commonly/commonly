const { rmSync } = require('node:fs');

// setupFiles creates one isolated MCP home per test file. Remove that home
// after the file so a full suite does not accumulate one directory per file.
afterAll(() => {
  const mcpHome = globalThis.__commonlyMcpHomeForCleanup;
  if (!mcpHome) return;
  rmSync(mcpHome, { recursive: true, force: true });
  delete globalThis.__commonlyMcpHomeForCleanup;
});
