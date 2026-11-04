// Launching an npm-installed CLI (claude, codex) on native Windows, without a
// shell (#2141).
//
// Two things stand between `spawn('codex', args)` and a running Codex on
// Windows. libuv's PATH search tries only the bare name plus `.com` and
// `.exe`, so the `codex.cmd` npm writes is ENOENT. And Node >= 18.20.2 /
// 20.12.2 refuses to spawn a `.cmd`/`.bat` without `shell: true` (EINVAL,
// CVE-2024-27980). `shell: true` is not an option here: the prompt is pod
// content, so it is untrusted, and it travels as an argv element. cmd.exe
// would parse it (a command-injection path for anyone who can post in the
// pod) and would cap the whole command line at 8191 characters.
//
// So the shim is read, never run. npm's cmd-shim writes one of a few fixed
// shapes, each naming the real target relative to the shim's own folder
// (`%dp0%` / `%~dp0`). A JS target runs as `node <script>`, an `.exe` target
// runs as itself; anything else is refused with a reason, never handed to a
// shell. On every other platform this module is a passthrough.

import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'fs';
import { win32 } from 'path';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const BINARY_EXTS = new Set(['.exe', '.com']);
const SHIM_EXTS = new Set(['.cmd', '.bat']);
const SCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs']);

// `%dp0%\…` (cmd-shim >= 4, where `dp0` is SET from `%~dp0` in a subroutine)
// and `%~dp0\…` (cmd-shim <= 3). `%~dp0` already ends in a backslash, so the
// separator after it is optional.
const DP0_PREFIX = /^%(?:~dp0|dp0%)\\?/i;

// A flag the shim passes before the script (from the script's shebang line,
// e.g. `#!/usr/bin/env node --no-warnings`). Only plain tokens are accepted:
// nothing a batch file would expand or redirect.
const SAFE_SHIM_ARG = /^[A-Za-z0-9_.=:/+,-]+$/;

const SEPARATORS = new Set(['&', '&&', '|', '||']);

const extOf = (file) => win32.extname(file).toLowerCase();

// Windows environment keys are case-insensitive, but a copied env object is
// not: `{ ...process.env, PATH }` can carry both `Path` and `PATH`. Read
// `Path` first (the casing Windows itself uses), then `PATH`, then any other
// casing, and drop duplicates.
const pathEntries = (env = {}) => {
  const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
  const rank = (key) => (key === 'Path' ? 0 : key === 'PATH' ? 1 : 2);
  keys.sort((a, b) => rank(a) - rank(b));
  const seen = new Set();
  const entries = [];
  for (const key of keys) {
    for (const raw of String(env[key] || '').split(';')) {
      const dir = raw.trim().replace(/^"(.*)"$/, '$1');
      if (!dir || seen.has(dir.toLowerCase())) continue;
      seen.add(dir.toLowerCase());
      entries.push(dir);
    }
  }
  return entries;
};

const pathExtensions = (env = {}) => {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'pathext');
  const raw = (key && env[key]) || DEFAULT_PATHEXT;
  return String(raw).split(';').map((ext) => ext.trim()).filter((ext) => ext.startsWith('.'));
};

// Split one batch line into tokens: a "quoted string" or a run of
// non-space characters. Quotes are kept as a flag, not in the value.
const tokenize = (line) => {
  const tokens = [];
  const re = /"([^"]*)"|([^\s"]+)/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    tokens.push(match[1] !== undefined
      ? { value: match[1], quoted: true }
      : { value: match[2], quoted: false });
  }
  return tokens;
};

const fromShimDir = (value, shimDir) => {
  if (!DP0_PREFIX.test(value)) return null;
  const rest = value.replace(DP0_PREFIX, '');
  return win32.resolve(shimDir, rest);
};

const isNodeName = (value) => /^node(?:\.exe)?$/i.test(value);

