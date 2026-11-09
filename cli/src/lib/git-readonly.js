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
 *    workspace read-only. A public Codex seat starts its MCP servers outside
 *    its own profile, so the codex adapter runs this server under a Seatbelt
 *    of its own (workspace-git.js): workspace read-only, no network.
 * 6. A committed `.env` or `.env.*` stays as far out of reach as the file
 *    itself, which the sandbox denies at any depth. So do `.npmrc`,
 *    `.yarnrc*`, `.commonly` and `.codex`, which a sandbox also denies. An argument naming one
 *    (`.env`, `HEAD:.env`, `:0:sub/.env.local`, `-L1,5:.env`) is refused, and
 *    status, log, diff and show run with pathspecs excluding them, so no patch,
 *    pickaxe match or blob id comes from one whatever path or glob the caller
 *    named. `--follow` takes exactly one path, so it is refused, and so is
 *    `--full-diff`, which lets pathspecs pick commits and then shows every
 *    file each one changed. A line range (log and show `-L<range>:<file>`)
 *    takes no pathspec, so it is taken only as the first argument, in one
 *    piece, where git cannot read it as another option's value, and its file
 *    is name-checked. A blob has no name of its own, so `show` refuses any
 *    revision that names a blob (or a tag that peels to one) other than as
 *    `<rev>:<path>`, whose path is name-checked: git is asked each one's type
 *    before the call runs (blobNamedById). `show` also refuses the options
 *    that make git pick objects itself (SHOW_DENIED_OPTIONS), since it prints
 *    every blob they reach whatever the pathspec says.
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
  '--full-diff': 'shows every file a picked commit changed, .env files included',
  '--end-of-options': 'makes git read every later argument as a revision, so an option-shaped one skips the checks a revision gets',
});

// Options refused for `show` only. Each makes git pick objects itself (every
// ref, every tag, the index), and `show` prints every blob it is handed in
// full: a pathspec doesn't filter it, so `show --indexed-objects` would print
// every file in the index, and `show --tags` a tag that points at a blob.
// log reads the same options, but prints only the commits they reach.
export const SHOW_DENIED_OPTIONS = Object.freeze({
  '--all': 'shows every object the refs point at, blobs included',
  '--branches': 'shows every object the branches point at',
  '--tags': 'shows every object the tags point at, blobs included',
  '--remotes': 'shows every object the remote refs point at',
  '--glob': 'shows every object the matching refs point at, blobs included',
  '--exclude': 'only qualifies a ref-selecting option, which show refuses',
  '--exclude-hidden': 'only qualifies a ref-selecting option, which show refuses',
  '--reflog': 'shows every object a reflog names',
  '--indexed-objects': 'shows every file in the index, whatever its name',
  '--alternate-refs': 'shows objects another repository\'s refs point at',
  '--bisect': 'shows the objects the bisect refs point at',
  '--stdin': 'reads revisions the name check never sees',
});
const checkShowOption = (arg) => {
  const [name] = arg.split('=', 1);
  if (Object.prototype.hasOwnProperty.call(SHOW_DENIED_OPTIONS, name)) {
    return `${name} is refused for show: it ${SHOW_DENIED_OPTIONS[name]}; name the commit, tree or <rev>:<path> to show`;
  }
  if (name.length >= 4) {
    const denied = Object.keys(SHOW_DENIED_OPTIONS).find((option) => option.startsWith(name));
    if (denied) return `${name} is refused for show: git may read it as ${denied}, which ${SHOW_DENIED_OPTIONS[denied]}`;
  }
  return null;
};

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
// commit, and git reads one behind a `+`, `-` or space modifier (`%+G?`,
// `%-GG`, `% GS`) as the same placeholder. A value with no %, no format: and
// no tformat: is looked up by prefix among the built-in formats and the
// repository's `pretty.<name>` aliases, and an alias can hold one, so only a
// built-in name is taken.
const SIGNATURE_PLACEHOLDER = /%[-+ ]?G/;
const BUILTIN_FORMATS = Object.freeze(['oneline', 'short', 'medium', 'full', 'fuller', 'reference', 'email', 'mboxrd', 'raw']);
// Git's revision parser reads --pretty and --format only by their exact names,
// and their format only after `=`: a bare --pretty means medium, and a bare
// --format is an unrecognized argument. The check does not depend on that. An
// abbreviation (`--form=`, `--pret=`) is checked like the full name, and a
// --format that would take its format from the next argument is refused.
const FORMAT_OPTIONS = Object.freeze(['--pretty', '--format']);
const checkFormat = (arg) => {
  const [name] = arg.split('=', 1);
  const option = name.length >= 3 && FORMAT_OPTIONS.find((full) => full.startsWith(name));
  if (!option) return null;
  if (name === arg) {
    return option === '--format' ? `${arg} is refused: give the format in the same argument, as --format=<format>` : null;
  }
  const value = arg.slice(name.length + 1);
  if (SIGNATURE_PLACEHOLDER.test(value)) return `${arg} is refused: a %G placeholder runs gpg to check a signature`;
  const userFormat = value === '' || value.startsWith('format:') || value.startsWith('tformat:') || value.includes('%');
  if (userFormat || BUILTIN_FORMATS.includes(value.toLowerCase())) return null;
  return `${arg} is refused: name a built-in format (${BUILTIN_FORMATS.join(', ')}) or give format:<placeholders>`;
};

