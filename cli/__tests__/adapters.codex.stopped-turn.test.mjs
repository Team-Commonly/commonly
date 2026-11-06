import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import codex from '../src/lib/adapters/codex.js';

// Each test starts Codex once and waits for it to reach the model.
jest.setTimeout(30000);

const hasCodex = process.platform === 'darwin'
  && spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasCodex) console.warn('adapters.codex.stopped-turn: no codex on this Mac or platform, real-binary check skipped');
const describeWithCodex = hasCodex ? describe : describe.skip;

describeWithCodex('a codex turn stopped by a signal, on the real binary', () => {
  let root;
  let server;

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    rmSync(root, { recursive: true, force: true });
  });

  test('rejects, so the run loop keeps the messages it held', async () => {
    root = mkdtempSync(join(tmpdir(), 'codex-stopped-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    let child;
    let reachedModel;
    const atModel = new Promise((resolve) => { reachedModel = resolve; });
    // Holds the response open, so the turn is mid-flight when the signal lands.
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (!/\/responses$/.test(req.url)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n');
        reachedModel();
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    writeFileSync(join(root, 'config.toml'), [
      'model_provider = "stub"',
      '[model_providers.stub]',
      'name = "stub"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "responses"',
      'env_key = "STUB_KEY"',
    ].join('\n'));

    const turn = codex.spawn('hi', {
      cwd: workspace,
      agentName: 'stopped-turn-test',
      timeoutMs: 25000,
      environment: { model: 'gpt-5.5' },
      env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, STUB_KEY: 'x' },
      _spawnImpl: (command, args, options) => {
        child = spawn(command, args, options);
        return child;
      },
    });
    await Promise.race([atModel, turn]);
    child.kill('SIGTERM');

    // Through the npm launcher this is the exit-0 path; a native codex on PATH
    // dies by the signal and takes the non-zero path. Either way it isn't silent.
    await expect(turn).rejects.toThrow();
  });
});