const isNodeBesideShim = (value, shimDir) => {
  const abs = fromShimDir(value, shimDir);
  return Boolean(abs) && win32.basename(abs).toLowerCase() === 'node.exe'
    && win32.dirname(abs).toLowerCase() === win32.resolve(shimDir).toLowerCase();
};

// The program a JS shim runs must be node: bare `node`, `node.exe` beside
// the shim, or the `%_prog%` variable the current cmd-shim SETs to one of
// those two. A shim whose program is anything else (cmd-shim writes
// `/bin/sh` for a shell-script bin) is refused.
const programIsNode = (token, shimDir, text) => {
  if (!token) return false;
  if (!token.quoted && isNodeName(token.value)) return true;
  if (token.quoted && isNodeBesideShim(token.value, shimDir)) return true;
  if (token.quoted && token.value.toLowerCase() === '%_prog%') {
    const values = [...text.matchAll(/SET\s+"_prog=([^"]*)"/gi)].map((m) => m[1]);
    return values.length > 0
      && values.every((value) => isNodeName(value) || isNodeBesideShim(value, shimDir));
  }
  return false;
};

const envValue = (env, name) => {
  const key = Object.keys(env || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
};

// npm's own `npm.cmd` / `npx.cmd` (npm/bin/*.cmd, which the Node installer
// copies next to node.exe) is hand-written, not a cmd-shim:
//
//   SET "NODE_EXE=%~dp0\node.exe"            (else `node`)
//   SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"
//   FOR /F … ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') … SET "NPM_PREFIX_NPX_CLI_JS=%%F\node_modules\npm\bin\npx-cli.js"
//   IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" ( SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%" )
//   "%NODE_EXE%" "%NPX_CLI_JS%" %*
//
// The FOR line runs npm-prefix.js to find the global prefix, so an npm the
// person upgraded with `npm i -g npm` wins over the bundled one. That prefix
// is %APPDATA%\npm unless an npmrc says otherwise; it is checked here, and a
// custom prefix falls back to the npm that shipped with node.
const NPM_LAUNCH = /^"%NODE_EXE%"\s+"%(NP[MX]_CLI_JS)%"\s+%\*$/i;

const parseNpmLauncher = (lines, shimPath, { existsSync, execPath, env }) => {
  const launch = lines.map((line) => line.match(NPM_LAUNCH)).find(Boolean);
  if (!launch) return null;
  const variable = launch[1];
  const shimDir = win32.dirname(shimPath);
  const declared = lines
    .map((line) => line.match(new RegExp(`^SET\\s+"${variable}=([^"]*)"$`, 'i')))
    .find((match) => match && DP0_PREFIX.test(match[1]));
  const bundled = declared ? fromShimDir(declared[1], shimDir) : null;
  if (!bundled) return { command: null, reason: `${shimPath} does not name npm's script beside itself` };
  const appData = envValue(env, 'APPDATA');
  const upgraded = appData
    ? win32.join(appData, 'npm', 'node_modules', 'npm', 'bin', win32.basename(bundled))
    : null;
  const script = upgraded && existsSync(upgraded) ? upgraded : bundled;
  if (!existsSync(script)) return { command: null, reason: `${shimPath} points at ${script}, which does not exist` };
  const nodeBeside = win32.join(shimDir, 'node.exe');
  return { command: existsSync(nodeBeside) ? nodeBeside : execPath, args: [script] };
};

/**
 * Read an npm cmd-shim and return what it would run, as an argv prefix.
 * Shapes, from cmd-shim's generator (npm/cmd-shim lib/index.js, read at
 * v8.0.0 as bundled with npm, and its pre-4.0 output):
 *
 *   current JS:  endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" [flags] "%dp0%\…\cli.js" %*
 *   current exe: "%dp0%\…\tool.exe"   %*
 *   npm's own:   "%NODE_EXE%" "%NPX_CLI_JS%" %*   (see parseNpmLauncher)
 *   legacy JS:   @IF EXIST "%~dp0\node.exe" ( "%~dp0\node.exe" "%~dp0\…\cli.js" %* ) ELSE ( … node "%~dp0\…\cli.js" %* )
 *
 * @returns {{ command: string, args: string[] } | { command: null, reason: string }}
 */
export const parseCmdShim = (text, shimPath, {
  existsSync = realExistsSync, execPath = process.execPath, env = {},
} = {}) => {
  const shimDir = win32.dirname(shimPath);
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^@/, ''))
    .filter(Boolean);
  const npmLauncher = parseNpmLauncher(lines, shimPath, { existsSync, execPath, env });
  if (npmLauncher) return npmLauncher;
  // The launch line is the one that forwards the caller's arguments. The
  // legacy shape has two (node beside the shim, else node on PATH) that name
  // the same script; the last one is the fallback branch.
  const launches = lines
    .map(tokenize)
    .filter((tokens) => tokens.length > 0 && !tokens[tokens.length - 1].quoted
      && tokens[tokens.length - 1].value === '%*');
  if (launches.length === 0) {
    return { command: null, reason: `${shimPath} is not an npm cmd-shim: no line forwards %*` };
  }
  let segment = launches[launches.length - 1];
  // Drop everything up to the last command separator (the current shape
  // prefixes `endLocal & goto … & ` to the launch).
  for (let i = segment.length - 1; i >= 0; i -= 1) {
    if (!segment[i].quoted && SEPARATORS.has(segment[i].value)) {
      segment = segment.slice(i + 1);
      break;
    }
  }
  const legacyIfBranch = segment[0] && !segment[0].quoted && /^\($/.test(segment[0].value);
  if (legacyIfBranch) segment = segment.slice(1);
  const unsafe = segment.slice(0, -1).find((token) => !token.quoted && /[&|<>^()%]/.test(token.value));
  if (unsafe) {
    return { command: null, reason: `${shimPath} has a launch line this CLI will not interpret (${unsafe.value})` };
  }

  const targetToken = segment[segment.length - 2];
  const target = targetToken?.quoted ? fromShimDir(targetToken.value, shimDir) : null;
  if (!target) {
    return { command: null, reason: `${shimPath} does not name a target beside itself` };
  }
  if (!existsSync(target)) {
    return { command: null, reason: `${shimPath} points at ${target}, which does not exist` };
  }
  const ext = extOf(target);

  if (BINARY_EXTS.has(ext)) {
    if (segment.length !== 2) {
      return { command: null, reason: `${shimPath} runs ${target} through another program` };
    }
    return { command: target, args: [] };
  }

  if (SCRIPT_EXTS.has(ext)) {
    const program = segment[0];
    const shimArgs = segment.slice(1, -2);
    if (segment.length < 3 || !programIsNode(program, shimDir, String(text))) {
      return { command: null, reason: `${shimPath} runs ${target} with a program other than node` };
    }
    const badArg = shimArgs.find((token) => token.quoted || !SAFE_SHIM_ARG.test(token.value));
    if (badArg) {
      return { command: null, reason: `${shimPath} passes an argument this CLI will not interpret (${badArg.value})` };
    }
    const nodeBeside = win32.join(shimDir, 'node.exe');
    const node = existsSync(nodeBeside) ? nodeBeside : execPath;
    return { command: node, args: [...shimArgs.map((token) => token.value), target] };
  }

  return { command: null, reason: `${shimPath} launches ${target}, which is neither a script nor an .exe` };
};

