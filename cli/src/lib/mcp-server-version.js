/**
 * Which `@commonlyai/mcp` a declared MCP command would run, and which channels
 * that release understands.
 *
 * Shared by the pi bridge (which decides whether to pipe a credential) and by
 * the claude and codex adapters (which decide whether to hand over a PATH or the
 * value): one predicate, because three copies of "is this old enough" would
 * drift, and the drift would be silent in exactly one adapter.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MCP_PACKAGE = '@commonlyai/mcp';

/** The release whose reader accepts the credential on an inherited fd. */
export const PIPE_READER_VERSION = [0, 3, 11];

/** The release whose reader accepts `COMMONLY_TOKEN_FILE` (a PATH, not a secret). */
export const FILE_READER_VERSION = [0, 3, 12];

export const parseVersion = (spec) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(spec || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/**
 * True when `version` is older than `target`; null when there is no version to
 * judge (an unpinned `@latest` tracks the published release, so it is never
 * treated as old).
 */
export const versionOlderThan = (version, target) => {
  if (!version) return null;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== target[i]) return version[i] < target[i];
  }
  return false;
};

/**
 * What an `@commonlyai/mcp` command would run, or null when the command cannot
 * be identified as that package at all.
 *
 * Two shapes matter: `npx [-y] @commonlyai/mcp@<spec>` (a spec is a version, or
 * `latest`/absent, which resolves to whatever is published — never treated as
 * old), and a local checkout, `node <path>/src/index.js`, which is what the
 * staging seats run; for that one the package.json beside it is the only honest
 * answer, and a package.json naming something else means this is not our server.
 *
 * `{ isCommonly: true, version: null }` means "our server, version unknown" —
 * an unpinned npx spec, whose whole point is that it tracks the published one.
 * `null` as the return value means "not identifiable as our server", which is a
 * different answer and takes a different branch: a stranger's server gets its
 * declaration honoured unchanged.
 */
export const describeMcpCommand = (command, {
  readTextFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
} = {}) => {
  if (!Array.isArray(command) || command.length === 0) return null;
  const parts = command.map(String);
  const pkgArg = parts.find((p) => p.includes(MCP_PACKAGE));
  if (pkgArg) {
    const at = pkgArg.lastIndexOf('@');
    if (at <= pkgArg.indexOf(MCP_PACKAGE)) return { isCommonly: true, version: null };
    return { isCommonly: true, version: parseVersion(pkgArg.slice(at + 1)) };
  }
  const scriptPath = parts.find((p) => p.endsWith('.js') || p.endsWith('.mjs'));
  if (!scriptPath) return null;
  // `src/index.js` → `../package.json`; also try one level further up, because a
  // bin shim can live in `bin/` beside `src/`.
  for (const candidate of [join(dirname(scriptPath), '..', 'package.json'), join(dirname(scriptPath), 'package.json')]) {
    let raw;
    try {
      raw = readTextFile(candidate);
    } catch {
      raw = null;
    }
    if (!raw) continue;
    try {
      const pkg = JSON.parse(raw);
      if (!pkg || typeof pkg !== 'object') continue;
      if (pkg.name === MCP_PACKAGE) return { isCommonly: true, version: parseVersion(pkg.version) };
      // A package.json that names another package settles it: not ours, so its
      // declaration is none of this function's business.
      return null;
    } catch {
      // A malformed package.json is not an answer; keep looking.
    }
  }
  return null;
};
