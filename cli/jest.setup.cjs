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
const { mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const testHome = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-mcp-home-jest-')));
process.env.COMMONLY_MCP_HOME = testHome;
writeFileSync(join(testHome, '.warm.lock'), 'warming\n');

// Tests may override COMMONLY_MCP_HOME; remove only the directory created here.
afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
