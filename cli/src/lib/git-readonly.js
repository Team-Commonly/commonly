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
 *    read a file the caller names (DENIED_LONG_OPTIONS, DENIED_SHORT_OPTIONS,
 *    DENIED_SHORT_OPTIONS_BY_SUBCOMMAND), including git's accepted
 *    abbreviations of them (`--outp=`), and against
 *    paths that leave the workspace.
 * 3. diff, log and show run with `--no-ext-diff --no-textconv`, and blame with
 *    `--no-textconv`, so no external diff or conversion program configured for
 *    the repository runs, and the spellings that would turn them back on are
 *    refused. log and show also run with `--no-show-signature`, and
 *    `format.pretty` is forced to `medium`, so nothing runs gpg:
 *    `--show-signature`, a `%G` placeholder and a configured format alias
 *    (which can hold one) are refused. `core.fsmonitor` is forced off for the
 *    same reason: `git status` runs it. What still runs is a clean filter the
 *    repository's own config defines, when status, diff or blame read a
 *    working-tree file: without it they report unchanged files as changed. It
 *    runs inside the sandbox below, and the seat cannot define one. A
 *    submodule's git runs as a child process that gets none of these flags, so
 *    `--submodule=diff` is refused, and the settings that would start one are
 *    forced through `-c`, which does reach it (TOP_LEVEL).
 * 4. The environment is rebuilt from an allowlist. No inherited GIT_* variable
 *    survives, system and global config are off, optional locks are off (so
 *    status never rewrites the index), and GIT_CEILING_DIRECTORIES stops
 *    repository discovery at the workspace. The only repository git can open
 *    is one rooted there, so `show HEAD:<path>` cannot reach a file above it.
 *    No git it runs contacts a remote: lazy fetching is off, so a partial
 *    clone reports an object it lacks as missing instead of fetching it, and
 *    no transport is allowed, which covers git older than 2.44, where
 *    GIT_NO_LAZY_FETCH does nothing.
 * 5. Outside this module, the seat's sandbox (Seatbelt or bwrap) mounts the
 *    workspace read-only.
 * 6. A committed `.env` or `.env.*` stays as far out of reach as the file
 *    itself, which the sandbox denies at any depth. An argument naming one
 *    (`.env`, `HEAD:.env`, `:0:sub/.env.local`, `-L1,5:.env`) is refused, and
 *    status, log, diff and show run with pathspecs excluding them, so no patch,
 *    pickaxe match or blob id comes from one whatever path or glob the caller
 *    named. `--follow` takes exactly one path, so it is refused. What this
 *    cannot stop is `show <blob id>` with an id learned somewhere else.
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
  '--show-signature': 'runs gpg to check a signature',
  '--follow': 'needs exactly one path, and every log here also carries the .env excludes',
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

// Letters refused for one subcommand only. log, diff and show read -S as the
// pickaxe string, but blame reads it as a file of revisions, and prints back a
// line it cannot parse ("bad graft data: <line>").
export const DENIED_SHORT_OPTIONS_BY_SUBCOMMAND = Object.freeze({
  blame: Object.freeze({ S: 'reads a revisions file the caller names' }),
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
  log: ['--no-ext-diff', '--no-textconv', '--no-show-signature'],
  show: ['--no-ext-diff', '--no-textconv', '--no-show-signature'],
  status: [],
  blame: ['--no-textconv'],
});
// `format.pretty` is the repository's default format for log and show, and a
// format can hold a %G placeholder; `medium` is git's own default. The last
// three reach the child git a submodule runs in, which FORCED_OPTIONS do not:
// `diff.submodule=diff` would run git diff inside each submodule under that
// submodule's own config, `status.submoduleSummary` runs git log there, and
// `log.showSignature` would make that log run gpg.
const TOP_LEVEL = Object.freeze([
  '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'format.pretty=medium',
  '-c', 'diff.submodule=short', '-c', 'status.submoduleSummary=false', '-c', 'log.showSignature=false',
]);

