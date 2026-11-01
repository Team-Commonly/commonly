const { execFile } = require('child_process');
const { mkdtemp, mkdir, rename, rm, writeFile } = require('fs/promises');
const { tmpdir } = require('os');
const { dirname, join } = require('path');
const { promisify } = require('util');
const {
  parseSeatPushArgs, fetchProviderObjects, pushWithLease, validateSeatBundle, PROVIDER_GIT_MAX_BUFFER,
} = require('../../../services/seatGithubPush');

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
    await expect(validateSeatBundle({ defaultTip: baseOid, git, repo: receiver, bundlePath, baseOid, oldOid, newOid }))
      .resolves.toBeUndefined();
  });

  it('fetches a current seat tip used as the bundle prerequisite', async () => {
    const provider = join(root, 'provider.git');
    const freshReceiver = join(root, 'fresh.git');
    const ref = 'refs/heads/seat/agent123/work';
    await git(['init', '--bare', provider], root);
    await git(['update-ref', 'refs/heads/main', baseOid], source);
    await git(['fetch', source, 'refs/heads/main'], provider);
    await git(['fetch', source, oldOid], provider);
    await git(['update-ref', 'refs/heads/main', baseOid], provider);
    await git(['update-ref', ref, oldOid], provider);
    await git(['init', '--bare', freshReceiver], root);
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${oldOid}`], source);
    const boundGit = (args, cwd = freshReceiver, failure) => git(args, cwd, failure);
    const defaultTip = await fetchProviderObjects({ git: boundGit, url: provider, defaultRef: 'refs/heads/main', ref, oldOid });
    expect(defaultTip).toBe(baseOid);
    await expect(validateSeatBundle({ defaultTip, git: boundGit, repo: freshReceiver, bundlePath,
      baseOid: oldOid, oldOid, newOid })).resolves.toBeUndefined();
  });

  it('fetches provider history without file contents and still proves and pushes a change', async () => {
    const provider = join(root, 'provider.git');
    const fresh = join(root, 'blobless.git');
    const ref = 'refs/heads/seat/agent123/work';
    await git(['init', '--bare', provider], root);
    await git(['config', 'uploadpack.allowFilter', 'true'], provider);
    await git(['fetch', source, `${baseOid}:refs/heads/main`], provider);
    await git(['init', '--bare', fresh], root);
    const boundGit = (args, cwd = fresh, failure) => git(args, cwd, failure);
    const zero = '0'.repeat(40);
    const defaultTip = await fetchProviderObjects({ git: boundGit, url: provider, defaultRef: 'refs/heads/main', ref, oldOid: zero });

    // The base commit and its tree arrived; its file contents did not.
    const baseBlob = await git(['rev-parse', `${baseOid}:README.md`], source);
    const objects = await git(['rev-list', '--objects', '--missing=print', baseOid], fresh);
    expect(objects.split('\n')).toContain(`?${baseBlob}`);

    await validateSeatBundle({ defaultTip, git: boundGit, repo: fresh, bundlePath, baseOid, oldOid: zero, newOid });
    await pushWithLease({ git: boundGit, repo: fresh, url: provider, ref, oldOid: zero, newOid });
    expect(await git(['rev-parse', ref], provider)).toBe(newOid);
    await git(['fsck', '--connectivity-only', newOid], provider);
  });

  it('uses a zero-OID lease for a fresh branch and refuses a stale provider ref', async () => {
    const provider = join(root, 'provider.git');
    const ref = 'refs/heads/seat/agent123/work';
    await git(['init', '--bare', provider], root);
    await validateSeatBundle({ defaultTip: baseOid, git, repo: receiver, bundlePath, baseOid, oldOid: '0'.repeat(40), newOid });
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
    await validateSeatBundle({ defaultTip: baseOid, git, repo: receiver, bundlePath, baseOid, oldOid, newOid });
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
    await expect(validateSeatBundle({ defaultTip: baseOid,
      git, repo: receiver, bundlePath, baseOid, oldOid, newOid: divergentOid,
    })).rejects.toMatchObject({ code: 'non_fast_forward', statusCode: 409 });
  });

  it('refuses a second advertised ref before unbundling', async () => {
    await git(['branch', 'second', oldOid], source);
    await git(['bundle', 'create', bundlePath, 'HEAD', 'refs/heads/second', `^${baseOid}`], source);
    await expect(validateSeatBundle({ defaultTip: baseOid, git, repo: receiver, bundlePath, baseOid, oldOid, newOid }))
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

  it.each([
    ['.github/workflows/seat.yml', false],
    ['.github/actions/seat/action.yml', true],
    ['CODEOWNERS', false],
    ['.github/CODEOWNERS', true],
    ['docs/CODEOWNERS', false],
  ])('refuses protected path %s before a provider ref update (fresh=%s)', async (file, fresh) => {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await writeFile(join(source, file), 'unapproved policy\n');
    await git(['add', '.'], source);
    await git(['commit', '-m', 'policy change'], source);
    const tip = await git(['rev-parse', 'HEAD'], source);
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${baseOid}`], source);
    const ref = 'refs/heads/seat/agent123/work';
    if (!fresh) await git(['update-ref', ref, oldOid], receiver);
    const providerGit = jest.fn((args, cwd, failure) => git(args, cwd, failure));
    await expect((async () => {
      await validateSeatBundle({ defaultTip: baseOid, git, repo: receiver, bundlePath, baseOid,
        oldOid: fresh ? '0'.repeat(40) : oldOid, newOid: tip });
      await pushWithLease({ git: providerGit, repo: receiver, url: receiver, ref,
        oldOid: fresh ? '0'.repeat(40) : oldOid, newOid: tip });
    })()).rejects.toMatchObject({ code: 'push_protected_path', statusCode: 403 });
    expect(providerGit).not.toHaveBeenCalled();
    expect(await git(['for-each-ref', '--format=%(objectname)', ref], receiver))
      .toBe(fresh ? '' : oldOid);
  });

  it.each(['rename', 'delete', 'revert'])('refuses a protected path %s even when the final name is harmless', async (operation) => {
    const file = join(source, '.github/workflows/seat.yml');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'workflow\n');
    await git(['add', '.'], source);
    await git(['commit', '-m', 'workflow baseline'], source);
    const policyBase = await git(['rev-parse', 'HEAD'], source);
    await git(['fetch', source, policyBase], receiver);
    if (operation === 'rename') await rename(file, join(source, 'ordinary.yml'));
    else if (operation === 'delete') await rm(file);
    else await writeFile(file, 'changed workflow\n');
    await git(['add', '-A'], source);
    await git(['commit', '-m', operation], source);
    if (operation === 'revert') {
      await writeFile(file, 'workflow\n');
      await git(['commit', '-am', 'restore workflow'], source);
    }
    const tip = await git(['rev-parse', 'HEAD'], source);
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${policyBase}`], source);
    await expect(validateSeatBundle({ defaultTip: policyBase, git, repo: receiver, bundlePath,
      baseOid: policyBase, oldOid: policyBase, newOid: tip }))
      .rejects.toMatchObject({ code: 'push_protected_path', statusCode: 403 });
  });
});

// The proof runs in a blobless repo whose promisor remote fetches a missing
// object on demand, so these build the provider the way GitHub serves it:
// filters allowed and any reachable object fetchable by id.
describe('seat push proof against the default branch', () => {
  let root;
  let work;
  let provider;
  let bundlePath;
  const zero = '0'.repeat(40);
  const commit = async (files, message) => {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(work, name)), { recursive: true });
      await writeFile(join(work, name), text);
    }
    await git(['add', '-A'], work);
    await git(['commit', '-m', message], work);
    return git(['rev-parse', 'HEAD'], work);
  };
  const publish = async (refs) => {
    for (const [ref, oid] of Object.entries(refs)) await git(['push', '-q', '-f', provider, `${oid}:${ref}`], work);
  };
  const receiverFor = async (ref, oldOid) => {
    const repo = join(root, `receiver-${Math.random().toString(16).slice(2)}.git`);
    await git(['init', '--bare', repo], root);
    const boundGit = (args, cwd = repo, failure) => git(args, cwd, failure);
    const defaultTip = await fetchProviderObjects({ git: boundGit, url: provider, defaultRef: 'refs/heads/main', ref, oldOid });
    return { repo, boundGit, defaultTip };
  };
  const ref = 'refs/heads/seat/agent123/work';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'seat-push-default-'));
    work = join(root, 'work');
    provider = join(root, 'provider.git');
    bundlePath = join(root, 'push.bundle');
    await git(['init', '-b', 'main', work], root);
    await git(['init', '--bare', provider], root);
    await git(['config', 'uploadpack.allowFilter', 'true'], provider);
    await git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], provider);
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('refuses a base on another provider ref, even one this repo would fetch on demand', async () => {
    const base = await commit({ 'README.md': 'base\n' }, 'base');
    const other = await commit({ '.github/workflows/x.yml': 'on: push\n' }, 'workflow on another ref');
    await publish({ 'refs/heads/main': base, 'refs/heads/other': other });
    const tip = await commit({ 'b.txt': 'harmless\n' }, 'harmless');
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${other}`], work);
    const { repo, boundGit, defaultTip } = await receiverFor(ref, zero);

    await expect(validateSeatBundle({ git: boundGit, repo, bundlePath, baseOid: other, oldOid: zero, newOid: tip, defaultTip }))
      .rejects.toMatchObject({ code: 'bundle_base_not_in_provider', statusCode: 400 });
  });

  // Production runs git under PROVIDER_GIT_MAX_BUFFER. A check that lists every
  // changed name fails there for a branch far behind the default branch.
  const cappedGit = (repo) => async (args, cwd = repo, failure) => {
    try {
      return (await runFile('git', args, { cwd, env, maxBuffer: PROVIDER_GIT_MAX_BUFFER })).stdout.trim();
    } catch {
      throw failure || Object.assign(new Error('provider_git_failed'), { code: 'provider_git_failed' });
    }
  };

  it('pushes a seat branch far behind a default branch that changed more names than the git buffer holds', async () => {
    const base = await commit({ 'README.md': 'base\n' }, 'base');
    await git(['checkout', '-q', '-b', 'seat'], work);
    const tip = await commit({ 'b.txt': 'harmless\n' }, 'harmless');
    await git(['checkout', '-q', 'main'], work);
    const many = {};
    const pad = 'x'.repeat(60);
    for (let i = 0; i < 1200; i += 1) many[`generated/${pad}-${i}.txt`] = `${i}\n`;
    const mainTip = await commit(many, 'many files');
    const names = await git(['diff', '--name-only', '-z', mainTip, tip], work);
    expect(names.length).toBeGreaterThan(PROVIDER_GIT_MAX_BUFFER);
    await publish({ 'refs/heads/main': mainTip });
    await git(['checkout', '-q', 'seat'], work);
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${base}`], work);
    const { repo, defaultTip } = await receiverFor(ref, zero);

    await expect(validateSeatBundle({
      git: cappedGit(repo), repo, bundlePath, baseOid: base, oldOid: zero, newOid: tip, defaultTip,
    })).resolves.toBeUndefined();
  });

  it('refuses a protected edit inside a merged side branch even when that branch undid it', async () => {
    const base = await commit({ 'README.md': 'base\n' }, 'base');
    await publish({ 'refs/heads/main': base });
    await git(['checkout', '-q', '-b', 'side'], work);
    await commit({ '.github/workflows/evil.yml': 'on: push\n' }, 'add workflow');
    await git(['rm', '-q', '.github/workflows/evil.yml'], work);
    await git(['commit', '-q', '-m', 'remove workflow'], work);
    await git(['checkout', '-q', '-b', 'seat', base], work);
    await commit({ 'b.txt': 'harmless\n' }, 'harmless');
    await git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], work);
    const tip = await git(['rev-parse', 'HEAD'], work);
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${base}`], work);
    const { repo, defaultTip } = await receiverFor(ref, zero);

    await expect(validateSeatBundle({
      git: cappedGit(repo), repo, bundlePath, baseOid: base, oldOid: zero, newOid: tip, defaultTip,
    })).rejects.toMatchObject({ code: 'push_protected_path', statusCode: 403 });
  });

  it('refuses workflow files rolled back from an earlier default-branch commit', async () => {
    await commit({ 'README.md': 'base\n' }, 'base');
    const vulnerable = await commit({ '.github/workflows/ci.yml': 'v1\n' }, 'workflow v1');
    const fixed = await commit({ '.github/workflows/ci.yml': 'v2\n' }, 'workflow v2');
    await publish({ 'refs/heads/main': fixed });
    await git(['checkout', '-q', '-b', 'seat', vulnerable], work);
    const tip = await commit({ 'b.txt': 'harmless\n' }, 'harmless');
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${vulnerable}`], work);
    const { repo, boundGit, defaultTip } = await receiverFor(ref, zero);

    await expect(validateSeatBundle({ git: boundGit, repo, bundlePath, baseOid: vulnerable, oldOid: zero, newOid: tip, defaultTip }))
      .rejects.toMatchObject({ code: 'protected_path_behind_default', statusCode: 409 });
  });

  it('accepts a seat branch that merges a default branch whose workflows changed', async () => {
    await commit({ 'README.md': 'base\n' }, 'base');
    const start = await commit({ '.github/workflows/ci.yml': 'v1\n' }, 'workflow v1');
    await git(['checkout', '-q', '-b', 'seat', start], work);
    const seatTip = await commit({ 'b.txt': 'seat work\n' }, 'seat work');
    await git(['checkout', '-q', 'main'], work);
    const moved = await commit({ '.github/workflows/ci.yml': 'v2\n' }, 'workflow v2');
    await publish({ 'refs/heads/main': moved, [ref]: seatTip });
    await git(['checkout', '-q', 'seat'], work);
    await git(['merge', '-q', '--no-edit', 'main'], work);
    const merged = await git(['rev-parse', 'HEAD'], work);
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${seatTip}`, `^${moved}`], work);
    const { repo, boundGit, defaultTip } = await receiverFor(ref, seatTip);

    await validateSeatBundle({ git: boundGit, repo, bundlePath, baseOid: seatTip, oldOid: seatTip, newOid: merged, defaultTip });
    await pushWithLease({ git: boundGit, repo, url: provider, ref, oldOid: seatTip, newOid: merged });
    expect(await git(['rev-parse', ref], provider)).toBe(merged);
  });

  it('proves and pushes a thin bundle whose deltas need provider contents it did not fetch', async () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i} of a long tracked file`).join('\n');
    const base = await commit({ 'big.txt': `${lines}\n` }, 'base');
    await publish({ 'refs/heads/main': base });
    const tip = await commit({ 'big.txt': `${lines}\nchanged\n` }, 'edit one line');
    await git(['bundle', 'create', bundlePath, 'HEAD', `^${base}`], work);
    const { repo, boundGit, defaultTip } = await receiverFor(ref, zero);
    const baseBlob = await git(['rev-parse', `${base}:big.txt`], work);
    expect((await git(['rev-list', '--objects', '--missing=print', base], repo)).split('\n')).toContain(`?${baseBlob}`);

    await validateSeatBundle({ git: boundGit, repo, bundlePath, baseOid: base, oldOid: zero, newOid: tip, defaultTip });
    // The bundle carried the edit as a delta against that blob, so unpacking it
    // fetched the one base it needed from the provider.
    expect((await git(['rev-list', '--objects', '--missing=print', base], repo)).split('\n')).not.toContain(`?${baseBlob}`);
    await pushWithLease({ git: boundGit, repo, url: provider, ref, oldOid: zero, newOid: tip });
    expect(await git(['rev-parse', ref], provider)).toBe(tip);
    await git(['fsck', '--connectivity-only', tip], provider);
  });
});
