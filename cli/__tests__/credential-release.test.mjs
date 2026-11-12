/**
 * F460. A public seat's runtime credential file is deleted as soon as the
 * processes that read it have read it, on every adapter (pi has had this since
 * F146). `armCredentialRelease` is the one place that does the delete:
 * - a stream trigger, `release('stream')`, called by an adapter whose output
 *   has a measured event after every read (pi's first event, OpenCode's
 *   step_start);
 * - a ready-file trigger: every Commonly MCP server (and the broker bridge)
 *   writes its ready file after it has read the credential, so once all exist
 *   the file goes;
 * - a deadline on the ready-file trigger: a server that never gets ready costs
 *   a degraded turn, never a credential readable for the whole turn.
 * A delete that fails stops the turn.
 */
import { jest } from '@jest/globals';
import {
  existsSync, mkdtempSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { armCredentialRelease, writeCredentialFile } from '../src/lib/credential-file.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'credential-release-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const fakeTimers = () => {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const add = (fn, ms, repeat) => { seq += 1; pending.set(seq, { at: now + ms, fn, ms, repeat }); return seq; };
  return {
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, false),
      clearTimeout: (id) => pending.delete(id),
      setInterval: (fn, ms) => add(fn, ms, true),
      clearInterval: (id) => pending.delete(id),
    },
    advance: (ms) => {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.repeat) t.at += t.ms; else pending.delete(id);
        t.fn();
      }
      now = until;
    },
    get pending() { return pending.size; },
  };
};

const credentialFile = () => writeCredentialFile('cm_agent_release_test', { agentName: 'seat', root });

describe('the stream trigger', () => {
  test('release deletes the credential folder once, and says why', () => {
    const credential = credentialFile();
    const release = armCredentialRelease(credential, { label: 'test seat' });
    expect(existsSync(credential.path)).toBe(true);
    expect(release.release('stream')).toBeNull();
    expect(existsSync(credential.dir)).toBe(false);
    expect(release.reason).toBe('stream');
    // A second call is a no-op.
    expect(release.release('ready')).toBeNull();
    expect(release.reason).toBe('stream');
  });

  test('a delete that fails stops the turn and names the file, not its contents', () => {
    const credential = credentialFile();
    const onFailure = jest.fn();
    const release = armCredentialRelease(credential, {
      label: 'test seat',
      onFailure,
      fs: { rmSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); }, existsSync },
    });
    const error = release.release('stream');
    expect(error.message).toMatch(/test seat could not delete its runtime credential \(.*token\).*EACCES.*stopped/);
    expect(error.message).not.toMatch(/cm_agent_release_test/);
    expect(onFailure).toHaveBeenCalledWith(error);
    expect(release.error).toBe(error);
  });

  test('no credential (a seat without a token) arms nothing', () => {
    const release = armCredentialRelease(null, { readyFiles: [join(root, 'never')] });
    expect(release.release('stream')).toBeNull();
    expect(release.reason).toBeNull();
  });
});

