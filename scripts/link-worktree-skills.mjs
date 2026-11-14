#!/usr/bin/env node
// F126 (TASK-769): make a worktree's skills resolve.
//
// `.claude/skills` is a tracked relative link to `../../commonly-skills`: the
// skills checkout beside the repo. That holds for the main checkout and for any
// worktree that is also its sibling. A worktree anywhere else, such as one under
// `.claude/worktrees/` or a seat's own folder, resolves it to a folder that isn't
// there, and the seat silently loses the repo skills.
//
// Changing the tracked link can't fix every layout, and the tracked tree stays
// untouched. Instead this creates the one path the relative link expects, as a
// link to the skills checkout the main checkout already resolves (or
// COMMONLY_SKILLS_DIR). Run it from inside the worktree:
//
//   node scripts/link-worktree-skills.mjs            # create the missing link
//   node scripts/link-worktree-skills.mjs --check    # report only; exit 1 if it dangles
//
// It never replaces anything that exists at that path, and never writes inside
// the worktree.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_LINK = path.join('.claude', 'skills');

/**
 * What to do, from facts the caller reads. Pure, so every layout is testable.
 * Returns { action: 'ok' | 'link' | 'refuse', ... }.
 */
export const planSkillsLink = ({
  root, mainRoot, linkText, skillsDir = null, resolves, present,
}) => {
  if (!linkText) return { action: 'refuse', reason: `${SKILLS_LINK} is not a link in ${root}` };
  if (path.isAbsolute(linkText)) {
    return { action: 'refuse', reason: `${SKILLS_LINK} is an absolute link (${linkText}); nothing to place` };
  }
  const expected = path.resolve(root, '.claude', linkText);
  if (resolves(path.join(root, SKILLS_LINK))) return { action: 'ok', expected };
  const source = skillsDir || (mainRoot ? path.resolve(mainRoot, '.claude', linkText) : null);
  if (!source || !resolves(source)) {
    return {
      action: 'refuse',
      expected,
      reason: 'no skills checkout found: set COMMONLY_SKILLS_DIR to it'
        + (source ? ` (looked at ${source})` : ''),
    };
  }
  if (path.resolve(source) === expected) return { action: 'ok', expected };
  if (present(expected)) {
    return { action: 'refuse', expected, reason: `${expected} exists and is not the skills checkout; not replacing it` };
  }
  return { action: 'link', expected, source: path.resolve(source) };
};

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const readFacts = (cwd, env) => {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const commonDir = path.resolve(root, git(cwd, ['rev-parse', '--git-common-dir']));
  let linkText = null;
  try { linkText = fs.readlinkSync(path.join(root, SKILLS_LINK)); } catch { /* not a link */ }
  return {
    root,
    mainRoot: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null,
    linkText,
    skillsDir: env.COMMONLY_SKILLS_DIR || null,
    resolves: (p) => fs.existsSync(p),
    present: (p) => { try { fs.lstatSync(p); return true; } catch { return false; } },
  };
};

const main = () => {
  const check = process.argv.includes('--check');
  const plan = planSkillsLink(readFacts(process.cwd(), process.env));
  if (plan.action === 'ok') {
    console.log(`skills resolve: ${plan.expected}`);
    return 0;
  }
  if (plan.action === 'refuse') {
    console.error(`skills do not resolve: ${plan.reason}`);
    return 1;
  }
  if (check) {
    console.error(`skills do not resolve: ${plan.expected} is missing (would link it to ${plan.source})`);
    return 1;
  }
  fs.symlinkSync(plan.source, plan.expected, 'dir');
  console.log(`linked ${plan.expected} -> ${plan.source}`);
  return 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
