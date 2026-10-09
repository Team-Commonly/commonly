import { createServer } from 'http';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { existsSync, realpathSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import opencode from '../src/lib/adapters/opencode.js';
import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const smokeBinary = process.env.COMMONLY_OPENCODE_SMOKE_BINARY;
const realSeatbeltTest = process.platform === 'darwin' && smokeBinary ? test : test.skip;

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject);
    resolve(server.address().port);
  });
});

const writeJson = (response, body) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const runRealSeatbeltTurn = async ({ removeXdgGitignore = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-seatbelt-smoke-'));
  const workspace = join(root, 'workspace');
  const keyFile = join(root, 'provider-key');
  const marker = 'Seatbelt startup reached the local provider';
  const observed = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    observed.push({ path: request.url, authorization: request.headers.authorization, body });
    if (request.url === '/v1/models') {
      writeJson(response, {
        object: 'list',
        data: [{ id: 'seatbelt-smoke-model', object: 'model', created: 0, owned_by: 'local' }],
      });
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(body);
    if (parsed.stream) {
      const chunk = {
        id: 'chatcmpl-seatbelt-smoke',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'seatbelt-smoke-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: marker }, finish_reason: null }],
      };
      const finalChunk = {
        id: 'chatcmpl-seatbelt-smoke',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'seatbelt-smoke-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`);
      return;
    }
    writeJson(response, {
      id: 'chatcmpl-seatbelt-smoke',
      object: 'chat.completion',
      created: 0,
      model: 'seatbelt-smoke-model',
      choices: [{ index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });

  try {
    await mkdir(workspace);
    await writeFile(keyFile, 'provider-smoke-secret');
    await chmod(keyFile, 0o600);
    const upstreamPort = await listen(upstream);
    const result = await opencode.spawn('Reply with a short greeting.', {
      cwd: workspace,
      env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
      environment: {
        model: 'seatbelt-smoke-model',
        provider: {
          id: 'seatbelt-smoke',
          baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
          keyFile,
          models: { 'seatbelt-smoke-model': { name: 'Seatbelt smoke model' } },
        },
        sandbox: { trust: 'public', mode: 'workspace' },
      },
      agentName: 'seatbelt-smoke',
      runtimeToken: 'seatbelt-smoke-runtime-token',
      timeoutMs: 45_000,
      _opencodeHomeRoot: join(root, 'seat-state'),
      _binaryPath: realpathSync(smokeBinary),
      _wrapArgvWithSeatbelt: (argv, options) => {
        if (removeXdgGitignore) {
          const gitignore = join(options.mcpConfigDir, 'xdg-config', 'opencode', '.gitignore');
          expect(existsSync(gitignore)).toBe(true);
          unlinkSync(gitignore);
        }
        return wrapArgvWithSeatbelt(argv, options);
      },
    });

    expect(result.text).toContain(marker);
    expect(observed.some((request) => request.path === '/v1/chat/completions')).toBe(true);
    expect(observed.every((request) => request.authorization === 'Bearer provider-smoke-secret')).toBe(true);
  } finally {
    upstream.closeAllConnections?.();
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
};

realSeatbeltTest('real OpenCode starts under Seatbelt with pre-created read-only config roots', async () => {
  await runRealSeatbeltTurn();
});

realSeatbeltTest('removing the pre-created XDG ignore file makes OpenCode fail at its write', async () => {
  await expect(runRealSeatbeltTurn({ removeXdgGitignore: true })).rejects.toThrow(
    /FileSystem\.writeFile .*xdg-config[\\/]opencode[\\/]\.gitignore/,
  );
});
