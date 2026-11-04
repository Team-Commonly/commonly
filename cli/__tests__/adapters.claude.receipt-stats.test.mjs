// D245 item 4: the Claude adapter hands the run's own stats to the reply
// receipt. Without this wiring every receipt test stays green while Claude
// receipts lose their model, turns and tools.
import { describe, expect, test } from '@jest/globals';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import claude from '../src/lib/adapters/claude.js';

const streamJson = [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'result', num_turns: 2, result: 'Done.' },
].map((event) => JSON.stringify(event)).join('\n');

const childWriting = (stdout) => () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);
  return proc;
};

describe('claude adapter returns run stats for the reply receipt', () => {
  test('model, turns and tools come back on the spawn result', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-receipt-'));
    try {
      const res = await claude.spawn('hi', {
        environment: { model: 'claude-opus-5-5' },
        sessionId: 'sid-receipt',
        cwd: join(home, 'work'),
        env: { HOME: home },
        memoryLongTerm: '',
        _spawnImpl: childWriting(streamJson),
      });
      expect(res.stats).toEqual({ model: 'claude-opus-5-5', turns: 2, tools: ['Read'] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
