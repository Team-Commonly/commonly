/**
 * Read-only git for a `workspace`-trust seat (TASK-294).
 *
 * A workspace seat may look at the repository it was started in (status, log,
 * diff, show, blame) and nothing more: no git call it can make may write a
 * file, run a program, or read outside its workspace. A Bash permission prefix
 * is not a boundary this relies on, so Bash stays denied to workspace seats
 * and git never goes through it. Git is one MCP tool (git-readonly-server.js)
 * whose argv this module builds and runs with execFile, with no shell in
 * between.
 *
 * What holds the line:
 * 1. The subcommand is one of five builtins. A builtin name never resolves to
 *    an alias, and the caller's arguments go AFTER it, where git's top-level
 *    options (`-c`, `-C`, `--git-dir`, `--exec-path`, …) are not parsed.
 * 2. The arguments are checked against the spellings that write, execute, or
 *    read a file the caller names (DENIED_LONG_OPTIONS, DENIED_SHORT_OPTIONS),
 *    including git's accepted abbreviations of them (`--outp=`), and against
 *    paths that leave the workspace.
 * 3. diff, log and show run with `--no-ext-diff --no-textconv`, so no external
 *    diff or conversion program configured for the repository runs, and the
 *    spellings that would turn them back on are refused. `core.fsmonitor` is
 *    forced off for the same reason: `git status` runs it.
 * 4. The environment is rebuilt from an allowlist. No inherited GIT_* variable
 *    survives, system and global config are off, optional locks are off (so
 *    status never rewrites the index), and GIT_CEILING_DIRECTORIES stops
 *    repository discovery at the workspace. The only repository git can open
 *    is one rooted there, so `show HEAD:<path>` cannot reach a file above it.
 * 5. Outside this module, the seat's sandbox (Seatbelt or bwrap) mounts the
 *    workspace read-only.
 */
import { execFile } from 'child_process';
import { realpathSync } from 'fs';
import {
  dirname, isAbsolute, relative, resolve,
} from 'path';

export const READONLY_GIT_SUBCOMMANDS = Object.freeze(['status', 'log', 'diff', 'show', 'blame']);

// Long options refused in any position, with what each one does.
export const DENIED_LONG_OPTIONS = Object.freeze({
  '--output': 'writes its result to a file',
  '--ext-diff': 'runs an external diff program',
  '--textconv': 'runs a configured conversion program',
  '--no-index': 'compares files outside the repository',
  '--contents': 'reads a file the caller names',
  '--ignore-revs-file': 'reads a file the caller names',
  '--git-dir': 'opens a different repository',
  '--work-tree': 'opens a different working tree',
  '--exec-path': 'runs git programs from another directory',
  '--config-env': 'sets configuration',
  '--paginate': 'runs a pager',
});

// Real options that are also prefixes of a denied one. Git takes an exact name
// over an abbreviation, so these never mean the denied option.
const EXACT_NAMES_THAT_PREFIX_A_DENIED_ONE = new Set(['--text', '--ignore-rev']);

// Single-letter options refused, with what each one does.
export const DENIED_SHORT_OPTIONS = Object.freeze({
  c: 'sets configuration (as a top-level option)',
  C: 'changes directory (as a top-level option); use --find-copies to detect copies',
  O: 'reads a file the caller names',
});

// Short options that carry their value in the same argument (`-n5`, `-U3`,
// `-Sneedle`, `-Gregex`, `-L1,5:file`, `-M50%`, `-B`). Git hands the rest of
// the argument to the option as its value, so nothing after the letter can be
// read as another option.
const VALUE_SHORT_OPTIONS = new Set(['n', 'U', 'S', 'G', 'L', 'M', 'B']);
const STATUS_UNTRACKED_MODES = new Set(['-uno', '-unormal', '-uall']);

// Ahead of the caller's arguments, so a configured program never runs.
const FORCED_OPTIONS = Object.freeze({
  diff: ['--no-ext-diff', '--no-textconv'],
  log: ['--no-ext-diff', '--no-textconv'],
  show: ['--no-ext-diff', '--no-textconv'],
  status: [],
  blame: [],
});
const TOP_LEVEL = Object.freeze(['--no-pager', '-c', 'core.fsmonitor=false']);

const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;
export const MAX_OUTPUT_CHARS = 50 * 1024;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 1000;

const refuse = (reason) => ({ ok: false, reason });

const realOrResolved = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const escapesRoot = (root, arg) => {
  const rel = relative(root, resolve(root, arg));
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
};

