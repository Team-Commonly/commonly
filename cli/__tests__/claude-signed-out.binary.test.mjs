/**
 * F436, on a real process: a fake `claude` that prints Claude Code's signed-out
 * line and exits 1, run by the claude adapter through child_process. The error
 * the adapter throws is the one the run loop acks as a setup fault.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import claude from '../src/lib/adapters/claude.js';
import { CLAUDE_SIGNED_OUT_NOTICE, cantAnswerNotice, isClaudeSignedOut } from '../src/lib/turn-failure-notice.js';

const posixOnly = process.platform === 'win32' ? test.skip : test;

posixOnly('a signed-out claude binary is read as signed out, and the pod line names the fix', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-signed-out-'));
  try {
    for (const dir of ['bin', 'home', 'workspace']) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, 'bin', 'claude'), '#!/bin/sh\necho "Not logged in · Please run /login"\nexit 1\n', { mode: 0o755 });
    const error = await claude.spawn('are you there?', {
      cwd: path.join(root, 'workspace'),
      env: { PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`, HOME: path.join(root, 'home') },
      agentName: 'signed-out-seat',
      instanceId: 'default',
    }).then(() => null, (err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(isClaudeSignedOut(error)).toBe(true);
    expect(cantAnswerNotice(error)?.text).toBe(CLAUDE_SIGNED_OUT_NOTICE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
