/**
 * Refuses a public Codex seat's workspace when its repository is set up to run
 * programs.
 *
 * Codex runs git itself (status and diff of the workspace) outside the seat's
 * permission profile, so whatever the repository's own git setup tells git to
 * run, runs as the operator. `git clone` never copies a remote's config or
 * hooks, so a repository the operator cloned carries none of this. A folder
 * that was copied, unpacked or handed over can, and nothing about the folder
 * says which it was.
 *
 * So before a turn, git itself is asked which repository it would open from the
 * workspace and what config that repository gives it. Asking git rather than
 * walking for `.git` matters: git also accepts a bare layout, skips a `.git` it
 * can't use, and follows `.git` files and symlinks. The questions asked
 * (`rev-parse`, `config --list`, `ls-files`) parse and print, and run with
 * fsmonitor and hooks forced off on the command line, so the check can't be
 * turned against the host. The same is done for every submodule recorded in
 * the index that is checked out, since `git status` recurses into them.
 *
 * The turn is refused when any of these repositories sets a key that names a
 * program or another config file, or holds a hook. The names are reported,
 * never the values. When git's answer can't be read, the turn is refused too.
 *
 * Hook managers (husky's `core.hooksPath`, lefthook, pre-commit, git-lfs's
 * hooks) are refused like any other: a later commit would run them as the
 * operator. A seat that needs one of those repositories needs that setup
 * removed from its copy.
 */
import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

// Keys whose value names a program git may run, or another file whose keys it
// would then read. Matched on the key as git prints it: section and key lower
// case, subsection as written. Bare-boolean keys are in BOOLEAN_KEYS below.
const PROGRAM_KEYS = [
  /^filter\..+\.(clean|smudge|process)$/i,
  /^core\.(sshcommand|pager|editor|askpass|hookspath|gitproxy|alternaterefscommand|worktree)$/i,
  /^diff\.external$/i,
  /^diff\..+\.(command|textconv)$/i,
  /^merge\..+\.driver$/i,
  /^(mergetool|difftool)\..+\.(cmd|path)$/i,
  /^pager\./i,
  /^gpg\.(program|.+\.program)$/i,
  /^gpg\.ssh\.defaultkeycommand$/i,
  /^credential\.(helper|.+\.helper)$/i,
  /^sequence\.editor$/i,
  /^interactive\.difffilter$/i,
  /^include\.path$/i,
  /^includeif\..+\.path$/i,
  /^hook\./i,
  /^gc\.recentobjectshook$/i,
  /^remote\..+\.(uploadpack|receivepack|proxy|vcs)$/i,
  /^uploadpack\.packobjectshook$/i,
  /^protocol\.allow$/i,
  /^protocol\..+\.allow$/i,
  /^sendemail\.(.+\.)?(smtpserver|tocmd|cccmd|sendmailcmd|headercmd)$/i,
  /^imap\.tunnel$/i,
  /^guitool\..+\.cmd$/i,
  /^instaweb\.httpd$/i,
  /^(web|help)\.browser$/i,
  /^(browser|man)\..+\.(cmd|path)$/i,
  /^trailer\..+\.(command|cmd)$/i,
  /^lfs\.extension\..+\.(clean|smudge)$/i,
  /^lfs\.customtransfer\..+\.path$/i,
];
// core.fsmonitor is a program unless it is a boolean (true starts git's own
// daemon, which runs nothing from the repository).
const BOOLEAN_KEYS = [/^core\.fsmonitor$/i];
const BOOLEAN_VALUES = new Set(['', 'true', 'false', 'yes', 'no', 'on', 'off', '1', '0']);
// Keys that run a program only when their value says so.
const BANG_VALUE_KEYS = [/^alias\./i, /^submodule\..+\.update$/i];
const EXT_URL = /^ext::/i;

export const codeRunningKey = (key, value = '') => {
  if (PROGRAM_KEYS.some((pattern) => pattern.test(key))) return true;
  if (BOOLEAN_KEYS.some((pattern) => pattern.test(key))) return !BOOLEAN_VALUES.has(String(value).trim().toLowerCase());
  if (BANG_VALUE_KEYS.some((pattern) => pattern.test(key))) return String(value).trim().startsWith('!');
  if (/^(remote|submodule)\..+\.(url|pushurl)$/i.test(key)) return EXT_URL.test(String(value).trim());
  if (/^url\..+\.(insteadof|pushinsteadof)$/i.test(key)) return EXT_URL.test(key.slice(4));
  return false;
};

// What git reads from the environment to pick a repository. Passed through, so
// the check opens the repository Codex's git would.
const DISCOVERY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'];
// On the command line, ahead of anything the repository says: nothing these
// commands do may start fsmonitor or a hook.
const SAFE_FLAGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false'];
const MAX_DEPTH = 8;

const gitEnv = (baseEnv) => {
  const env = { PATH: baseEnv.PATH || process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const name of DISCOVERY_ENV) if (baseEnv[name] !== undefined) env[name] = baseEnv[name];
  return env;
};

const runGit = (run, cwd, env, args, { flags = SAFE_FLAGS } = {}) => run('git', [...flags, ...args], {
  cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
});

