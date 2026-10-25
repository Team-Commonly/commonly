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
  chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync,
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
// Test git inherits no GIT_* from the shell: under a git hook, GIT_DIR,
// GIT_WORK_TREE and GIT_INDEX_FILE would point it at the outer repository.
// System and global config are off, so a developer's own settings can't
// change what a control shows.
const testGitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

// A repo with one commit, a tracked file, and a second directory beside it to
// reach for. Every test runs real git here, so refusals are measured, not
// assumed.
let repo;
let outside;

const bareGit = (args, opts = {}) => execFileAsync(GIT, args, {
  cwd: repo,
  env: testGitEnv,
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
    const top = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'format.pretty=medium',
      '-c', 'diff.submodule=short', '-c', 'status.submoduleSummary=false', '-c', 'log.showSignature=false'];
    expect(readonlyGitArgv({ subcommand: 'diff', args: [], root: repo }).argv)
      .toEqual([...top, 'diff', '--no-ext-diff', '--no-textconv', ...excludes]);
    expect(readonlyGitArgv({ subcommand: 'log', args: [], root: repo }).argv)
      .toEqual([...top, 'log', '--no-ext-diff', '--no-textconv', '--no-show-signature', ...excludes]);
    expect(readonlyGitArgv({ subcommand: 'status', args: [], root: repo }).argv)
      .toEqual([...top, 'status', ...excludes]);
    expect(readonlyGitArgv({ subcommand: 'blame', args: ['tracked.txt'], root: repo }).argv)
      .toEqual([...top, 'blame', '--no-textconv', 'tracked.txt']);
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
    expect(env.GIT_NO_LAZY_FETCH).toBe('1');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('none');
    expect(env.GIT_CEILING_DIRECTORIES.length).toBeGreaterThan(0);
  });

  test('a nested start dir cannot reach a parent repo through discovery', async () => {
    // A repo, then a nested non-repo dir used as the workspace. Ordinary git
    // walks up and finds the parent; ours stops at the ceiling.
    const parent = mkdtempSync(join(tmpdir(), 'git-ro-parent-'));
    try {
      await bareGit(['init', '-q', parent]);
      const nested = join(parent, 'nested');
      mkdirSync(nested);
      const bare = await bareGit(['status'], { cwd: nested }).then(() => 'found', () => 'not-found');
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

  test('--follow is refused, since it takes one path and the excludes add more (control: git rejects it with them)', async () => {
    await expect(bareGit(['log', '--follow', '--', 'tracked.txt', ':(exclude,glob)**/.env']))
      .rejects.toMatchObject({ stderr: expect.stringMatching(/exactly one pathspec/) });
    for (const args of [['--follow', '--', 'tracked.txt'], ['--foll', '--', 'tracked.txt']]) {
      expect(refusal({ subcommand: 'log', args })).toMatch(/--follow/);
    }
  });

  test('--full-diff is refused, since it shows every file a picked commit changed (control: the guarded argv plus it shows .env)', async () => {
    const own = mkdtempSync(join(tmpdir(), 'git-ro-full-diff-'));
    try {
      const inOwn = (args) => bareGit(args, { cwd: own });
      await inOwn(['init', '-q']);
      writeFileSync(join(own, '.env'), `TOKEN=${SECRET}\n`);
      writeFileSync(join(own, 'a.txt'), 'a\n');
      await inOwn(['add', '-f', '.env', 'a.txt']);
      await inOwn(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'both']);
      // The guarded `log -p` argv, run as is and with --full-diff spliced in.
      const { argv } = readonlyGitArgv({ subcommand: 'log', args: ['-p'], root: own });
      const at = argv.indexOf('log') + 1;
      const env = readonlyGitEnv({ root: own });
      expect((await execFileAsync(GIT, argv, { cwd: own, env })).stdout).not.toContain(SECRET);
      const spliced = [...argv.slice(0, at), '--full-diff', ...argv.slice(at)];
      expect((await execFileAsync(GIT, spliced, { cwd: own, env })).stdout).toContain(SECRET);
      for (const [subcommand, args] of [['log', ['-p', '--full-diff']], ['log', ['--raw', '--full-diff']],
        ['log', ['--full-d']], ['show', ['--full-diff']]]) {
        expect(refusal({ subcommand, args })).toMatch(/--full-diff/);
      }
      expect((await run('log', ['-p', '--full-history'])).ok).toBe(true);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
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

// A program the repository's config names (gpg for a signature, a textconv
// driver) runs on an ordinary read unless git is told not to. Each control
// runs bare git with a stub on PATH that leaves a marker; the guarded call
// leaves none.
describe('read-only git runs no gpg and no textconv', () => {
  let cfgRepo;
  let bin;
  let markers;
  let signed;
  const cfgGit = (args, opts = {}) => execFileAsync(GIT, args, {
    cwd: cfgRepo,
    env: { ...testGitEnv, PATH: `${bin}:${process.env.PATH}` },
    ...opts,
  });
  const run = (subcommand, args) => runReadonlyGit({
    subcommand, args, root: cfgRepo, git: GIT, baseEnv: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const ran = (name) => {
    const marker = join(markers, name);
    const was = existsSync(marker);
    rmSync(marker, { force: true });
    return was;
  };

  beforeAll(async () => {
    cfgRepo = mkdtempSync(join(tmpdir(), 'git-ro-cfg-'));
    bin = mkdtempSync(join(tmpdir(), 'git-ro-bin-'));
    markers = mkdtempSync(join(tmpdir(), 'git-ro-markers-'));
    writeFileSync(join(bin, 'gpg'), `#!/bin/sh\ntouch '${join(markers, 'gpg')}'\nexit 1\n`);
    writeFileSync(join(bin, 'conv'), `#!/bin/sh\ntouch '${join(markers, 'textconv')}'\ncat "$1"\n`);
    chmodSync(join(bin, 'gpg'), 0o755);
    chmodSync(join(bin, 'conv'), 0o755);
    await cfgGit(['init', '-q', '-b', 'main']);
    await cfgGit(['config', 'user.email', 'test@example.com']);
    await cfgGit(['config', 'user.name', 'Test']);
    await cfgGit(['config', 'diff.conv.textconv', 'conv']);
    writeFileSync(join(cfgRepo, '.gitattributes'), '*.txt diff=conv\n');
    writeFileSync(join(cfgRepo, 'notes.txt'), 'one line\n');
    await cfgGit(['add', '.gitattributes', 'notes.txt']);
    await cfgGit(['commit', '-q', '-m', 'unsigned']);
    // The same commit with a signature header: enough for git to call gpg.
    const { stdout: body } = await cfgGit(['cat-file', 'commit', 'HEAD']);
    const split = body.indexOf('\n\n');
    const header = ['gpgsig -----BEGIN PGP SIGNATURE-----', ' ', ' aGVsbG8=', ' -----END PGP SIGNATURE-----'].join('\n');
    const child = execFile(GIT, ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: cfgRepo, env: testGitEnv });
    const out = new Promise((done) => { let text = ''; child.stdout.on('data', (d) => { text += d; }); child.on('close', () => done(text)); });
    child.stdin.end(`${body.slice(0, split)}\n${header}${body.slice(split)}`);
    signed = (await out).trim();
    expect(signed).toMatch(/^[0-9a-f]{40,64}$/);
  });

  afterAll(() => {
    for (const dir of [cfgRepo, bin, markers]) rmSync(dir, { recursive: true, force: true });
  });

  test('--show-signature runs gpg (control), and is refused; abbreviations too', async () => {
    await cfgGit(['log', '--show-signature', '-1', signed]);
    expect(ran('gpg')).toBe(true);
    expect((await run('log', ['--show-signature', '-1', signed])).text).toMatch(/--show-signature is refused: it runs gpg/);
    expect((await run('show', ['--show-sig', signed])).text).toMatch(/git reads it as --show-signature/);
    expect(ran('gpg')).toBe(false);
  });

  test('a %G placeholder runs gpg (control), and is refused in --format and --pretty', async () => {
    await cfgGit(['log', '--format=%G?', '-1', signed]);
    expect(ran('gpg')).toBe(true);
    for (const arg of ['--format=%G?', '--pretty=format:%GS', '--pretty=tformat:%h %GK']) {
      expect((await run('log', [arg, '-1', signed])).text).toMatch(/%G placeholder runs gpg/);
    }
    expect(ran('gpg')).toBe(false);
  });

  test('log.showSignature in the repository config runs gpg (control); the guarded log and show do not', async () => {
    await cfgGit(['config', 'log.showSignature', 'true']);
    try {
      await cfgGit(['log', '-1', signed]);
      expect(ran('gpg')).toBe(true);
      expect((await run('log', ['-1', signed])).ok).toBe(true);
      expect((await run('show', ['--stat', signed])).ok).toBe(true);
      expect(ran('gpg')).toBe(false);
    } finally {
      await cfgGit(['config', '--unset', 'log.showSignature']);
    }
  });

  test('a format.pretty holding %G runs gpg (control); the guarded log does not', async () => {
    await cfgGit(['config', 'format.pretty', 'format:%G?']);
    try {
      await cfgGit(['log', '-1', signed]);
      expect(ran('gpg')).toBe(true);
      const log = await run('log', ['-1', signed]);
      expect(log.ok).toBe(true);
      expect(log.text).toContain('unsigned');
      expect(ran('gpg')).toBe(false);
    } finally {
      await cfgGit(['config', '--unset', 'format.pretty']);
    }
  });

  test('a configured format alias can hold %G (control), so only built-in names are taken', async () => {
    await cfgGit(['config', 'pretty.sig', '%G?']);
    try {
      await cfgGit(['log', '--pretty=sig', '-1', signed]);
      expect(ran('gpg')).toBe(true);
      expect((await run('log', ['--pretty=sig', '-1', signed])).text).toMatch(/name a built-in format/);
      expect((await run('log', ['--format=si', '-1', signed])).text).toMatch(/name a built-in format/);
      expect(ran('gpg')).toBe(false);
      const oneline = await run('log', ['--pretty=oneline', '-1', signed]);
      expect(oneline.text).toContain('unsigned');
      const custom = await run('log', ['--format=%h %s', '-1', signed]);
      expect(custom.text).toContain('unsigned');
    } finally {
      await cfgGit(['config', '--unset', 'pretty.sig']);
    }
  });

  test('blame runs the configured textconv (control); the guarded blame does not', async () => {
    await cfgGit(['blame', 'notes.txt']);
    expect(ran('textconv')).toBe(true);
    const blame = await run('blame', ['notes.txt']);
    expect(blame.ok).toBe(true);
    expect(blame.text).toContain('one line');
    expect(ran('textconv')).toBe(false);
  });
});

// A superproject whose submodule has moved on by one commit, where the
// submodule's own config names a diff program that leaves a marker if it runs.
describe('read-only git holds a submodule to the same rules', () => {
  let base;
  let parent;
  let marker;
  const inParent = (args) => bareGit(args, { cwd: parent });
  const runIn = (subcommand, args) => runReadonlyGit({ subcommand, args, root: parent, git: GIT });

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'git-ro-submodule-'));
    const sub = join(base, 'sub');
    parent = join(base, 'parent');
    marker = join(base, 'diff-program-ran');
    const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    mkdirSync(sub);
    await bareGit(['init', '-q'], { cwd: sub });
    writeFileSync(join(sub, 'f.txt'), 'one\n');
    await bareGit(['add', 'f.txt'], { cwd: sub });
    await bareGit([...id, 'commit', '-q', '-m', 'one'], { cwd: sub });
    mkdirSync(parent);
    await inParent(['init', '-q']);
    await inParent(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 's']);
    await inParent([...id, 'commit', '-q', '-m', 'add s']);
    const program = join(base, 'diff-program');
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(program, 0o755);
    const inSub = (args) => bareGit(args, { cwd: join(parent, 's') });
    await inSub(['config', 'diff.external', program]);
    writeFileSync(join(parent, 's', 'f.txt'), 'two\n');
    await inSub([...id, 'commit', '-q', '-am', 'two']);
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test('--submodule=diff is refused (control: bare git runs the submodule diff program)', async () => {
    await inParent(['diff', '--submodule=diff']);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const result = await runIn('diff', ['--submodule=diff']);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/--submodule=diff is refused/);
    expect(existsSync(marker)).toBe(false);
  });

  test('diff.submodule=diff in the repository config runs no submodule program (control: bare git does)', async () => {
    await inParent(['config', 'diff.submodule', 'diff']);
    try {
      await inParent(['diff']);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      for (const [subcommand, args] of [['diff', []], ['show', []], ['log', ['-p', '-1']]]) {
        // eslint-disable-next-line no-await-in-loop
        expect((await runIn(subcommand, args)).ok).toBe(true);
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      await inParent(['config', '--unset', 'diff.submodule']);
    }
  });

  test('status prints no submodule summary, so no git log runs inside it (control: bare git prints one)', async () => {
    await inParent(['config', 'status.submoduleSummary', 'true']);
    try {
      expect((await inParent(['status'])).stdout).toMatch(/Submodules changed but not updated/);
      const result = await runIn('status', []);
      expect(result.ok).toBe(true);
      expect(result.text).toMatch(/modified: +s \(new commits\)/);
      expect(result.text).not.toMatch(/Submodules changed but not updated/);
    } finally {
      await inParent(['config', '--unset', 'status.submoduleSummary']);
    }
  });
});

// A partial clone leaves objects on its remote. Bare git fetches one the moment
// a command needs it; the guarded call reports it missing and contacts nothing.
describe('read-only git never contacts a remote', () => {
  let base;
  let clone;
  const present = (oid) => bareGit(['cat-file', '-e', oid], {
    cwd: clone,
    env: { ...testGitEnv, GIT_NO_LAZY_FETCH: '1' },
  }).then(() => true, () => false);
  const missingBlob = async (rev) => {
    const oid = (await bareGit(['rev-parse', `${rev}:f.txt`], { cwd: clone })).stdout.trim();
    expect(await present(oid)).toBe(false);
    return oid;
  };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'git-ro-partial-'));
    const src = join(base, 'src');
    clone = join(base, 'clone');
    const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    mkdirSync(src);
    await bareGit(['init', '-q'], { cwd: src });
    await bareGit(['config', 'uploadpack.allowFilter', 'true'], { cwd: src });
    for (const content of ['one', 'two', 'three']) {
      writeFileSync(join(src, 'f.txt'), `${content}\n`);
      // eslint-disable-next-line no-await-in-loop
      await bareGit(['add', 'f.txt'], { cwd: src });
      // eslint-disable-next-line no-await-in-loop
      await bareGit([...id, 'commit', '-q', '-m', content], { cwd: src });
    }
    // Only the checked-out version of f.txt is downloaded; the older two are not.
    await bareGit(['clone', '-q', '--filter=blob:none', `file://${src}`, clone], { cwd: base });
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test('a missing object stays missing (control: bare git fetches it)', async () => {
    const oid = await missingBlob('HEAD~1');
    const result = await runReadonlyGit({ subcommand: 'show', args: [oid], root: clone, git: GIT });
    expect(result.ok).toBe(false);
    expect(await present(oid)).toBe(false);
    expect((await bareGit(['show', oid], { cwd: clone })).stdout).toBe('two\n');
    expect(await present(oid)).toBe(true);
  });

  test('each guard holds alone, so git older than 2.44 fetches nothing either', async () => {
    const oid = await missingBlob('HEAD~2');
    for (const dropped of ['GIT_NO_LAZY_FETCH', 'GIT_ALLOW_PROTOCOL']) {
      const env = readonlyGitEnv({ root: clone });
      delete env[dropped];
      // eslint-disable-next-line no-await-in-loop
      const outcome = await bareGit(['show', oid], { cwd: clone, env }).then(() => 'fetched', () => 'refused');
      expect(outcome).toBe('refused');
    }
    expect(await present(oid)).toBe(false);
  });
});
