import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import qwen from '../src/lib/adapters/qwen.js';
import { detectSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const realSeatbeltTest = process.platform === 'darwin' ? test : test.skip;

realSeatbeltTest('an npm symlink launches Qwen package chunks under real Seatbelt', async () => {
  expect(detectSeatbelt().available).toBe(true);
  const root = await mkdtemp(join(tmpdir(), 'qwen-seatbelt-smoke-'));
  const packageDir = join(root, 'qwen-package');
  const binDir = join(root, 'npm', 'bin');
  const binary = join(binDir, 'qwen');
  const workspace = join(root, 'workspace');
  const keyFile = join(root, 'provider-key');
  try {
    await Promise.all([
      mkdir(join(packageDir, 'chunks'), { recursive: true }),
      mkdir(binDir, { recursive: true }),
      mkdir(workspace),
    ]);
    await writeFile(keyFile, 'smoke-provider-key', { mode: 0o600 });
    await writeFile(join(packageDir, 'chunks', 'probe.cjs'),
      'module.exports = { type: "result", result: "Qwen package chunk loaded" };\n');
    await writeFile(join(packageDir, 'cli.cjs'), [
      `#!${process.execPath}`,
      'if (process.argv.includes("--version")) process.stdout.write("0.25.1\\n");',
      'else process.stdout.write(JSON.stringify(require("./chunks/probe.cjs")) + "\\n");',
      '',
    ].join('\n'), { mode: 0o755 });
    await symlink(join(packageDir, 'cli.cjs'), binary);
    const result = await qwen.spawn('hello', {
      cwd: workspace,
      env: { PATH: dirname(process.execPath) },
      environment: {
        model: 'smoke-model',
        provider: { id: 'smoke', baseURL: 'http://127.0.0.1:9/v1', keyFile },
        sandbox: { trust: 'public', mode: 'workspace' },
        mcp: [],
      },
      agentName: 'qwen-seatbelt-smoke',
      runtimeToken: 'cm_agent_smoke',
      timeoutMs: 15_000,
      _binaryPath: binary,
    });
    expect(result.text).toBe('Qwen package chunk loaded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
