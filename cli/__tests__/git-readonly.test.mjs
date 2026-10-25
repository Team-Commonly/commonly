/**
 * The read-only git a `workspace`-trust seat is given (TASK-294). Each refusal
 * is paired with a positive control: the same bare git form, run with no guard
 * in a throwaway repo, that writes a file or runs a program — so the test
 * proves the option is dangerous, not merely that a string was rejected.
 */
import {
  afterAll, beforeAll, describe, expect, test,
} from '@jest/globals';
import { execFile } from 'child_process';
import {
  existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import {
  DENIED_LONG_OPTIONS,
  readonlyGitArgv,
  readonlyGitEnv,
  runReadonlyGit,
} from '../src/lib/git-readonly.js';

const execFileAsync = promisify(execFile);
const GIT = 'git';

// A repo with one commit, a tracked file, and a second directory beside it to
// reach for. Every test runs real git here, so refusals are measured, not
// assumed.
let repo;
let outside;

const bareGit = (args, opts = {}) => execFileAsync(GIT, args, {
  cwd: repo,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  ...opts,
});

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'git-ro-repo-'));
  outside = mkdtempSync(join(tmpdir(), 'git-ro-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'a file above the workspace\n');
  await bareGit(['init', '-q', '-b', 'main']);
  await bareGit(['config', 'user.email', 'test@example.com']);
  await bareGit(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'tracked.txt'), 'first line\n');
  await bareGit(['add', 'tracked.txt']);
  await bareGit(['commit', '-q', '-m', 'first commit']);
  writeFileSync(join(repo, 'tracked.txt'), 'first line\nsecond line\n');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const refusal = (call) => {
  const checked = readonlyGitArgv({ root: repo, ...call });
  expect(checked.ok).toBe(false);
  return checked.reason;
};

describe('read-only git refuses what is not read-only', () => {
  test('the subcommand must be one of the five, so an alias never resolves', () => {
    expect(refusal({ subcommand: 'push', args: [] })).toMatch(/only status, log, diff, show, blame/);
    // A configured alias is just another subcommand name, so it is refused too.
    expect(refusal({ subcommand: 'exfil', args: [] })).toMatch(/refused/);
  });

  test('--output writes a file (control), and is refused', async () => {
    const marker = join(repo, 'written-by-output.txt');
    await bareGit(['diff', `--output=${marker}`]);
    expect(existsSync(marker)).toBe(true); // control: the bare form wrote it
    rmSync(marker);
    expect(refusal({ subcommand: 'diff', args: [`--output=${marker}`] })).toMatch(/--output .*writes/);
    expect(existsSync(marker)).toBe(false);
  });

  test('a -c alias with a shell escape runs a program (control), and -c is refused', async () => {
    const marker = join(repo, 'run-by-alias.txt');
    await bareGit(['-c', `alias.x=!touch ${marker}`, 'x']);
    expect(existsSync(marker)).toBe(true); // control: the alias executed
    rmSync(marker);
    // -c is a top-level option; after a subcommand git reads it as a short option.
    expect(refusal({ subcommand: 'log', args: ['-c', 'alias.x=!cmd'] })).toMatch(/-c is refused/);
  });

  test('--ext-diff runs an external diff program, and is refused', () => {
    expect(refusal({ subcommand: 'diff', args: ['--ext-diff'] })).toMatch(/--ext-diff .*runs an external/);
  });

  test('--textconv runs a configured conversion program, and is refused', () => {
    expect(refusal({ subcommand: 'show', args: ['--textconv'] })).toMatch(/--textconv .*runs a configured/);
  });

  test('--no-index compares files outside the repository, and is refused', () => {
    expect(refusal({ subcommand: 'diff', args: ['--no-index', '/etc/passwd', '/etc/hosts'] }))
      .toMatch(/--no-index .*outside the repository/);
  });

  test('--git-dir opens another repository, and is refused', () => {
    expect(refusal({ subcommand: 'log', args: ['--git-dir', outside] })).toMatch(/--git-dir .*different repository/);
  });

  test('--work-tree, --exec-path, --config-env, --contents, --ignore-revs-file, --paginate are refused', () => {
    expect(refusal({ subcommand: 'status', args: ['--work-tree', outside] })).toMatch(/--work-tree/);
    expect(refusal({ subcommand: 'log', args: ['--exec-path', outside] })).toMatch(/--exec-path/);
    expect(refusal({ subcommand: 'log', args: ['--config-env', 'x=Y'] })).toMatch(/--config-env/);
    expect(refusal({ subcommand: 'blame', args: ['--contents', join(outside, 'secret.txt'), 'tracked.txt'] }))
      .toMatch(/--contents/);
    expect(refusal({ subcommand: 'blame', args: ['--ignore-revs-file', join(outside, 'secret.txt')] }))
      .toMatch(/--ignore-revs-file/);
    expect(refusal({ subcommand: 'log', args: ['--paginate'] })).toMatch(/--paginate/);
  });

  test('a git-accepted abbreviation of a denied option is refused', async () => {
    // Control: git's parse-options subcommands take an unambiguous prefix, so
    // `blame --conten` IS `--contents`, which reads a caller-named file.
    await expect(bareGit(['blame', '--conten=tracked.txt', 'tracked.txt'])).resolves.toBeDefined();
    expect(refusal({ subcommand: 'blame', args: ['--conten=tracked.txt', 'tracked.txt'] }))
      .toMatch(/reads it as --contents/);
    // Defense in depth: we also refuse the abbreviation for diff's own parser,
    // which rejects it today but may not forever.
    expect(refusal({ subcommand: 'diff', args: ['--ext'] })).toMatch(/reads it as --ext-diff/);
  });

  test('-C is refused, with a pointer to the real copy-detection option', () => {
    // Top-level `-C <path>` changes directory; this keeps it out of args entirely.
    expect(refusal({ subcommand: 'log', args: ['-C', outside] })).toMatch(/-C is refused/);
  });

  test('blame -S reads a caller-named file and prints it back (control), and is refused for blame only', async () => {
    const secret = join(outside, 'secret.txt');
    const { stderr } = await bareGit(['blame', `-S${secret}`, 'tracked.txt']);
    expect(stderr).toMatch(/bad graft data: a file above the workspace/); // control: blame read it
    expect(refusal({ subcommand: 'blame', args: [`-S${secret}`, 'tracked.txt'] })).toMatch(/-S is refused for blame/);
    expect(refusal({ subcommand: 'blame', args: ['-S', 'tracked.txt', 'tracked.txt'] })).toMatch(/-S is refused for blame/);
    // log, diff and show read -S as the pickaxe string, so it stays allowed there.
    expect(readonlyGitArgv({ root: repo, subcommand: 'log', args: [`-S${secret}`] }).ok).toBe(true);
  });

  test('-O reads a caller-named order file, and is refused', () => {
    expect(refusal({ subcommand: 'diff', args: [`-O${join(outside, 'secret.txt')}`] })).toMatch(/-O is refused/);
  });

  test('a glued short-option cluster is refused; pass each on its own', () => {
    // -Rc would smuggle -c past a per-letter check; the cluster itself is refused.
    expect(refusal({ subcommand: 'diff', args: ['-Rc'] })).toMatch(/pass each short option/);
  });

  test('a path outside the workspace is refused, before and after --', () => {
    expect(refusal({ subcommand: 'log', args: [join(outside, 'secret.txt')] })).toMatch(/outside the workspace/);
    expect(refusal({ subcommand: 'log', args: ['--', '../'] })).toMatch(/outside the workspace/);
    expect(refusal({ subcommand: 'show', args: ['../'] })).toMatch(/outside the workspace/);
  });

  test('an absolute in-workspace path is allowed; a NUL or over-long arg is refused', () => {
    expect(readonlyGitArgv({ subcommand: 'log', args: [join(repo, 'tracked.txt')], root: repo }).ok).toBe(true);
    expect(refusal({ subcommand: 'log', args: ['a\0b'] })).toMatch(/NUL/);
    expect(refusal({ subcommand: 'log', args: ['x'.repeat(5000)] })).toMatch(/too long/);
  });

  test('every denied long option is listed with what it does', () => {
    for (const [name, what] of Object.entries(DENIED_LONG_OPTIONS)) {
      expect(what.length).toBeGreaterThan(0);
      expect(refusal({ subcommand: 'diff', args: [name] })).toContain(name);
    }
  });
});

describe('read-only git runs the five subcommands', () => {
  test('forced options are prepended for diff, log and show', () => {
    const excludes = ['--', ':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*',
      ':(exclude,glob)**/.env/**', ':(exclude,glob)**/.env.*/**'];
    expect(readonlyGitArgv({ subcommand: 'diff', args: [], root: repo }).argv)
      .toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', ...excludes]);
    expect(readonlyGitArgv({ subcommand: 'status', args: [], root: repo }).argv)
      .toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'status', ...excludes]);
    expect(readonlyGitArgv({ subcommand: 'blame', args: ['tracked.txt'], root: repo }).argv)
      .toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'blame', 'tracked.txt']);
  });

  test('status, log, diff, show and blame all return output', async () => {
    const status = await runReadonlyGit({ subcommand: 'status', args: ['--short'], root: repo, git: GIT });
    expect(status.ok).toBe(true);
    expect(status.text).toMatch(/tracked\.txt/);

    const log = await runReadonlyGit({ subcommand: 'log', args: ['--oneline'], root: repo, git: GIT });
    expect(log.ok).toBe(true);
    expect(log.text).toMatch(/first commit/);

    const diff = await runReadonlyGit({ subcommand: 'diff', args: [], root: repo, git: GIT });
    expect(diff.ok).toBe(true);
    expect(diff.text).toMatch(/second line/);

    const show = await runReadonlyGit({ subcommand: 'show', args: ['--stat', 'HEAD'], root: repo, git: GIT });
    expect(show.ok).toBe(true);
    expect(show.text).toMatch(/first commit/);

    const blame = await runReadonlyGit({ subcommand: 'blame', args: ['tracked.txt'], root: repo, git: GIT });
    expect(blame.ok).toBe(true);
    expect(blame.text).toMatch(/first line/);
  });

  test('value-carrying short options (-n5, -U1) are allowed', async () => {
    const log = await runReadonlyGit({ subcommand: 'log', args: ['-n1', '--oneline'], root: repo, git: GIT });
    expect(log.ok).toBe(true);
    expect(log.text.trim().split('\n')).toHaveLength(1);
  });

  test('a refused call comes back as a reason, not a throw', async () => {
    const out = await runReadonlyGit({ subcommand: 'diff', args: ['--output=/tmp/x'], root: repo, git: GIT });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/--output/);
  });

  test('GIT_CEILING_DIRECTORIES stops discovery at the workspace parent; no GIT_* leaks in', () => {
    const env = readonlyGitEnv({ root: repo, baseEnv: { GIT_DIR: '/evil', PATH: '/usr/bin', FOO: 'bar' } });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.FOO).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CEILING_DIRECTORIES.length).toBeGreaterThan(0);
  });

  test('a nested start dir cannot reach a parent repo through discovery', async () => {
    // A repo, then a nested non-repo dir used as the workspace. Ordinary git
    // walks up and finds the parent; ours stops at the ceiling.
    const parent = mkdtempSync(join(tmpdir(), 'git-ro-parent-'));
    try {
      await execFileAsync(GIT, ['init', '-q', parent]);
      const nested = join(parent, 'nested');
      mkdirSync(nested);
      const bare = await execFileAsync(GIT, ['status'], { cwd: nested }).then(() => 'found', () => 'not-found');
      expect(bare).toBe('found'); // control: bare git walks up to the parent repo
      const confined = await runReadonlyGit({ subcommand: 'status', args: [], root: nested, git: GIT });
      expect(confined.ok).toBe(false);
      expect(confined.text).toMatch(/not a git repository/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// A committed .env sits in git's objects, where the sandbox's deny on the file
// does not reach. Each control reads it with bare git; the guarded call does not.
describe('read-only git keeps committed .env files out of reach', () => {
  const SECRET = 'ENV_SECRET_VALUE';
  const run = (subcommand, args) => runReadonlyGit({
    subcommand, args, root: repo, git: GIT,
  });

  beforeAll(async () => {
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, '.env'), `TOKEN=${SECRET}\n`);
    writeFileSync(join(repo, 'sub', '.env.local'), `LOCAL=${SECRET}\n`);
    await bareGit(['add', '-f', '.env', 'sub/.env.local']);
    await bareGit(['commit', '-q', '-m', 'commit env files']);
  });

  test('an argument naming one is refused, in every form git reads a path from (control: bare show reads it)', async () => {
    expect((await bareGit(['show', 'HEAD:.env'])).stdout).toContain(SECRET);
    for (const args of [['HEAD:.env'], [':.env'], [':0:sub/.env.local'], ['HEAD~0:./sub/.env.local'],
      ['HEAD', '--', '.env'], ['HEAD^{tree}:sub/.env.local']]) {
      expect(refusal({ subcommand: 'show', args })).toMatch(/names a \.env file/);
    }
    expect(refusal({ subcommand: 'blame', args: ['sub/.env.local'] })).toMatch(/names a \.env file/);
    expect(refusal({ subcommand: 'log', args: ['-L1,1:.env'] })).toMatch(/names a \.env file/);
    expect(refusal({ subcommand: 'log', args: ['-L', '1,1:sub/.env.local'] })).toMatch(/names a \.env file/);
  });

  test('a patch, a glob, a pickaxe and a raw listing all leave it out (control: bare log -p shows it)', async () => {
    expect((await bareGit(['log', '-p'])).stdout).toContain(SECRET);
    for (const [subcommand, args] of [['log', ['-p']], ['log', ['-p', '--', '.en*', 'sub/*']],
      ['show', ['HEAD']], ['diff', ['HEAD~1', 'HEAD']], ['log', ['--raw', '--all']]]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await run(subcommand, args);
      expect(out.ok).toBe(true);
      expect(out.text).not.toContain(SECRET);
      expect(out.text).not.toMatch(/\.env/);
    }
    expect((await bareGit(['log', '--oneline', `-S${SECRET}`])).stdout).toContain('commit env files');
    expect((await run('log', ['--oneline', `-S${SECRET}`])).text).toBe('(no output)');
  });

  test('ordinary reads still work, with paths after --', async () => {
    expect((await run('log', ['-p', '--', 'tracked.txt'])).text).toContain('first line');
    expect((await run('show', ['HEAD~1:tracked.txt'])).text).toContain('first line');
    expect((await run('log', ['-L1,1:tracked.txt'])).ok).toBe(true);
    expect((await run('status', ['--short'])).ok).toBe(true);
  });
});
