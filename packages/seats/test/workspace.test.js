import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseRun } from '../src/supervisor.js';
import { createTraceStore } from '../src/trace/store.js';
import {
  prepareWorktree, settleWorktree, sweepWorktrees, lockReasonOf,
} from '../src/workspace.js';
import * as seats from '../src/index.js';

// Every git call in this file, the module's included, reads no host config:
// a global hooksPath or signing rule would otherwise run on the test commits.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'seats-wt-')));
const emptyConfig = join(sandbox, 'gitconfig');
writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
// Run from a git hook, these would point every call at the caller's repo, -C or not.
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete process.env[name];
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A throwaway repo with one commit, a worktree root, and a trace store, all under one temp dir. */
const setup = () => {
  const dir = mkdtempSync(join(sandbox, 'case-'));
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'README'), 'one\n');
  git(repo, 'add', 'README');
  git(repo, 'commit', '-q', '-m', 'one');
  return {
    repo, root: join(dir, 'worktrees'), store: createTraceStore({ root: join(dir, 'trace') }), base: git(repo, 'rev-parse', 'HEAD'),
  };
};

/** { path → locked reason | null } for the repo's worktrees. */
const worktreesOf = (repo) => Object.fromEntries(git(repo, 'worktree', 'list', '--porcelain').split('\n\n').map((block) => {
  const lines = block.split('\n');
  const locked = lines.find((line) => line === 'locked' || line.startsWith('locked '));
  return [lines[0].slice('worktree '.length), locked === undefined ? null : locked.slice('locked '.length)];
}));

/** An adapter that runs `work(cwd)` in the directory it was given. */
const working = (work, calls = []) => ({
  name: 'worker',
  async spawn(prompt, ctx) {
    calls.push(ctx);
    work(ctx.cwd);
    return { text: 'done' };
  },
});

