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
 * The version as a bare triple — or null when there is none to build.
 *
 * `parseVersion` is a PREFIX test, which is right for ordering two versions and
 * wrong for building anything out of one: it accepts `0.3.13/../../../../tmp/x`,
 * so a version read out of a file (`~/.commonly/mcp/.registry.json`, the
 * `current` pointer) or out of `npm view` could become a path or an npm SPEC
 * ARGUMENT that leaves the seat's home. Everything that turns a version into a
 * STRING used outside this module's own comparisons goes through here instead,
 * and the string it builds is the parsed triple, so no suffix can travel.
 *
 * The cost is deliberate and one-directional: a prerelease (`0.3.13-rc.1`)
 * becomes `0.3.13` rather than falling back to `@latest` — the stable release of
 * the same triple, which is a real published version, and strictly better than
 * the shared `@latest` dir this whole change exists to get off. Anchoring the
 * regex at the end instead would reject the prerelease and leave it unpinned.
 */
export const exactVersion = (spec) => {
  const triple = parseVersion(spec);
  return triple ? triple.join('.') : null;
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
 *
 * The ENTRY SCRIPT is checked first, and that ordering is load-bearing since
 * TASK-174. A seat home runs `node <home>/<version>/node_modules/@commonlyai/mcp/<bin>`,
 * and that path CONTAINS the package name — so a spec-first order matched the
 * path, took the `@` of `@commonlyai/mcp` for the version separator, and returned
 * `{ version: null }` ("unpinned, so never old") for every home build. The
 * version then decided nothing: measured, a home holding 0.3.7 was handed the
 * credential FILE channel, whose reader does not exist before 0.3.12. Nor is
 * "a spec has no slash" a usable rule — a SCOPED spec is `@commonlyai/mcp`.
 */
export const describeMcpCommand = (command, {
  readTextFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
} = {}) => {
  if (!Array.isArray(command) || command.length === 0) return null;
  const parts = command.map(String);
  const scriptPath = parts.find((p) => p.endsWith('.js') || p.endsWith('.mjs'));
  if (scriptPath) {
    // `src/index.js` → `../package.json`; also try one level further up, because
    // a bin shim can live in `bin/` beside `src/`.
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
  }
  const pkgArg = parts.find((p) => p.includes(MCP_PACKAGE));
  if (pkgArg) {
    const at = pkgArg.lastIndexOf('@');
    if (at <= pkgArg.indexOf(MCP_PACKAGE)) return { isCommonly: true, version: null };
    return { isCommonly: true, version: parseVersion(pkgArg.slice(at + 1)) };
  }
  return null;
};
