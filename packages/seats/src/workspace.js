/**
 * A plain git worktree per run, and the one thing git does not do on its own:
 * tie the worktree's lifetime to the supervisor's verdict on the run.
 *
 * A run that asks for `ctx.workspace = { repo, base? }` gets a detached
 * worktree at `<root>/<runId>`, checked out at `base` and locked with the
 * reason `jellymoon run <runId>`. A marker beside it, `<root>/<runId>.json`,
 * says this package made it; nothing here touches a worktree without one.
 *
 * When the run settles, a clean worktree is unlocked and removed. Clean means
 * no tracked change, no untracked file, no ignored file, and HEAD still at
 * base. Ignored files count because `git worktree remove` deletes them without
 * asking, so a build into a gitignored dist/ would go with the worktree. A
 * commit the agent made on the detached HEAD lives only in that worktree, so a
 * moved HEAD keeps it too.
 * Anything else stays where it is, still locked, and its path is reported.
 *
 * A run whose wrapper died never settles. `sweepWorktrees` finds those through
 * the caller's `isRunLive`, releases the lock, and removes the worktree only
 * when it is clean.
 *
 * An adapter whose CLI makes its own worktree (Claude Code `--worktree`,
 * Codex `--worktree`) declares `nativeWorktree: true` and gets `ctx.workspace`
 * unchanged; none is made here.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultWorktreeRoot = () => join(homedir(), '.jellymoon', 'worktrees');
export const lockReasonOf = (runId) => `jellymoon run ${runId}`;

const RUN_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MARKER_SUFFIX = '.json';

// A caller's GIT_DIR or GIT_WORK_TREE (a hook, say) would point every call
// below at the wrong repository; GIT_OBJECT_DIRECTORY and the alternates would
// read and write objects somewhere else.
const SCRUBBED_GIT_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
];
const gitEnv = () => {
  const env = { ...process.env };
  for (const name of SCRUBBED_GIT_ENV) delete env[name];
  return env;
};
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

/** Whether this run gets a helper worktree: it asked for one and its CLI makes none. */
export const usesWorktreeHelper = (adapter, ctx) => !!ctx?.workspace && !adapter?.nativeWorktree;

const markerPath = (root, runId) => join(root, `${runId}${MARKER_SUFFIX}`);

/** `git worktree list --porcelain` as { path → { head, locked } }; `locked` is the reason, or null. */
const listWorktrees = (repo) => {
  const out = new Map();
  for (const block of git(repo, ['worktree', 'list', '--porcelain']).split('\n\n')) {
    const fields = {};
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ');
      fields[space < 0 ? line : line.slice(0, space)] = space < 0 ? '' : line.slice(space + 1);
    }
    if (fields.worktree) out.set(fields.worktree, { head: fields.HEAD || null, locked: 'locked' in fields ? fields.locked : null });
  }
  return out;
};

/**
 * null when the worktree is clean against base, else why it is kept. Ignored
 * files count: a build into a gitignored dist/ is still the run's output, and
 * `git worktree remove` deletes ignored files without asking. Untracked
 * "normal" lists an untracked or ignored directory as one line; "all" would
 * list every file in node_modules and overrun execFileSync's buffer.
 */
const keepReason = (path, base) => {
  if (git(path, ['status', '--porcelain', '--untracked-files=normal', '--ignored'])) return 'dirty';
  if (git(path, ['rev-parse', 'HEAD']) !== base) return 'committed';
  return null;
};

/**
 * Unlock and remove; git refuses a worktree with changes, a second check
 * behind keepReason. git will not remove a locked worktree without a double
 * --force, which is never used here, so the unlock has to come first; when
 * the remove then fails (a submodule, say), the lock goes back on with the
 * same reason, so a kept worktree is never left unlocked.
 */
const removeWorktree = (repo, path, reason) => {
  git(repo, ['worktree', 'unlock', path]);
  try {
    git(repo, ['worktree', 'remove', path]);
  } catch (error) {
    try { git(repo, ['worktree', 'lock', '--reason', reason, path]); } catch { /* the remove error is the one to report */ }
    throw error;
  }
};

/** git's own complaint, one line and bounded, for a report a person reads. */
const gitErrorOf = (error) => {
  const text = String(error?.stderr || error?.message || error || '').trim();
  const line = text.split('\n').find((l) => l.trim()) || 'unknown error';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
};

/**
 * Make the run's worktree. The marker is written first, so a crash between
 * the two leaves a marker the sweep can clear, never an unmarked worktree.
 *
 * @param {{ repo: string, base?: string, runId: string, root?: string }} args
 * @returns {{ runId, repo, root, path, base }}  `base` is the resolved commit SHA
 */