// A %G placeholder (%G?, %GG, %GS, %GK, %GF, %GP, %GT) runs gpg on each signed
// commit. A value with no %, no format: and no tformat: is looked up by
// prefix among the built-in formats and the repository's `pretty.<name>`
// aliases, and an alias can hold one, so only a built-in name is taken.
const FORMAT_ARGUMENT = /^--(?:pretty|format)=([\s\S]*)$/;
const BUILTIN_FORMATS = Object.freeze(['oneline', 'short', 'medium', 'full', 'fuller', 'reference', 'email', 'mboxrd', 'raw']);
const checkFormat = (arg) => {
  const match = FORMAT_ARGUMENT.exec(arg);
  if (!match) return null;
  const value = match[1];
  if (value.includes('%G')) return `${arg} is refused: a %G placeholder runs gpg to check a signature`;
  const userFormat = value === '' || value.startsWith('format:') || value.startsWith('tformat:') || value.includes('%');
  if (userFormat || BUILTIN_FORMATS.includes(value.toLowerCase())) return null;
  return `${arg} is refused: name a built-in format (${BUILTIN_FORMATS.join(', ')}) or give format:<placeholders>`;
};

// Mirrors the names sandbox/seatbelt.js denies at any depth.
const ENV_FILE_SEGMENT = /^\.env(\..*)?$/;
const namesEnvFile = (arg) => arg.split(':')
  .some((part) => part.split('/').some((segment) => ENV_FILE_SEGMENT.test(segment)));
const NAMES_ENV_FILE = 'it names a .env file, which the workspace keeps out of reach';
const ENV_EXCLUDES = Object.freeze([
  ':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*', ':(exclude,glob)**/.env/**', ':(exclude,glob)**/.env.*/**',
]);
// blame takes one literal file, so the name check above covers it. A
// blob-to-blob diff (`diff A:f B:f`) takes no pathspec and is refused by git
// here; `diff A B -- f` is the same diff. log -L also takes none, so its file
// is name-checked instead.
const PATHSPEC_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show']);

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
  if (arg.endsWith('=diff') && name.length >= 3 && '--submodule'.startsWith(name)) {
    return `${arg} is refused: it runs git diff inside each submodule, where the forced options don't reach; --submodule=log lists the same commits`;
  }
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
  const deniedHere = DENIED_SHORT_OPTIONS_BY_SUBCOMMAND[subcommand] || {};
  if (Object.prototype.hasOwnProperty.call(deniedHere, letter)) {
    return `-${letter} is refused for ${subcommand}: it ${deniedHere[letter]}`;
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
  let lineRange = false;
  for (const arg of args) {
    if (arg.length > MAX_ARG_LENGTH || arg.includes('\0')) return refuse('an argument is too long or contains NUL');
    if (pathsOnly || arg === '-' || !arg.startsWith('-')) {
      if (escapesRoot(root, arg)) return refuse(`${arg} is refused: it is outside the workspace`);
      if (namesEnvFile(arg)) return refuse(`${arg} is refused: ${NAMES_ENV_FILE}`);
    } else if (arg === '--') {
      pathsOnly = true;
    } else {
      const reason = arg.startsWith('--') ? checkLongOption(arg) || checkFormat(arg) : checkShortOption(arg, subcommand);
      if (reason) return refuse(reason);
      if (arg.startsWith('-L')) {
        lineRange = true;
        if (namesEnvFile(arg.slice(2))) return refuse(`${arg} is refused: ${NAMES_ENV_FILE}`);
      }
    }
  }
  const excludes = PATHSPEC_SUBCOMMANDS.has(subcommand) && !lineRange
    ? [...(pathsOnly ? [] : ['--']), ...ENV_EXCLUDES]
    : [];
  return { ok: true, argv: [...TOP_LEVEL, subcommand, ...FORCED_OPTIONS[subcommand], ...args, ...excludes] };
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
    GIT_NO_LAZY_FETCH: '1',
    // A name no transport uses, so every protocol is refused.
    GIT_ALLOW_PROTOCOL: 'none',
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
