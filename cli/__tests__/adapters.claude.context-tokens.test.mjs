import { describe, expect, test } from '@jest/globals';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import claude from '../src/lib/adapters/claude.js';

// The child writes its transcript where its own HOME points, and the adapter
// must read there, not in the operator's ~/.claude. A public seat's child runs
// under an isolated HOME, so the operator path would find nothing.
const fakeChild = () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from('ok'));
    proc.emit('close', 0);
  }, 0);
  return proc;
};

describe('claude adapter reports the turn context from the child HOME', () => {
  test('reads the transcript under the child HOME and returns its token count', async () => {
    const childHome = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const cwd = join(childHome, 'work');
    try {
      const impl = (_cmd, args) => {
        const flag = args.includes('--resume') ? '--resume' : '--session-id';
        const sid = args[args.indexOf(flag) + 1];
        const dir = join(childHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${sid}.jsonl`), `${JSON.stringify({
          type: 'assistant',
          message: { usage: { input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 } },
        })}\n`);
        return fakeChild();
      };
      const res = await claude.spawn('hi', {
        sessionId: 'sid-ctx',
        cwd,
        env: { HOME: childHome },
        memoryLongTerm: '',
        _spawnImpl: impl,
      });
      expect(res.newSessionId).toBe('sid-ctx');
      expect(res.contextTokens).toBe(2104);
    } finally {
      rmSync(childHome, { recursive: true, force: true });
    }
  });

  test('a turn with no transcript reports unknown, so the seat keeps resuming', async () => {
    const childHome = mkdtempSync(join(tmpdir(), 'claude-home-'));
    try {
      const res = await claude.spawn('hi', {
        sessionId: 'sid-none',
        cwd: join(childHome, 'work'),
        env: { HOME: childHome },
        memoryLongTerm: '',
        _spawnImpl: () => fakeChild(),
      });
      expect(res.contextTokens).toBeNull();
    } finally {
      rmSync(childHome, { recursive: true, force: true });
    }
  });
});