export const prepareWorktree = ({ repo, base = 'HEAD', runId, root = defaultWorktreeRoot() } = {}) => {
  if (typeof repo !== 'string' || !repo) throw new Error('workspace.repo must be a path to a git repository');
  if (!RUN_ID.test(String(runId))) throw new Error('a worktree needs a runId of 6-64 characters of [A-Za-z0-9_-]');
  const top = realpathSync(git(repo, ['rev-parse', '--show-toplevel']));
  const baseSha = git(top, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = realpathSync(root);
  const path = join(realRoot, runId);
  const marker = markerPath(realRoot, runId);
  if (existsSync(path) || existsSync(marker)) throw new Error(`a worktree for run ${runId} already exists`);
  writeFileSync(marker, `${JSON.stringify({ runId, repo: top, path, base: baseSha, pid: process.pid })}\n`, { mode: 0o600, flag: 'wx' });
  try {
    git(top, ['worktree', 'add', '--detach', '--lock', '--reason', lockReasonOf(runId), path, baseSha]);
  } catch (error) {
    rmSync(marker, { force: true });
    // `worktree add --reason` is git 2.36+; say so rather than pass on "unknown option".
    if (/unknown option.*reason/.test(String(error?.stderr || ''))) throw new Error('a run worktree needs git 2.36 or later (worktree add --reason)');
    throw error;
  }
  return { runId, repo: top, root: realRoot, path, base: baseSha };
};

/**
 * The run is over: remove a clean worktree, keep anything else locked.
 * `abandoned` is the supervisor's word that the adapter never let go of the
 * run, so its process may still be writing here; the worktree is then kept
 * locked for the sweep, whatever its state.
 *
 * @returns {{ path, base, head, removed: boolean, kept?: 'dirty'|'committed'|'abandoned' }}
 */
export const settleWorktree = (worktree, { abandoned = false } = {}) => {
  const { repo, root, path, base, runId } = worktree;
  const head = git(path, ['rev-parse', 'HEAD']);
  const kept = abandoned ? 'abandoned' : keepReason(path, base);
  if (kept) return { path, base, head, removed: false, kept };
  removeWorktree(repo, path, lockReasonOf(runId));
  rmSync(markerPath(root, runId), { force: true });
  return { path, base, head, removed: true };
};

const readMarker = (file) => {
  try {
    const marker = JSON.parse(readFileSync(file, 'utf8'));
    return marker && RUN_ID.test(String(marker.runId)) && marker.repo && marker.path ? marker : null;
  } catch { return null; }
};

/**
 * Release the worktrees of runs that are no longer live. Only a marked
 * worktree, listed by its marker's repository and locked (if at all) with this
 * package's reason, is touched; a worktree under `root` with no marker is
 * never read.
 *
 * @param {{ root?: string, isRunLive: (runId: string, marker: object) => boolean | Promise<boolean> }} args
 * @returns {Promise<Array<{ runId, path, action: 'live'|'removed'|'unlocked'|'pruned'|'skipped', kept?: string, error?: string }>>}
 *   `unlocked`: the lock is released and the worktree kept, with the reason
 *   `skipped`: left alone, its marker kept; `error` is git's message when a git call failed
 */
export const sweepWorktrees = async ({ root = defaultWorktreeRoot(), isRunLive } = {}) => {
  if (typeof isRunLive !== 'function') throw new Error('sweepWorktrees needs isRunLive(runId)');
  if (!existsSync(root)) return [];
  const realRoot = realpathSync(root);
  const report = [];
  for (const name of readdirSync(realRoot).filter((file) => file.endsWith(MARKER_SUFFIX)).sort()) {
    const file = join(realRoot, name);
    const marker = readMarker(file);
    // A marker names the worktree beside it, never one elsewhere.
    if (!marker || name !== `${marker.runId}${MARKER_SUFFIX}` || marker.path !== join(realRoot, marker.runId)) continue;
    const { runId, repo, path } = marker;
    if (await isRunLive(runId, marker)) { report.push({ runId, path, action: 'live' }); continue; }
    try {
      const entry = listWorktrees(repo).get(path);
      if (!entry || !existsSync(path)) {
        // The directory is gone (or was never made). Unlocking lets git's own
        // pruning drop its record; `git worktree prune` here would reach
        // every stale worktree of the repository, not only this one. A lock
        // someone else put on it is theirs to release, so the marker stays.
        if (entry && entry.locked !== null && entry.locked !== lockReasonOf(runId)) { report.push({ runId, path, action: 'skipped' }); continue; }
        if (entry && entry.locked !== null) git(repo, ['worktree', 'unlock', path]);
        rmSync(file, { force: true });
        report.push({ runId, path, action: 'pruned' });
        continue;
      }
      if (entry.locked !== null && entry.locked !== lockReasonOf(runId)) { report.push({ runId, path, action: 'skipped' }); continue; }
      if (entry.locked !== null) git(repo, ['worktree', 'unlock', path]);
      const kept = keepReason(path, marker.base);
      if (kept) { report.push({ runId, path, action: 'unlocked', kept }); continue; }
      git(repo, ['worktree', 'remove', path]);
      rmSync(file, { force: true });
      report.push({ runId, path, action: 'removed' });
    } catch (error) {
      // A repository moved or deleted since, or git refused: leave it for a person.
      report.push({ runId, path, action: 'skipped', error: gitErrorOf(error) });
    }
  }
  return report;
};