// The names a seat's sandbox denies at any depth: sandbox/seatbelt.js denies
// .env files, .commonly and .codex, and a public Codex seat's profile
// (adapters/codex.js) also denies .npmrc and .yarnrc*. They are kept out of
// git's results too, since the objects git reads hold them whatever the
// sandbox says about the file.
const ENV_FILE_SEGMENT = /^\.env(\..*)?$/i;
const OTHER_PROTECTED_SEGMENT = /^(?:\.npmrc|\.yarnrc.*|\.commonly|\.codex)$/i;
const segmentsOf = (arg) => arg.split(':').flatMap((part) => part.split('/'));
const namesEnvFile = (arg) => segmentsOf(arg).some((segment) => ENV_FILE_SEGMENT.test(segment));
const namesOtherProtected = (arg) => segmentsOf(arg).some((segment) => OTHER_PROTECTED_SEGMENT.test(segment));
const NAMES_ENV_FILE = 'it names a .env file, which the workspace keeps out of reach';
const NAMES_OTHER_PROTECTED = 'it names a file the workspace keeps out of reach (.npmrc, .yarnrc, .commonly or .codex)';
const protectedNameReason = (arg) => {
  if (namesEnvFile(arg)) return NAMES_ENV_FILE;
  if (namesOtherProtected(arg)) return NAMES_OTHER_PROTECTED;
  return null;
};
const ENV_EXCLUDES = Object.freeze([
  ':(exclude,glob,icase)**/.env', ':(exclude,glob,icase)**/.env.*', ':(exclude,glob,icase)**/.env/**', ':(exclude,glob,icase)**/.env.*/**',
  ':(exclude,glob,icase)**/.npmrc', ':(exclude,glob,icase)**/.npmrc/**', ':(exclude,glob,icase)**/.yarnrc*', ':(exclude,glob,icase)**/.yarnrc*/**',
  ':(exclude,glob,icase)**/.commonly', ':(exclude,glob,icase)**/.commonly/**', ':(exclude,glob,icase)**/.codex', ':(exclude,glob,icase)**/.codex/**',
]);
// blame takes one literal file, so the name check above covers it. A
// blob-to-blob diff (`diff A:f B:f`) takes no pathspec and is refused by git
// here; `diff A B -- f` is the same diff. A line range takes none either (see
// checkLineRange), so its file is name-checked instead.
const PATHSPEC_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show']);

