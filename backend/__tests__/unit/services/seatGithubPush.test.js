const { execFile } = require('child_process');
const { mkdtemp, rm, writeFile } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const { promisify } = require('util');
const { parseSeatPushArgs, pushWithLease, validateSeatBundle } = require('../../../services/seatGithubPush');

const runFile = promisify(execFile);
const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' };
const git = async (args, cwd, failure) => {
  try { return (await runFile('git', args, { cwd, env })).stdout.trim(); } catch {
    throw failure || new Error('git failed');
  }
};

describe('seat GitHub push proof', () => {
  let root;
  let source;
  let receiver;
  let baseOid;
  let oldOid;
  let newOid;
  let bundlePath;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'seat-push-proof-'));
    source = join(root, 'source');
    receiver = join(root, 'receiver.git');
    bundlePath = join(root, 'branch.bundle');
    await git(['init', '-b', 'main', source], root);
    await writeFile(join(source, 'README.md'), 'base\n');
    await git(['add', '.'], source);
    await git(['commit', '-m', 'base'], source);
    baseOid = await git(['rev-parse', 'HEAD'], source);
    await git(['checkout', '-b', 'seat'], source);
    await writeFile(join(source, 'README.md'), 'old\n');
    await git(['commit', '-am', 'old'], source);
    oldOid = await git(['rev-parse', 'HEAD'], source);
    await writeFile(join(source, 'README.md'), 'new\n');
    await git(['commit', '-am', 'new'], source);
    newOid = await git(['rev-parse', 'HEAD'], source);
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${baseOid}`], source);
    await git(['init', '--bare', receiver], root);
    await git(['fetch', source, baseOid], receiver);
    await git(['fetch', source, oldOid], receiver);
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('accepts an incremental bundle whose old ref is an ancestor', async () => {
    await expect(validateSeatBundle({ git, repo: receiver, bundlePath, baseOid, oldOid, newOid }))
      .resolves.toBeUndefined();
  });

  it('uses a zero-OID lease for a fresh branch and refuses a stale provider ref', async () => {
    const provider = join(root, 'provider.git');
    const ref = 'refs/heads/seat/agent123/work';
    await git(['init', '--bare', provider], root);
    await validateSeatBundle({ git, repo: receiver, bundlePath, baseOid, oldOid: '0'.repeat(40), newOid });
    await pushWithLease({ git, repo: receiver, url: provider, ref, oldOid: '0'.repeat(40), newOid });
    expect(await git(['rev-parse', ref], provider)).toBe(newOid);
    await git(['update-ref', ref, oldOid], provider);
    await expect(pushWithLease({
      git, repo: receiver, url: provider, ref, oldOid: '0'.repeat(40), newOid,
    })).rejects.toMatchObject({ code: 'stale_ref', statusCode: 409 });
  });

  it('updates an existing branch only while its old OID matches', async () => {
    const provider = join(root, 'provider.git');
    const ref = 'refs/heads/seat/agent123/work';
    await git(['init', '--bare', provider], root);
    await git(['fetch', source, oldOid], provider);
    await git(['update-ref', ref, oldOid], provider);
    await validateSeatBundle({ git, repo: receiver, bundlePath, baseOid, oldOid, newOid });
    await pushWithLease({ git, repo: receiver, url: provider, ref, oldOid, newOid });
    expect(await git(['rev-parse', ref], provider)).toBe(newOid);
    await expect(pushWithLease({ git, repo: receiver, url: provider, ref, oldOid, newOid: baseOid }))
      .rejects.toMatchObject({ code: 'stale_ref' });
  });

  it('refuses a divergent update even when the old OID is current', async () => {
    await git(['checkout', '-b', 'divergent', baseOid], source);
    await writeFile(join(source, 'README.md'), 'other\n');
    await git(['commit', '-am', 'other'], source);
    const divergentOid = await git(['rev-parse', 'HEAD'], source);
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${baseOid}`], source);
    await expect(validateSeatBundle({
      git, repo: receiver, bundlePath, baseOid, oldOid, newOid: divergentOid,
    })).rejects.toMatchObject({ code: 'non_fast_forward', statusCode: 409 });
  });

  it('refuses a second advertised ref before unbundling', async () => {
    await git(['branch', 'second', oldOid], source);
    await git(['bundle', 'create', bundlePath, 'HEAD', 'refs/heads/second', `^${baseOid}`], source);
    await expect(validateSeatBundle({ git, repo: receiver, bundlePath, baseOid, oldOid, newOid }))
      .rejects.toMatchObject({ code: 'bundle_ref_invalid' });
  });

  it('binds the ref to the authenticated seat and refuses tags/deletion shapes', () => {
    const args = { ref: 'refs/heads/seat/agent123/work', baseOid, newOid, bundle: 'YWJj' };
    expect(parseSeatPushArgs(args, 'agent123')).toEqual(args);
    for (const ref of ['refs/heads/main', 'refs/tags/v1', 'refs/heads/seat/other/work',
      'refs/heads/seat/agent123/../main', 'refs/heads/seat/agent123/work.lock']) {
      expect(() => parseSeatPushArgs({ ...args, ref }, 'agent123')).toThrow('push_args_invalid');
    }
    expect(() => parseSeatPushArgs({ ...args, repository: 'other/repo' }, 'agent123'))
      .toThrow('push_args_invalid');
  });
});