const classify = (file, deps) => {
  const ext = extOf(file);
  if (BINARY_EXTS.has(ext)) return { command: file, args: [], source: file };
  if (SHIM_EXTS.has(ext)) {
    let text;
    try {
      text = deps.readFileSync(file, 'utf8');
    } catch (err) {
      return { command: null, reason: `${file} could not be read: ${err.message}`, source: file };
    }
    return { ...parseCmdShim(text, file, deps), source: file };
  }
  return null;
};

/**
 * Resolve `name` to something spawnable without a shell, with the reason when
 * it cannot be. On anything but win32, `{ command: name, args: [] }`.
 * On win32, `source` is the file found on PATH (the shim, or the .exe).
 *
 * @returns {{ command: string, args: string[], source?: string }
 *   | { command: null, reason: string, source?: string }}
 */
export const resolveWindowsCommandWithReason = (name, {
  platform = process.platform,
  env = process.env,
  existsSync = realExistsSync,
  readFileSync = realReadFileSync,
  execPath = process.execPath,
} = {}) => {
  if (platform !== 'win32') return { command: name, args: [] };
  const deps = { existsSync, readFileSync, execPath, env };
  const exts = pathExtensions(env);
  const hasKnownExt = [...BINARY_EXTS, ...SHIM_EXTS].includes(extOf(name));
  // PATHEXT is upper case by convention and NTFS ignores case, so the
  // extension is appended in lower case: the same file, a tidier path.
  const candidatesFor = (base) => (hasKnownExt ? [base] : exts.map((ext) => base + ext.toLowerCase()));

  // An explicit path is checked where it points, never searched for.
  if (/[\\/]/.test(name) || win32.isAbsolute(name)) {
    for (const candidate of candidatesFor(name)) {
      if (!existsSync(candidate)) continue;
      const hit = classify(candidate, deps);
      if (hit) return hit;
    }
    return { command: null, reason: `${name} was not found` };
  }

  // Windows' own order: each PATH folder in turn, each PATHEXT extension
  // within it. The first file that exists is what a shell would run, so it
  // is the only one considered: falling through to a later match would launch
  // a different program from the one the person runs by typing the name.
  for (const dir of pathEntries(env)) {
    for (const candidate of candidatesFor(win32.join(dir, name))) {
      if (!existsSync(candidate)) continue;
      const hit = classify(candidate, deps);
      if (hit) return hit;
    }
  }
  return { command: null, reason: `${name} was not found on PATH (searched ${exts.join(', ')})` };
};