const checkLongOption = (arg) => {
  const name = arg.split('=')[0];
  if (Object.prototype.hasOwnProperty.call(DENIED_LONG_OPTIONS, name)) {
    return `${name} is refused: it ${DENIED_LONG_OPTIONS[name]}`;
  }
  if (name.length >= 3 && !EXACT_NAMES_THAT_PREFIX_A_DENIED_ONE.has(name)) {
    const denied = Object.keys(DENIED_LONG_OPTIONS).find((option) => option.startsWith(name));
    if (denied) return `${name} is refused: git reads it as ${denied}, which ${DENIED_LONG_OPTIONS[denied]}`;
  }
  return null;
};

const checkShortOption = (arg, subcommand) => {
  if (/^-\d+$/.test(arg)) return null;
  const letter = arg[1];
  if (Object.prototype.hasOwnProperty.call(DENIED_SHORT_OPTIONS, letter)) {
    return `-${letter} is refused: it ${DENIED_SHORT_OPTIONS[letter]}`;
  }
  if (arg.length === 2) return null;
  if (VALUE_SHORT_OPTIONS.has(letter)) return null;
  if (subcommand === 'status' && STATUS_UNTRACKED_MODES.has(arg)) return null;
  return `${arg} is refused: pass each short option as its own argument`;
};

/**
 * The argv for one read-only git call, or the reason it is refused.
 * `root` is the workspace; the caller's paths are checked against it.
 */
export const readonlyGitArgv = ({ subcommand, args = [], root }) => {
  if (!READONLY_GIT_SUBCOMMANDS.includes(subcommand)) {
    return refuse(`git ${subcommand} is refused: only ${READONLY_GIT_SUBCOMMANDS.join(', ')} are available`);
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return refuse('args must be an array of strings');
  }
  if (args.length > MAX_ARGS) return refuse(`at most ${MAX_ARGS} arguments`);
  if (typeof root !== 'string' || !isAbsolute(root)) return refuse('the workspace is not an absolute path');
  let pathsOnly = false;
  for (const arg of args) {
    if (arg.length > MAX_ARG_LENGTH || arg.includes('\0')) return refuse('an argument is too long or contains NUL');
    if (pathsOnly || arg === '-' || !arg.startsWith('-')) {
      if (escapesRoot(root, arg)) return refuse(`${arg} is refused: it is outside the workspace`);
    } else if (arg === '--') {
      pathsOnly = true;
    } else {
      const reason = arg.startsWith('--') ? checkLongOption(arg) : checkShortOption(arg, subcommand);
      if (reason) return refuse(reason);
    }
  }
  return { ok: true, argv: [...TOP_LEVEL, subcommand, ...FORCED_OPTIONS[subcommand], ...args] };
};

// What git keeps from the seat's environment. Everything else is dropped,
// every GIT_* variable included.
const KEPT_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ']);

export const readonlyGitEnv = ({ root, baseEnv = process.env }) => {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (KEPT_ENV.has(key) && typeof value === 'string') env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_CEILING_DIRECTORIES: dirname(realOrResolved(root)),
  };
};

const truncate = (text) => (text.length <= MAX_OUTPUT_CHARS
  ? text
  : `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated at ${MAX_OUTPUT_CHARS} characters; narrow it with -n, a path, or a revision range]`);

/**
 * Run one read-only git call in `root`. Resolves `{ ok, text }`; never rejects.
 * `git` is the binary to run (the adapter resolves it outside the sandbox).
 */
export const runReadonlyGit = ({
  subcommand, args, root, git = 'git', baseEnv = process.env, timeoutMs = DEFAULT_TIMEOUT_MS,
}) => new Promise((done) => {
  const checked = readonlyGitArgv({ subcommand, args, root });
  if (!checked.ok) {
    done({ ok: false, text: checked.reason });
    return;
  }
  execFile(git, checked.argv, {
    cwd: root,
    env: readonlyGitEnv({ root, baseEnv }),
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    encoding: 'utf8',
    windowsHide: true,
  }, (error, stdout, stderr) => {
    const out = String(stdout || '');
    if (!error) {
      done({ ok: true, text: truncate(out || '(no output)') });
      return;
    }
    const detail = String(stderr || '').trim() || error.message;
    done({ ok: false, text: truncate([out.trim(), detail].filter(Boolean).join('\n')) });
  });
});

export default {
  READONLY_GIT_SUBCOMMANDS, DENIED_LONG_OPTIONS, DENIED_SHORT_OPTIONS, readonlyGitArgv, readonlyGitEnv, runReadonlyGit,
};
