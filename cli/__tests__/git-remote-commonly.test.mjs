import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { startSeatGhBroker } from '../src/lib/host-gh-broker.js';

const runFile = promisify(execFile);
const run = (cwd, args, env = process.env) => runFile('git', args, { cwd, env, timeout: 15_000 });

describe('confined Git remote helper', () => {
  let root;
  let repo;
  let broker;
  let forwarded;
  const seatRef = 'refs/heads/seat/agent123/feature';

  beforeEach(async () => {
    // macOS AF_UNIX paths have a small byte limit; use a short test root.
    root = await mkdtemp('/tmp/hgr-');
    repo = join(root, 'clone');
    await run(root, ['init', '-b', 'main', repo]);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
    await writeFile(join(repo, 'README.md'), 'base\n');
    await run(repo, ['add', '.'], env);
    await run(repo, ['commit', '-m', 'base'], env);
    const { stdout } = await run(repo, ['rev-parse', 'HEAD'], env);
    await run(repo, ['update-ref', 'refs/remotes/origin/main', stdout.trim()], env);
    await writeFile(join(repo, 'README.md'), 'change\n');
    await run(repo, ['commit', '-am', 'change'], env);
    forwarded = [];
    broker = await startSeatGhBroker({
      runtimeToken: 'cm_agent_test', instanceUrl: 'http://localhost:5000',
      root: join(root, 'broker'), shimRoot: root,
      fetchImpl: async (url, request) => {
        forwarded.push({ url: String(url), request: JSON.parse(request.body) });
        return { status: 200, text: async () => JSON.stringify({ result: { ref: seatRef } }) };
      },
    });
  });

  afterEach(async () => {
    await broker?.close();
    await rm(root, { recursive: true, force: true });
  });

  const seatEnv = () => ({ ...process.env, PATH: `${broker.directory}:${process.env.PATH}`,
    COMMONLY_GH_SOCKET: broker.socketPath });

  it('sends one incremental bundle and no credential to the helper', async () => {
    await run(repo, ['push', 'commonly::grant_123', `HEAD:${seatRef}`], seatEnv());
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].url).toMatch(/\/api\/mcp\/grants\/grant_123\/push$/);
    expect(forwarded[0].request.ref).toBe(seatRef);
    expect(forwarded[0].request.baseOid).toMatch(/^[0-9a-f]{40}$/);
    expect(forwarded[0].request.newOid).toMatch(/^[0-9a-f]{40}$/);
    expect(Buffer.from(forwarded[0].request.bundle, 'base64').subarray(0, 7).toString()).toBe('# v2 gi');
    expect(JSON.stringify(forwarded)).not.toContain('cm_agent_test');
  });

  it('refuses a protected branch and multiple refs before forwarding', async () => {
    await expect(run(repo, ['push', 'commonly::grant_123', 'HEAD:refs/heads/main'], seatEnv()))
      .rejects.toThrow();
    await expect(run(repo, ['push', 'commonly::grant_123', `HEAD:${seatRef}`, 'HEAD:refs/heads/main'], seatEnv()))
      .rejects.toThrow();
    expect(forwarded).toHaveLength(0);
  });
});
