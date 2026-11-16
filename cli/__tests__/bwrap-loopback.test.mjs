/**
 * F540: a public OpenCode seat on Linux runs inside bubblewrap with a private
 * network of its own, and raises that network's loopback with CAP_NET_ADMIN.
 * A host can start bubblewrap's namespace and still refuse that capability:
 * Ubuntu 26.04 does (GitHub run 43770297952: "RTNETLINK answers: Operation not
 * permitted"), and so does Ubuntu's bwrap-userns-restrict AppArmor profile,
 * under which what bubblewrap starts gets no capabilities. detectBwrap only
 * proves the namespace, so detectBwrapLoopback probes the capability too.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  detectBwrapLoopback,
  wrapArgvWithBwrap,
  LOOPBACK_ISOLATION_FLAGS,
  IP_CANDIDATES,
} from '../src/lib/sandbox/bwrap.js';

const onLinux = process.platform === 'linux';
const itLinux = onLinux ? test : test.skip;

const ok = { status: 0, stdout: 'bubblewrap 0.11.0', stderr: '' };
const recorder = (results) => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ argv: [cmd, ...args], opts }); return results.shift(); };
  return { spawn, calls };
};
const ipAt = (path) => (candidate) => candidate === path;

describe('detectBwrapLoopback', () => {
  test('off Linux it names the platform and runs nothing', () => {
    const { spawn, calls } = recorder([]);
    const res = detectBwrapLoopback({ spawn, platform: 'darwin', exists: ipAt('/usr/sbin/ip') });
    expect(res.available).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('a host that raises the loopback is available', () => {
    const { spawn, calls } = recorder([ok]);
    expect(detectBwrapLoopback({ spawn, platform: 'linux', exists: ipAt('/usr/sbin/ip') }))
      .toEqual({ available: true });
    expect(calls).toHaveLength(1);
    // It probes what the real sandbox does: bubblewrap, its own network, the
    // same capability flags, then `ip link set lo up` with the ip it found.
    const { argv, opts } = calls[0];
    expect(argv[0]).toBe('bwrap');
    expect(argv).toContain('--unshare-net');
    expect(argv.slice(-5)).toEqual(['/usr/sbin/ip', 'link', 'set', 'lo', 'up']);
    expect(opts.timeout).toBeGreaterThan(0);
  });

  test('the probe asks for the capability flags the real sandbox uses, in the same order', () => {
    const { spawn, calls } = recorder([ok]);
    detectBwrapLoopback({ spawn, platform: 'linux', exists: ipAt('/sbin/ip') });
    const probe = calls[0].argv.join(' ');
    expect(probe).toContain(LOOPBACK_ISOLATION_FLAGS.join(' '));
  });

  test('a host that starts the namespace but refuses the network is refused, with the reason', () => {
    const { spawn } = recorder([{ status: 1, stdout: '', stderr: 'RTNETLINK answers: Operation not permitted\n' }]);
    const res = detectBwrapLoopback({
      spawn, platform: 'linux', exists: ipAt('/usr/sbin/ip'), readRestriction: () => true, readRelease: () => '26.04',
    });
    expect(res).toMatchObject({
      available: false,
      loopbackRefused: true,
      reason: 'RTNETLINK answers: Operation not permitted',
      apparmorRestricted: true,
      ubuntuRelease: '26.04',
    });
    expect(res.error).toContain('RTNETLINK answers: Operation not permitted');
  });

  test('a probe that timed out or could not spawn says nothing about this host', () => {
    for (const result of [
      { status: null, error: Object.assign(new Error('spawnSync bwrap ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
      { status: null, error: Object.assign(new Error('spawnSync bwrap EACCES'), { code: 'EACCES' }) },
    ]) {
      const { spawn } = recorder([result]);
      const res = detectBwrapLoopback({ spawn, platform: 'linux', exists: ipAt('/usr/sbin/ip') });
      expect(res.available).toBe(false);
      expect(res.loopbackRefused).toBe(false);
    }
  });

  test('without the ip command it says to install iproute2, and runs no probe', () => {
    const { spawn, calls } = recorder([]);
    const res = detectBwrapLoopback({ spawn, platform: 'linux', exists: () => false });
    expect(res.available).toBe(false);
    expect(res.loopbackRefused).toBeUndefined();
    expect(res.error).toMatch(/iproute2/);
    expect(calls).toHaveLength(0);
  });

  test('a detector that throws reads as unavailable, not refused', () => {
    const spawn = () => { throw new Error('boom'); };
    const res = detectBwrapLoopback({ spawn, platform: 'linux', exists: ipAt('/usr/sbin/ip') });
    expect(res).toMatchObject({ available: false });
    expect(res.loopbackRefused).toBeUndefined();
  });
});

describe('the probe and the sandbox stay the same', () => {
  itLinux('wrapArgvWithBwrap with the loopback passes LOOPBACK_ISOLATION_FLAGS as one run', () => {
    const argv = wrapArgvWithBwrap(['true'], { sandbox: { network: { policy: 'restricted' } } }, {
      workspacePath: '/tmp',
      enableLoopback: true,
    });
    expect(argv.join(' ')).toContain(LOOPBACK_ISOLATION_FLAGS.join(' '));
  });

  test('the bridge that runs inside the sandbox looks for ip in the same places', () => {
    // The bridge can't import bwrap.js: only its own file is bound into the sandbox.
    const bridge = readFileSync(fileURLToPath(new URL('../src/lib/sandbox/opencode-loopback.mjs', import.meta.url)), 'utf8');
    const listed = bridge.match(/const ip = \[([^\]]+)\]/)?.[1];
    expect(listed).toBeDefined();
    expect(listed.split(',').map((s) => s.trim().replace(/^'|'$/g, ''))).toEqual(IP_CANDIDATES);
  });
});
