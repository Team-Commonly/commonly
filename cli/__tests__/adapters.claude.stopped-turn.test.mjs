import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import claude from '../src/lib/adapters/claude.js';

// Each test starts Claude Code once and waits for it to reach the model.
jest.setTimeout(30000);

const hasClaude = process.platform === 'darwin'
  && spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasClaude) console.warn('adapters.claude.stopped-turn: no claude on this Mac or platform, real-binary check skipped');
const describeWithClaude = hasClaude ? describe : describe.skip;

const sse = (res, type, body = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
const opening = (res) => sse(res, 'message_start', {
  message: {
    id: 'm1', type: 'message', role: 'assistant', model: 'claude-stub', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  },
});

describeWithClaude('a claude turn stopped by a signal, on the real binary', () => {
  let root;
  let server;

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    rmSync(root, { recursive: true, force: true });
  });

  // SIGINT is the exit-0 path: claude prints no result event and exits clean, so
  // only the stream shows the turn never finished. SIGTERM reaches the exit code.
  test.each([
    ['SIGINT', /stopped before it finished/],
    ['SIGTERM', /exited with code 143/],
  ])('%s after an interim message rejects', async (signal, failure) => {
    root = mkdtempSync(join(tmpdir(), 'claude-stopped-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    mkdirSync(join(root, 'config'));
    writeFileSync(join(workspace, 'note.txt'), 'hello\n');
    let child;
    let requests = 0;
    let reachedModelAgain;
    const atModelAgain = new Promise((resolve) => { reachedModelAgain = resolve; });
    // The first reply says something and calls a tool; the second is held open,
    // so the turn has an interim message and is mid-flight when the signal lands.
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (data) => { raw += data; });
      req.on('end', () => {
        if (!/\/messages/.test(req.url) || !(JSON.parse(raw || '{}').tools || []).length) {
          res.writeHead(404);
          res.end();
          return;
        }
        requests += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requests > 1) { reachedModelAgain(); return; }
        opening(res);
        sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'let me look' } });
        sse(res, 'content_block_stop', { index: 0 });
        sse(res, 'content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } });
        sse(res, 'content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: 'note.txt' }) } });
        sse(res, 'content_block_stop', { index: 1 });
        sse(res, 'message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
        sse(res, 'message_stop');
        res.end();
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });

    const turn = claude.spawn('hi', {
      cwd: workspace,
      agentName: 'stopped-turn-test',
      timeoutMs: 25000,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        ANTHROPIC_API_KEY: 'stub-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      _spawnImpl: (command, args, options) => {
        child = spawn(command, args, options);
        return child;
      },
    });
    await Promise.race([atModelAgain, turn]);
    // Within tens of ms of the request SIGINT can get an error result instead;
    // from 100 ms on it was the path with no result event, 18 of 18.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    child.kill(signal);

    await expect(turn).rejects.toThrow(failure);
  });
});
