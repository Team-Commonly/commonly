/**
 * Refuses a public Codex seat's workspace when its repository is set up to run
 * programs.
 *
 * Codex runs git itself (status and diff of the workspace) outside the seat's
 * permission profile, so whatever the repository's own git setup tells git to
 * run, runs as the operator. `git clone` never copies a remote's .git/config or
 * hooks, so a repository the operator cloned carries none of this. A folder
 * that was copied, unpacked or handed over can, and nothing about the folder
 * says which it was. So before a turn, the repository git would open from the
 * workspace is read, and the turn is refused if it sets any key that names a
 * program or another config file, or holds an active hook. The names are
 * reported, never the values.
 *
 * Read with `git config --file <f> --no-includes --list -z`, which parses and
 * prints and runs nothing, so the check itself can't be turned against the host.
 */
import { spawnSync } from 'child_process';
import {
  accessSync, constants, existsSync, readdirSync, readFileSync, statSync,
} from 'fs';
import {
  dirname, isAbsolute, join, resolve,
} from 'path';

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
  /^credential\.(helper|.+\.helper)$/i,
  /^sequence\.editor$/i,
  /^interactive\.difffilter$/i,
  /^include\.path$/i,
  /^includeif\..+\.path$/i,
  /^remote\..+\.(uploadpack|receivepack|proxy|vcs)$/i,
  /^uploadpack\.packobjectshook$/i,
  /^protocol\..+\.allow$/i,
  /^sendemail\.(.+\.)?(smtpserver|tocmd|cccmd)$/i,
  /^(web|help)\.browser$/i,
  /^(browser|man)\..+\.(cmd|path)$/i,
  /^trailer\..+\.(command|cmd)$/i,
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
  if (/^remote\..+\.(url|pushurl)$/i.test(key)) return EXT_URL.test(String(value).trim());
  if (/^url\..+\.(insteadof|pushinsteadof)$/i.test(key)) return EXT_URL.test(key.slice(4));
  return false;
};

// The repository git opens from `workspace`: the first ancestor holding .git,
// as git's own discovery finds it. A .git file points at the real git dir
// (a linked worktree or a submodule), and a commondir file at the shared one.
export const findRepository = (workspace) => {
  for (let dir = resolve(workspace); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      if (statSync(dotGit).isFile()) {
        const line = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
        if (!line) return { root: dir, gitDir: null, commonDir: null, unreadable: '.git is a file with no gitdir line' };
        gitDir = isAbsolute(line) ? line : resolve(dir, line);
      }
      let commonDir = gitDir;
      const commonFile = join(gitDir, 'commondir');
      if (existsSync(commonFile)) {
        const common = readFileSync(commonFile, 'utf8').trim();
        commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
      }
      return { root: dir, gitDir, commonDir };
    }
    if (dirname(dir) === dir) return null;
  }
};

const configFiles = ({ gitDir, commonDir }) => {
  const files = new Set([join(commonDir, 'config'), join(gitDir, 'config'), join(gitDir, 'config.worktree')]);
  // Submodules' git dirs; git status and diff read their config too.
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = join(dir, entry.name);
      if (existsSync(join(sub, 'config'))) files.add(join(sub, 'config'));
      walk(join(sub, 'modules'), depth + 1);
      walk(sub, depth + 1);
    }
  };
  walk(join(commonDir, 'modules'), 0);
  return [...files].filter((file) => existsSync(file));
};

const hookDirs = ({ gitDir, commonDir }) => [...new Set([join(commonDir, 'hooks'), join(gitDir, 'hooks')])];

const activeHooks = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    if (name.endsWith('.sample')) return false;
    try {
      const path = join(dir, name);
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

const listConfig = (file, run) => {
  const result = run('git', ['config', '--file', file, '--no-includes', '--list', '-z'], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (result?.status !== 0) return null;
  return String(result.stdout || '').split('\0').filter(Boolean).map((entry) => {
    const at = entry.indexOf('\n');
    return at < 0 ? { key: entry, value: '' } : { key: entry.slice(0, at), value: entry.slice(at + 1) };
  });
};

/**
 * What in the workspace's repository would make git run a program: each a
 * `{ file, key }` (never the value), or `{ file, hook }`. Empty when the
 * workspace is in no repository, or the repository sets nothing.
 */
export const codeRunningGitSetup = (workspace, { run = spawnSync } = {}) => {
  const repo = findRepository(workspace);
  if (!repo) return [];
  if (!repo.gitDir) return [{ file: join(repo.root, '.git'), key: repo.unreadable }];
  const findings = [];
  for (const file of configFiles(repo)) {
    const entries = listConfig(file, run);
    if (!entries) {
      findings.push({ file, key: 'unreadable config' });
      continue;
    }
    for (const { key, value } of entries) {
      if (codeRunningKey(key, value)) findings.push({ file, key });
    }
  }
  for (const dir of hookDirs(repo)) {
    for (const hook of activeHooks(dir)) findings.push({ file: join(dir, hook), hook });
  }
  return findings;
};

export const refuseCodeRunningGitSetup = (workspace, { seat = 'this agent', run } = {}) => {
  const findings = codeRunningGitSetup(workspace, { run });
  if (!findings.length) return;
  const named = findings.slice(0, 8).map((f) => (f.hook ? `hook ${f.hook}` : `${f.key} (${f.file})`)).join('; ');
  const error = new Error(
    `${seat} won't work in ${workspace}: its git repository is set to run programs (${named}). `
    + 'Codex runs git outside the sandbox, so these would run as you. Give the agent a fresh '
    + '`git clone` of the repository instead; a clone never copies this setup.',
  );
  error.code = 'workspace_git_runs_programs';
  throw error;
};

export default { codeRunningGitSetup, codeRunningKey, findRepository, refuseCodeRunningGitSetup };
