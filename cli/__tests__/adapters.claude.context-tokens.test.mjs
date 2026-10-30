import { describe, expect, test } from '@jest/globals';
import { EventEmitter } from 'events';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
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
      const res = await claude.spawn('hi', { environment: { model: 'test-model' },
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

  test('a symlinked cwd is read under its physical path, where claude writes it', async () => {
    const childHome = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const real = join(childHome, 'real-work');
    const link = join(childHome, 'linked-work');
    mkdirSync(real);
    symlinkSync(real, link);
    try {
      const impl = (_cmd, args) => {
        const sid = args[args.indexOf('--session-id') + 1];
        // claude names the folder after process.cwd(), the resolved path.
        const dir = join(childHome, '.claude', 'projects', realpathSync(real).replace(/[^a-zA-Z0-9]/g, '-'));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${sid}.jsonl`), `${JSON.stringify({
          type: 'assistant',
          message: { usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 } },
        })}\n`);
        return fakeChild();
      };
      const res = await claude.spawn('hi', { environment: { model: 'test-model' },
        sessionId: 'sid-link',
        cwd: link,
        env: { HOME: childHome },
        memoryLongTerm: '',
        _spawnImpl: impl,
      });
      expect(res.contextTokens).toBe(507);
    } finally {
      rmSync(childHome, { recursive: true, force: true });
    }
  });

  test('a turn with no transcript reports unknown, so the seat keeps resuming', async () => {
    const childHome = mkdtempSync(join(tmpdir(), 'claude-home-'));
    try {
      const res = await claude.spawn('hi', { environment: { model: 'test-model' },
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

// bwrap wrapping is Linux-only (wrapArgvWithBwrap throws on macOS), so this
// jail case runs in Linux CI and is skipped on a Mac.
const jailTest = process.platform === 'linux' ? test : test.skip;

describe('claude adapter reads the transcript inside a bwrap jail', () => {
  jailTest('bwrap sets the child HOME to the workspace, and the count is read there', async () => {
    const hostHome = mkdtempSync(join(tmpdir(), 'claude-host-'));
    const cwd = join(hostHome, 'workspace');
    mkdirSync(cwd, { recursive: true });
    try {
      const impl = (cmd, args) => {
        const flag = args.includes('--resume') ? '--resume' : '--session-id';
        const sid = args[args.indexOf(flag) + 1];
        const dir = join(cwd, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${sid}.jsonl`), `${JSON.stringify({
          type: 'assistant',
          message: { usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 150000 } },
        })}\n`);
        return fakeChild();
      };
      const res = await claude.spawn('hi', {
        sessionId: 'sid-jail',
        cwd,
        env: { PATH: process.env.PATH, HOME: hostHome },
        environment: { model: 'test-model', sandbox: { trust: 'public', mode: 'bwrap' } },
        memoryLongTerm: '',
        _spawnImpl: impl,
        _detectBwrap: () => ({ available: true, path: 'bwrap' }),
      });
      expect(res.newSessionId).toBe('sid-jail');
      expect(res.contextTokens).toBe(150003);
    } finally {
      rmSync(hostHome, { recursive: true, force: true });
    }
  });
});