// log and show trace a line range (-L<range>:<file>), and git refuses a
// pathspec with one, so that call runs without the .env excludes. Only a token
// git is sure to read as -L may turn them off: the first argument, with its
// range in it. After another argument, git can read it as that option's value;
// a bare -L takes the next argument as its range, which the name check may
// read as an option instead. status and diff take no -L at all.
const LINE_RANGE_SUBCOMMANDS = new Set(['log', 'show']);
const checkLineRange = (arg, index, subcommand) => {
  if (!LINE_RANGE_SUBCOMMANDS.has(subcommand)) return `-L is refused for ${subcommand}: only log and show trace a line range`;
  if (index > 0 || arg.length === 2) {
    return `${arg} is refused: give one line range, as the first argument and in one piece (-L<start>,<end>:<file>), so git cannot read it as another option's value`;
  }
  return null;
};

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
  for (const [index, arg] of args.entries()) {
    if (arg.length > MAX_ARG_LENGTH || arg.includes('\0')) return refuse('an argument is too long or contains NUL');
    if (pathsOnly || arg === '-' || !arg.startsWith('-')) {
      if (escapesRoot(root, arg)) return refuse(`${arg} is refused: it is outside the workspace`);
      const protectedReason = protectedNameReason(arg);
      if (protectedReason) return refuse(`${arg} is refused: ${protectedReason}`);
    } else if (arg === '--') {
      pathsOnly = true;
    } else {
      const reason = arg.startsWith('--')
        ? checkLongOption(arg) || checkFormat(arg) || (subcommand === 'show' ? checkShowOption(arg) : null)
        : checkShortOption(arg, subcommand);
      if (reason) return refuse(reason);
      if (arg.startsWith('-L')) {
        const rangeReason = protectedNameReason(arg.slice(2));
        if (rangeReason) return refuse(`${arg} is refused: ${rangeReason}`);
        if (PATHSPEC_SUBCOMMANDS.has(subcommand)) {
          const lineRangeReason = checkLineRange(arg, index, subcommand);
          if (lineRangeReason) return refuse(lineRangeReason);
          lineRange = true;
        }
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

const execGit = (git, argv, { root, baseEnv, timeoutMs }) => new Promise((done) => {
  execFile(git, argv, {
    cwd: root,
    env: readonlyGitEnv({ root, baseEnv }),
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    encoding: 'utf8',
    windowsHide: true,
  }, (error, stdout, stderr) => done({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

// Whether git reads `arg` as `<rev>:<path>`. git splits at the first `:`
// outside any `{...}` (get_oid_with_context_1 in object-name.c counts brace
// depth), so a `:` inside `@{...}` or `^{...}` belongs to the revision: a
// reflog date such as `ref@{2026-11-09 11:41:50}` names no path at all.
const namesAPath = (arg) => {
  let depth = 0;
  for (const ch of arg) {
    if (ch === '{') depth += 1;
    else if (ch === '}' && depth > 0) depth -= 1;
    else if (ch === ':' && depth === 0) return true;
  }
  return false;
};

// The arguments `show` would read as revisions: before `--`, not an option
// (`--end-of-options` is refused, so a `-` argument is never a revision). One
// that names a path does so through `<rev>:<path>`, and readonlyGitArgv has
// name-checked that path; every other one is probed.
const unnamedRevisions = (args) => {
  const revisions = [];
  for (const arg of args) {
    if (arg === '--') break;
    if (!arg.startsWith('-') && !namesAPath(arg)) revisions.push(arg);
  }
  return revisions;
};

/**
 * The first of `show`'s revisions that is a blob, or a tag that peels to one,
 * or null. git prints a blob given by id whatever path it was committed at, so
 * a blob is only shown through `<rev>:<path>`. An argument git can't resolve
 * to one object (a range, a typo) is left to `show` itself, which shows no
 * blob for it.
 */
export const blobNamedById = async ({
  args, root, git = 'git', baseEnv = process.env, timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  // One budget for every check, so many arguments can't stretch the call.
  const deadline = Date.now() + timeoutMs;
  for (const revision of unnamedRevisions(args)) {
    const left = deadline - Date.now();
    if (left <= 0) return { revision, unchecked: true };
    // A revision here never starts with `-`, so cat-file can't read it as an option.
    const { error, stdout } = await execGit(
      git,
      [...TOP_LEVEL, 'cat-file', '-t', `${revision}^{}`],
      { root, baseEnv, timeoutMs: left },
    );
    // A check that was stopped proves nothing, so the call is refused.
    if (error?.killed || error?.signal) return { revision, unchecked: true };
    if (!error && stdout.trim() === 'blob') return { revision };
  }
  return null;
};

const truncate = (text) => (text.length <= MAX_OUTPUT_CHARS
  ? text
  : `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated at ${MAX_OUTPUT_CHARS} characters; narrow it with -n, a path, or a revision range]`);

/**
 * Run one read-only git call in `root`. Resolves `{ ok, text }`; never rejects.
 * `git` is the binary to run (the adapter resolves it outside the sandbox).
 */
export const runReadonlyGit = async ({
  subcommand, args, root, git = 'git', baseEnv = process.env, timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const checked = readonlyGitArgv({ subcommand, args, root });
  if (!checked.ok) return { ok: false, text: checked.reason };
  if (subcommand === 'show') {
    const blob = await blobNamedById({
      args, root, git, baseEnv, timeoutMs,
    });
    if (blob?.unchecked) {
      return { ok: false, text: `${blob.revision} is refused: git did not say in time whether it is a blob` };
    }
    if (blob) {
      return {
        ok: false,
        text: `${blob.revision} is refused: it is a blob, and a blob is shown only as <rev>:<path>, so the file it came from can be checked`,
      };
    }
  }
  const { error, stdout: out, stderr } = await execGit(git, checked.argv, { root, baseEnv, timeoutMs });
  if (!error) return { ok: true, text: truncate(out || '(no output)') };
  const detail = stderr.trim() || error.message;
  return { ok: false, text: truncate([out.trim(), detail].filter(Boolean).join('\n')) };
};

export default {
  READONLY_GIT_SUBCOMMANDS, DENIED_LONG_OPTIONS, DENIED_SHORT_OPTIONS, blobNamedById, readonlyGitArgv, readonlyGitEnv,
  runReadonlyGit,
};