/** `resolveWindowsCommandWithReason` without the reason: null when unresolvable. */
export const resolveWindowsCommand = (name, deps) => {
  const result = resolveWindowsCommandWithReason(name, deps);
  return result.command ? { command: result.command, args: result.args } : null;
};

/**
 * The command and argv an adapter spawns: unchanged off Windows; on Windows,
 * the resolved target with its argv prefix ahead of the adapter's own args.
 * Throws (code ENOENT) with the reason when the name cannot be launched
 * without a shell.
 */
export const resolveLaunch = (command, args, deps = {}) => {
  const resolved = resolveWindowsCommandWithReason(command, deps);
  if (!resolved.command) {
    const err = new Error(`cannot launch ${command} on Windows without a shell: ${resolved.reason}`);
    err.code = 'ENOENT';
    throw err;
  }
  return { command: resolved.command, args: [...resolved.args, ...args], source: resolved.source };
};

/**
 * A stdio MCP server's argv as the runtime (Claude Code, Codex) should launch
 * it. Those runtimes spawn the server themselves, with no shell, so on Windows
 * the default `npx -y @commonlyai/mcp@latest` would hit the same `npx.cmd`
 * wall. On win32, `argv[0]` is resolved here and its prefix spliced in (an npm
 * shim becomes `node.exe …\npx-cli.js -y @commonlyai/mcp@latest`). When it
 * cannot be resolved the entry is left as declared and one line says why.
 * Off Windows the argv is returned as is (the same array).
 */
export const resolveMcpCommand = (argv, deps = {}, { label = 'mcp', name = '', warn } = {}) => {
  if ((deps.platform || process.platform) !== 'win32') return argv;
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') return argv;
  const resolved = resolveWindowsCommandWithReason(argv[0], deps);
  if (!resolved.command) {
    const line = `[${label}] MCP server ${name || argv[0]}: left as declared, ${resolved.reason}`;
    // eslint-disable-next-line no-console
    (warn || console.warn)(line);
    return argv;
  }
  return [resolved.command, ...resolved.args, ...argv.slice(1)];
};