// The repository git opens from `dir`, as git reports it: null when `dir` is in
// none, or `{ unreadable }` when git could not say.
const describeRepository = (dir, { run, env }) => {
  const result = runGit(run, dir, env, ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir', '--git-path', 'hooks']);
  if (result?.status !== 0) {
    // No git on the host means Codex can't run git either.
    if (result?.error?.code === 'ENOENT') return null;
    // Only git's "nothing here or above" answer means no repository. A `.git`
    // file pointing nowhere also says "not a git repository", with the path.
    if (/not a git repository \(or any/i.test(String(result?.stderr || ''))) return null;
    return { unreadable: `git could not read the repository (${String(result?.stderr || result?.error?.message || 'no answer').trim().split('\n')[0]})` };
  }
  const [gitDir, commonDir, hooksDirRaw] = String(result.stdout).trim().split('\n');
  if (!gitDir || !commonDir || !hooksDirRaw) return { unreadable: 'git gave no repository path' };
  // --git-path answers with core.hooksPath forced to /dev/null above, so the
  // repository's own hooks folder is read without it.
  const hooksDir = hooksDirRaw === '/dev/null' ? join(commonDir, 'hooks') : hooksDirRaw;
  return { gitDir, commonDir, hooksDir: isAbsolute(hooksDir) ? hooksDir : resolve(dir, hooksDir) };
};

// Every config entry git applies in this repository, with the system and
// global files off: the repository's own config, its worktree config, and
// whatever they include.
const repositoryConfig = (dir, { run, env }) => {
  const result = runGit(run, dir, env, ['config', '--list', '--includes', '-z', '--show-origin']);
  if (result?.status !== 0) return null;
  // With --show-origin and -z each entry is "origin\0key\nvalue\0".
  const parts = String(result.stdout || '').split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i];
    const entry = parts[i + 1];
    // The safe flags this check passes come back as "command line:" entries.
    if (!entry || origin.startsWith('command line:')) continue;
    const at = entry.indexOf('\n');
    entries.push({
      origin: origin.replace(/^file:/, ''),
      key: at < 0 ? entry : entry.slice(0, at),
      value: at < 0 ? '' : entry.slice(at + 1),
    });
  }
  return entries;
};

// Hook names in `dir`, or null when it exists but can't be listed.
const hooksIn = (dir) => {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => !name.endsWith('.sample'));
  } catch {
    return null;
  }
};

// Checked-out submodules recorded in the index, as paths below `top`.
const submodulesOf = (top, { run, env }) => {
  const result = runGit(run, top, env, ['ls-files', '--stage', '-z']);
  if (result?.status !== 0) return null;
  return String(result.stdout || '').split('\0').filter((line) => line.startsWith('160000 '))
    .map((line) => line.slice(line.indexOf('\t') + 1))
    .map((path) => join(top, path))
    .filter((path) => existsSync(join(path, '.git')));
};

const topLevelOf = (dir, { run, env }) => {
  const result = runGit(run, dir, env, ['rev-parse', '--show-toplevel']);
  return result?.status === 0 ? String(result.stdout).trim() || null : null;
};

const inspect = (dir, context, findings, seen, depth) => {
  const repo = describeRepository(dir, context);
  if (!repo) return;
  if (repo.unreadable) {
    findings.push({ file: dir, key: repo.unreadable });
    return;
  }
  if (seen.has(repo.gitDir)) return;
  seen.add(repo.gitDir);
  if (depth > MAX_DEPTH) {
    findings.push({ file: dir, key: `submodules nested deeper than ${MAX_DEPTH}` });
    return;
  }
  const entries = repositoryConfig(dir, context);
  if (!entries) {
    findings.push({ file: join(repo.commonDir, 'config'), key: 'unreadable config' });
  } else {
    for (const { origin, key, value } of entries) {
      if (codeRunningKey(key, value)) findings.push({ file: origin, key });
    }
  }
  for (const hooksDir of new Set([repo.hooksDir, join(repo.gitDir, 'hooks'), join(repo.commonDir, 'hooks')])) {
    const hooks = hooksIn(hooksDir);
    if (!hooks) findings.push({ file: hooksDir, key: 'unreadable hooks folder' });
    else for (const hook of hooks) findings.push({ file: join(hooksDir, hook), hook });
  }
  const top = topLevelOf(dir, context);
  if (!top) return; // a bare repository has no work tree, so no submodules are checked out
  const submodules = submodulesOf(top, context);
  if (!submodules) {
    findings.push({ file: top, key: 'unreadable index' });
    return;
  }
  for (const sub of submodules) inspect(sub, context, findings, seen, depth + 1);
};

/**
 * What would make git run a program in the workspace's repository or its
 * checked-out submodules: each a `{ file, key }` (never the value), or a
 * `{ file, hook }`. Empty when the workspace is in no repository, or nothing
 * is set. `env` is the environment Codex will get; only the variables git uses
 * to pick a repository are taken from it.
 */
export const codeRunningGitSetup = (workspace, { run = spawnSync, env = process.env } = {}) => {
  const findings = [];
  inspect(resolve(workspace), { run, env: gitEnv(env) }, findings, new Set(), 0);
  return findings;
};

export const refuseCodeRunningGitSetup = (workspace, { seat = 'this agent', run, env } = {}) => {
  const findings = codeRunningGitSetup(workspace, { run, env });
  if (!findings.length) return;
  const named = findings.slice(0, 8).map((f) => (f.hook ? `hook ${f.hook} (${f.file})` : `${f.key} (${f.file})`)).join('; ');
  const more = findings.length > 8 ? ` and ${findings.length - 8} more` : '';
  const error = new Error(
    `${seat} won't work in ${workspace}: its git repository is set to run programs, or git couldn't `
    + `say (${named}${more}). Codex runs git outside the sandbox, so these would run as you. Remove that setup from the `
    + 'agent\'s copy (unset the keys, delete the hooks), or give it a fresh `git clone` that no hook '
    + 'manager has been installed into.',
  );
  error.code = 'workspace_git_runs_programs';
  throw error;
};

export default { codeRunningGitSetup, codeRunningKey, refuseCodeRunningGitSetup };