test('a clean worktree is removed after the run settles, and base/head land in the record', async () => {
  const { repo, root, store, base } = setup();
  const calls = [];
  const out = await superviseRun({
    adapter: working(() => {}, calls), prompt: 'look only', store, runId: 'run-clean-1', ctx: { workspace: { repo, root } },
  });
  assert.equal(out.outcome, 'ok');
  const path = join(realpathSync(root), 'run-clean-1');
  assert.equal(calls[0].cwd, path);
  assert.equal(calls[0].workspace, undefined, 'the helper consumed the workspace');
  assert.deepEqual(out.workspace, { path, base, head: base, removed: true });
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.json`), false, 'the marker goes with it');
  assert.equal(worktreesOf(repo)[path], undefined);

  const entries = store.readRun('run-clean-1');
  assert.deepEqual(entries.find((e) => e.type === 'run.started').data.workspace, { base });
  assert.deepEqual(entries.find((e) => e.type === 'run.settled').data.workspace, { base, head: base, removed: true });
  assert.equal(store.verifyRun('run-clean-1').ok, true);
});

test('a dirty worktree is kept, still locked, and its path reported', async () => {
  const { repo, root, store, base } = setup();
  const out = await superviseRun({
    adapter: working((cwd) => writeFileSync(join(cwd, 'new-file'), 'x')), prompt: 'write', store, runId: 'run-dirty-1', ctx: { workspace: { repo, root } },
  });
  const path = join(realpathSync(root), 'run-dirty-1');
  assert.deepEqual(out.workspace, { path, base, head: base, removed: false, kept: 'dirty' });
  assert.equal(existsSync(join(path, 'new-file')), true);
  assert.equal(worktreesOf(repo)[path], lockReasonOf('run-dirty-1'));
  assert.deepEqual(store.readRun('run-dirty-1').find((e) => e.type === 'run.settled').data.workspace,
    { base, head: base, removed: false, kept: 'dirty' });
});

test('an uncommitted edit to a tracked file keeps the worktree, still locked', async () => {
  const { repo, root, store, base } = setup();
  const out = await superviseRun({
    adapter: working((cwd) => writeFileSync(join(cwd, 'README'), 'edited\n')), prompt: 'edit', store, runId: 'run-tracked-1', ctx: { workspace: { repo, root } },
  });
  const path = join(realpathSync(root), 'run-tracked-1');
  assert.deepEqual(out.workspace, { path, base, head: base, removed: false, kept: 'dirty' });
  assert.equal(worktreesOf(repo)[path], lockReasonOf('run-tracked-1'));
});

test('a commit on the detached HEAD keeps the worktree, with the new head recorded', async () => {
  const { repo, root, store, base } = setup();
  const out = await superviseRun({
    adapter: working((cwd) => {
      writeFileSync(join(cwd, 'README'), 'two\n');
      git(cwd, 'commit', '-q', '-am', 'two');
    }),
    prompt: 'commit',
    store,
    runId: 'run-commit-1',
    ctx: { workspace: { repo, root } },
  });
  assert.equal(out.workspace.kept, 'committed');
  assert.equal(out.workspace.base, base);
  assert.notEqual(out.workspace.head, base);
  assert.equal(out.workspace.head, git(out.workspace.path, 'rev-parse', 'HEAD'));
});

test('the sweep releases a dead run\'s lock, removes it when clean, and leaves an unmarked worktree alone', async () => {
  const { repo, root } = setup();
  // Two runs whose wrapper died: prepared, never settled.
  const clean = prepareWorktree({ repo, root, runId: 'run-dead-clean' });
  const dirty = prepareWorktree({ repo, root, runId: 'run-dead-dirty' });
  const live = prepareWorktree({ repo, root, runId: 'run-still-live' });
  writeFileSync(join(dirty.path, 'scratch'), 'x');
  // Someone else's worktree under the same root, locked, with no marker.
  const stranger = join(realpathSync(root), 'stranger');
  git(repo, 'worktree', 'add', '-q', '--detach', '--lock', '--reason', 'not ours', stranger);

  const report = await sweepWorktrees({ root, isRunLive: (runId) => runId === 'run-still-live' });
  assert.deepEqual(report.map(({ runId, action, kept }) => ({ runId, action, ...(kept ? { kept } : {}) })), [
    { runId: 'run-dead-clean', action: 'removed' },
    { runId: 'run-dead-dirty', action: 'unlocked', kept: 'dirty' },
    { runId: 'run-still-live', action: 'live' },
  ]);
  const after = worktreesOf(repo);
  assert.equal(existsSync(clean.path), false);
  assert.equal(after[clean.path], undefined);
  assert.equal(after[dirty.path], null, 'unlocked and kept');
  assert.equal(existsSync(join(dirty.path, 'scratch')), true);
  assert.equal(after[live.path], lockReasonOf('run-still-live'));
  assert.equal(after[stranger], 'not ours');
});

test('the sweep prunes a marker whose worktree is gone, releasing only its own lock', async () => {
  const { repo, root } = setup();
  const ours = prepareWorktree({ repo, root, runId: 'run-gone-ours' });
  const relocked = prepareWorktree({ repo, root, runId: 'run-gone-relocked' });
  git(repo, 'worktree', 'unlock', relocked.path);
  git(repo, 'worktree', 'lock', '--reason', 'a person is looking', relocked.path);
  rmSync(ours.path, { recursive: true, force: true });
  rmSync(relocked.path, { recursive: true, force: true });

  const report = await sweepWorktrees({ root, isRunLive: () => false });
  assert.deepEqual(report.map(({ runId, action }) => ({ runId, action })), [
    { runId: 'run-gone-ours', action: 'pruned' },
    { runId: 'run-gone-relocked', action: 'pruned' },
  ]);
  const realRoot = realpathSync(root);
  assert.equal(existsSync(join(realRoot, 'run-gone-ours.json')), false);
  assert.equal(existsSync(join(realRoot, 'run-gone-relocked.json')), false);
  const after = worktreesOf(repo);
  assert.equal(after[ours.path], null, 'our lock released, so git can prune the record');
  assert.equal(after[relocked.path], 'a person is looking', 'a lock that is not ours stays');
});

test('the sweep keeps a dead run\'s worktree that moved off its base, unlocked', async () => {
  const { repo, root, base } = setup();
  const wt = prepareWorktree({ repo, root, runId: 'run-dead-committed' });
  writeFileSync(join(wt.path, 'README'), 'two\n');
  git(wt.path, 'commit', '-q', '-am', 'two');
  assert.notEqual(git(wt.path, 'rev-parse', 'HEAD'), base);

  const report = await sweepWorktrees({ root, isRunLive: () => false });
  assert.deepEqual(report.map(({ runId, action, kept }) => ({ runId, action, kept })), [
    { runId: 'run-dead-committed', action: 'unlocked', kept: 'committed' },
  ]);
  assert.equal(existsSync(wt.path), true);
  assert.equal(worktreesOf(repo)[wt.path], null);
});

test('a marker whose worktree is locked by someone else is skipped', async () => {
  const { repo, root } = setup();
  const wt = prepareWorktree({ repo, root, runId: 'run-relocked' });
  git(repo, 'worktree', 'unlock', wt.path);
  git(repo, 'worktree', 'lock', '--reason', 'a person is looking', wt.path);
  const report = await sweepWorktrees({ root, isRunLive: () => false });
  assert.deepEqual(report.map((r) => r.action), ['skipped']);
  assert.equal(worktreesOf(repo)[wt.path], 'a person is looking');
});

test('an adapter with a native worktree flag gets the workspace and no helper worktree', async () => {
  const { repo, root, store } = setup();
  const calls = [];
  const adapter = { ...working(() => {}, calls), nativeWorktree: true };
  const out = await superviseRun({
    adapter, prompt: 'p', store, runId: 'run-native-1', ctx: { workspace: { repo, root } },
  });
  assert.equal(out.outcome, 'ok');
  assert.deepEqual(calls[0].workspace, { repo, root });
  assert.equal(calls[0].cwd, undefined);
  assert.equal(out.workspace, undefined);
  assert.equal(existsSync(root), false);
  assert.equal(Object.keys(worktreesOf(repo)).length, 1, 'only the main worktree');
  assert.equal(store.readRun('run-native-1').find((e) => e.type === 'run.settled').data.workspace, undefined);
});

test('an abandoned run keeps its worktree locked for the sweep', () => {
  const { repo, root, base } = setup();
  const wt = prepareWorktree({ repo, root, runId: 'run-abandon' });
  assert.deepEqual(settleWorktree(wt, { abandoned: true }), {
    path: wt.path, base, head: base, removed: false, kept: 'abandoned',
  });
  assert.equal(worktreesOf(repo)[wt.path], lockReasonOf('run-abandon'));
});

test('a run whose adapter ignores the cancel keeps its worktree locked as abandoned', async () => {
  const { repo, root, store } = setup();
  // Never settles and never looks at its signal: the supervisor gives up after
  // the grace period, and the process may still be writing in the worktree.
  const adapter = { name: 'deaf', spawn: () => new Promise(() => {}) };
  const out = await superviseRun({
    adapter,
    prompt: 'p',
    store,
    runId: 'run-deaf-1',
    ctx: { workspace: { repo, root } },
    policy: { stallMs: 0, timeoutMs: 100, cancelGraceMs: 50 },
  });
  assert.equal(out.failure.adapterIgnoredCancel, true);
  assert.equal(out.workspace.kept, 'abandoned');
  assert.equal(out.workspace.removed, false);
  assert.equal(existsSync(out.workspace.path), true);
  assert.equal(worktreesOf(repo)[out.workspace.path], lockReasonOf('run-deaf-1'));
  assert.equal(existsSync(join(realpathSync(root), 'run-deaf-1.json')), true, 'the marker stays for the sweep');
});

test('a workspace that cannot be made settles the run as failed, without spawning', async () => {
  const { root, store } = setup();
  const calls = [];
  const out = await superviseRun({
    adapter: working(() => {}, calls), prompt: 'p', store, runId: 'run-norepo', ctx: { workspace: { repo: join(root, 'missing'), root } },
  });
  assert.equal(out.outcome, 'failed');
  assert.equal(calls.length, 0);
  assert.deepEqual(store.readRun('run-norepo').map((e) => e.type), ['run.settled']);
});

test('the worktree API is exported from the package entry', () => {
  assert.equal(seats.sweepWorktrees, sweepWorktrees);
  assert.equal(seats.prepareWorktree, prepareWorktree);
});