describe('the ready-file trigger', () => {
  test('the credential goes once every ready file exists, not before', () => {
    const credential = credentialFile();
    const clock = fakeTimers();
    const ready = [join(root, 'commonly.ready'), join(root, 'broker.ready')];
    const release = armCredentialRelease(credential, { readyFiles: ready, timers: clock.timers, pollMs: 50 });
    clock.advance(200);
    expect(existsSync(credential.path)).toBe(true);
    writeFileSync(ready[0], '');
    clock.advance(200);
    expect(existsSync(credential.path)).toBe(true);
    writeFileSync(ready[1], '');
    clock.advance(50);
    expect(existsSync(credential.dir)).toBe(false);
    expect(release.reason).toBe('ready');
    // Nothing left scheduled.
    expect(clock.pending).toBe(0);
  });

  test('a server that never gets ready: the credential goes at the deadline anyway, with a warning', () => {
    const credential = credentialFile();
    const clock = fakeTimers();
    const warn = jest.fn();
    const ready = [join(root, 'commonly.ready')];
    const release = armCredentialRelease(credential, {
      readyFiles: ready, timers: clock.timers, pollMs: 50, deadlineMs: 30000, warn, label: 'test seat',
    });
    clock.advance(29950);
    expect(existsSync(credential.path)).toBe(true);
    clock.advance(50);
    expect(existsSync(credential.dir)).toBe(false);
    expect(release.reason).toBe('deadline');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/test seat.*not ready after 30s.*commonly\.ready.*deleted/));
    expect(clock.pending).toBe(0);
  });

  test('a stream release before the ready files stops the poll and the deadline', () => {
    const credential = credentialFile();
    const clock = fakeTimers();
    const release = armCredentialRelease(credential, { readyFiles: [join(root, 'x.ready')], timers: clock.timers });
    release.release('stream');
    expect(clock.pending).toBe(0);
    expect(release.reason).toBe('stream');
  });

  test('stop() at the end of the spawn clears the timers and leaves the file to the spawn cleanup', () => {
    const credential = credentialFile();
    const clock = fakeTimers();
    const release = armCredentialRelease(credential, { readyFiles: [join(root, 'x.ready')], timers: clock.timers });
    release.stop();
    expect(clock.pending).toBe(0);
    clock.advance(60000);
    expect(existsSync(credential.path)).toBe(true);
    expect(release.reason).toBeNull();
  });

  test('a failed delete from a timer reaches onFailure', () => {
    const credential = credentialFile();
    const clock = fakeTimers();
    const onFailure = jest.fn();
    const ready = join(root, 'commonly.ready');
    writeFileSync(ready, '');
    armCredentialRelease(credential, {
      readyFiles: [ready], timers: clock.timers, onFailure,
      fs: { rmSync: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }, existsSync },
    });
    clock.advance(100);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/EBUSY/) }));
  });

  test('an empty ready list releases at once: there is no reader to wait for', () => {
    const credential = credentialFile();
    const clock = fakeTimers();
    const release = armCredentialRelease(credential, { readyFiles: [], timers: clock.timers });
    expect(existsSync(credential.dir)).toBe(false);
    expect(release.reason).toBe('ready');
  });
});

describe('an adapter with a trigger of its own (OpenCode)', () => {
  test('an empty ready list waits for its release(), with the deadline still armed', () => {
    const credential = credentialFile();
    const clock = fakeTimers();
    const release = armCredentialRelease(credential, { readyFiles: [], ownTrigger: true, timers: clock.timers });
    expect(existsSync(credential.path)).toBe(true);
    clock.advance(1000);
    expect(existsSync(credential.path)).toBe(true);
    release.release('stream');
    expect(existsSync(credential.dir)).toBe(false);
    expect(release.reason).toBe('stream');
    expect(clock.pending).toBe(0);
  });

  test('its runtime never reaches that point: the credential goes at the deadline, with a warning', () => {
    const credential = credentialFile();
    const clock = fakeTimers();
    const warn = jest.fn();
    const release = armCredentialRelease(credential, {
      readyFiles: [], ownTrigger: true, timers: clock.timers, deadlineMs: 30000, warn, label: 'test seat',
    });
    clock.advance(30000);
    expect(existsSync(credential.dir)).toBe(false);
    expect(release.reason).toBe('deadline');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/test seat.*never reported them started.*deleted anyway/));
  });

  test('named ready files still release it when they all exist first', () => {
    const credential = credentialFile();
    const clock = fakeTimers();
    const ready = join(root, 'commonly.ready');
    const release = armCredentialRelease(credential, {
      readyFiles: [ready], ownTrigger: true, timers: clock.timers, pollMs: 50,
    });
    writeFileSync(ready, '');
    clock.advance(50);
    expect(release.reason).toBe('ready');
    expect(existsSync(credential.dir)).toBe(false);
  });
});
