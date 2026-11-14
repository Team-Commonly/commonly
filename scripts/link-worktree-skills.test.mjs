// Run: node --test scripts/link-worktree-skills.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSkillsLink } from './link-worktree-skills.mjs';

const LINK = '../../commonly-skills';
const facts = (over = {}) => ({
  root: '/w/commonly/.claude/worktrees/seat',
  mainRoot: '/w/commonly',
  linkText: LINK,
  resolves: (p) => p === '/w/commonly-skills',
  present: () => false,
  ...over,
});

test('a sibling checkout already resolves: nothing to do', () => {
  const plan = planSkillsLink(facts({ root: '/w/commonly', resolves: () => true }));
  assert.deepEqual(plan, { action: 'ok', expected: '/w/commonly-skills' });
});

test('a worktree under .claude/worktrees gets the path its link expects, pointed at the main checkout\'s skills', () => {
  assert.deepEqual(planSkillsLink(facts()), {
    action: 'link', expected: '/w/commonly/.claude/worktrees/commonly-skills', source: '/w/commonly-skills',
  });
});

test('COMMONLY_SKILLS_DIR wins over the main checkout\'s sibling', () => {
  const plan = planSkillsLink(facts({ skillsDir: '/elsewhere/skills', resolves: (p) => p === '/elsewhere/skills' }));
  assert.equal(plan.action, 'link');
  assert.equal(plan.source, '/elsewhere/skills');
});

test('no skills checkout anywhere is refused with what to set', () => {
  const plan = planSkillsLink(facts({ resolves: () => false }));
  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /COMMONLY_SKILLS_DIR/);
});

test('something already at the expected path is never replaced', () => {
  const plan = planSkillsLink(facts({ present: () => true }));
  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /not replacing/);
});

test('a link that would land inside the worktree is refused', () => {
  const plan = planSkillsLink(facts({ linkText: '../skills' }));
  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /inside the worktree/);
});

test('a .claude/skills that is not a relative link is left alone', () => {
  assert.equal(planSkillsLink(facts({ linkText: null })).action, 'refuse');
  assert.equal(planSkillsLink(facts({ linkText: '/abs/skills' })).action, 'refuse');
});

// The real thing: a repo, its skills checkout beside it, and a worktree whose
// link dangles until the script runs.
test('end to end: a nested worktree\'s skills resolve after one run', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-link-')));
  try {
    const repo = path.join(tmp, 'commonly');
    fs.mkdirSync(path.join(tmp, 'commonly-skills', 'some-skill'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    // No GIT_DIR or GIT_WORK_TREE from a hook context may point git at an outer repo.
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const g = (cwd, ...args) => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv,
    });
    g(repo, 'init', '-q');
    fs.symlinkSync(LINK, path.join(repo, '.claude', 'skills'));
    g(repo, 'add', '.claude/skills');
    g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'skills link');
    const wt = path.join(repo, '.claude', 'worktrees', 'seat');
    g(repo, 'worktree', 'add', '-q', wt);
    assert.equal(fs.existsSync(path.join(wt, '.claude', 'skills', 'some-skill')), false);

    const script = fileURLToPath(new URL('./link-worktree-skills.mjs', import.meta.url));
    const env = { ...cleanEnv, COMMONLY_SKILLS_DIR: '' };
    assert.throws(() => execFileSync(process.execPath, [script, '--check'], { cwd: wt, env, stdio: 'pipe' }));
    execFileSync(process.execPath, [script], { cwd: wt, env, stdio: 'pipe' });
    assert.equal(fs.existsSync(path.join(wt, '.claude', 'skills', 'some-skill')), true);
    assert.equal(g(wt, 'status', '--porcelain'), '');
    execFileSync(process.execPath, [script, '--check'], { cwd: wt, env, stdio: 'pipe' });
    // From a subfolder of the main checkout, git's common dir is relative to it.
    fs.mkdirSync(path.join(repo, 'sub'));
    execFileSync(process.execPath, [script, '--check'], { cwd: path.join(repo, 'sub'), env, stdio: 'pipe' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
