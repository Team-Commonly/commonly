import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import pi from '../src/lib/adapters/pi.js';

// Each test starts pi once and waits for it to reach the model twice.
jest.setTimeout(30000);

const hasPi = process.platform === 'darwin'
  && spawnSync('pi', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasPi) console.warn('adapters.pi.stopped-turn: no pi on this Mac or platform, real-binary check skipped');
const describeWithPi = hasPi ? describe : describe.skip;

const chunk = (delta, finish = null) => `data: ${JSON.stringify({
  id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
})}\n\n`;

const toolRound = (res) => {
  res.write(chunk({ role: 'assistant', content: 'let me look' }));
  res.write(chunk({ tool_calls: [{
    index: 0, id: 'call_1', type: 'function',
    function: { name: 'read', arguments: JSON.stringify({ path: 'note.txt' }) },
  }] }));
  res.write(chunk({}, 'tool_calls'));
  res.end('data: [DONE]\n\n');
};

describeWithPi('a pi turn stopped by a signal, on the real binary', () => {
  let root;
  let server;

  const startTurn = (signalChild) => pi.spawn('hi', {
    cwd: join(root, 'workspace'),
    agentName: 'stopped-turn-test',
    timeoutMs: 25000,
    _piHome: join(root, 'home'),
    environment: {
      model: 'stub-model',
      provider: {
        name: 'stub', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'STUB_KEY',
      },
    },
    env: { PATH: process.env.PATH, HOME: root, STUB_KEY: 'x' },
    _spawnImpl: (command, args, options) => {
      const child = spawn(command, args, options);
      signalChild(child);
      return child;
    },
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    rmSync(root, { recursive: true, force: true });
  });

  test.each(['SIGTERM', 'SIGHUP', 'SIGINT'])('%s after an interim message rejects', async (signal) => {
    root = mkdtempSync(join(tmpdir(), 'pi-stopped-'));
    mkdirSync(join(root, 'workspace'));
    writeFileSync(join(root, 'workspace', 'note.txt'), 'hello\n');
    let child;
    let requests = 0;
    let reachedModelAgain;
    const atModelAgain = new Promise((resolve) => { reachedModelAgain = resolve; });
    // The first reply says something and calls a tool; the second is held open,
    // so the turn has an interim message and is mid-flight when the signal lands.
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requests > 1) { reachedModelAgain(); return; }
        toolRound(res);
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });

    const turn = startTurn((spawned) => { child = spawned; });
    await Promise.race([atModelAgain, turn]);
    child.kill(signal);

    await expect(turn).rejects.toThrow(/stopped before it finished/);
  });

  // Overflow ends the agent run with willRetry false, and pi carries on by
  // compacting, so agent_end alone doesn't mean the turn finished.
  test('SIGTERM during overflow recovery rejects', async () => {
    root = mkdtempSync(join(tmpdir(), 'pi-stopped-'));
    mkdirSync(join(root, 'workspace'));
    // pi keeps the last 20,000 tokens or so, so four small reads give it nothing
    // to compact and the turn just ends.
    writeFileSync(join(root, 'workspace', 'note.txt'), `${'context '.repeat(5000)}\n`);
    let child;
    let requests = 0;
    let reachedCompaction;
    const atCompaction = new Promise((resolve) => { reachedCompaction = resolve; });
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests += 1;
        if (requests <= 4) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          toolRound(res);
        } else if (requests === 5) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: {
            message: 'This model\'s maximum context length is 128000 tokens.', code: 'context_length_exceeded',
          } }));
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          reachedCompaction();
        }
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });

    const turn = startTurn((spawned) => { child = spawned; });
    // Reaching a sixth request proves pi carried on after the overflow: a turn
    // that settled here would have ended without compacting.
    await Promise.race([atCompaction, turn]);
    expect(requests).toBe(6);
    child.kill('SIGTERM');

    await expect(turn).rejects.toThrow(/stopped before it finished/);
  });
});
