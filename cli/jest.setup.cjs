/**
 * Keep the CLI suite independent of THIS host's MCP home.
 *
 * TASK-174 moved what a seat executes from `npx -y @commonlyai/mcp@latest` to
 * `node ~/.commonly/mcp/<version>/node_modules/@commonlyai/mcp/<bin>`, chosen by
 * a pointer file on the machine that spawns. That makes the materialised command
 * a function of the host — so a suite run on an operator's laptop (where a home
 * exists) would assert something different from CI (where it does not), and the
 * adapter tests that pin the npx form would fail for a reason that has nothing
 * to do with the change.
 *
 * Pointing the home at a fresh dir with no installed build per run restores
 * that: the default `COMMONLY_MCP_HOME` is the real `~/.commonly/mcp`, and
 * tests that want a warmed home set up their own temp dir and pass it in.
 * The lock suppresses an unrelated detached warm child that could still write
 * to this fixture after Jest has moved on to the next test file.
 */
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Adapter tests create several isolated homes and fixture directories. A test
// failure used to strand each one in the host TMPDIR, which made a full CLI
// run grow by tens of gigabytes. Track exact paths returned by both mkdtemp
// APIs; jest.teardown.cjs removes only those paths after this file.
const tempDirs = new Set();
const originalMkdtempSync = fs.mkdtempSync;
const originalMkdtemp = fsPromises.mkdtemp;
const trackedMkdtempSync = (...args) => {
  const path = originalMkdtempSync(...args);
  tempDirs.add(path);
  return path;
};
const trackedMkdtemp = async (...args) => {
  const path = await originalMkdtemp(...args);
  tempDirs.add(path);
  return path;
};
fs.mkdtempSync = trackedMkdtempSync;
fs.promises.mkdtemp = trackedMkdtemp;
fsPromises.mkdtemp = trackedMkdtemp;
syncBuiltinESMExports();
globalThis.__commonlyTempDirsForCleanup = tempDirs;
globalThis.__commonlyRestoreTempTracking = () => {
  fs.mkdtempSync = originalMkdtempSync;
  fs.promises.mkdtemp = originalMkdtemp;
  fsPromises.mkdtemp = originalMkdtemp;
  syncBuiltinESMExports();
};

const mcpHome = originalMkdtempSync(join(tmpdir(), 'commonly-mcp-home-jest-'));
process.env.COMMONLY_MCP_HOME = mcpHome;
globalThis.__commonlyMcpHomeForCleanup = mcpHome;
fs.writeFileSync(join(mcpHome, '.warm.lock'), 'warming\n');
