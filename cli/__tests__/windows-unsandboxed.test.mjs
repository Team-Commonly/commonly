// D245: the user's own opt-in to run without a sandbox on native Windows.
// The rule the tests pin: only a local action decides it, the stored record is
// never changed, and an unconfined seat never carries the grant broker.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import {
  UNSANDBOXED_FLAG,
  clearUnsandboxedOptIn,
  loadUnsandboxedOptIn,
  runOptedInUnsandboxed,
  saveUnsandboxedOptIn,
  unsandboxedFlagRefusal,
  unsandboxedMarkerPath,
  unsandboxedRunEnvironment,
} from '../src/lib/sandbox/windows-unsandboxed.js';
import { hostSandboxRefusal, windowsSandboxMessage } from '../src/lib/sandbox/host-check.js';
import { detectBwrap } from '../src/lib/sandbox/bwrap.js';
import { defaultSeatSandbox } from '../src/lib/default-environment.js';
import { withholdGrantBroker } from '../src/lib/grant-broker-guard.js';

const INSTANCE = 'https://api.commonly.me';
const broker = {
  name: 'commonly-grant-broker',
  transport: 'http',
  url: '${COMMONLY_API_URL}/api/mcp/grants/grant_4df79b67-0f7f-481f-8cd6-9cd90b946bb7',
  headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
};
const kernel = { name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] };
const connectPage = () => ({ mcp: [kernel, broker], sandbox: defaultSeatSandbox() });

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'win-unsandboxed-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('the flag', () => {
  test('is refused everywhere but native Windows', () => {
    expect(unsandboxedFlagRefusal('win32')).toBeNull();
    for (const platform of ['darwin', 'linux']) {
      expect(unsandboxedFlagRefusal(platform)).toContain(`${UNSANDBOXED_FLAG} is only for native Windows`);
    }
  });
});

describe('the per-machine marker', () => {
  test('round-trips on win32, and install-without-the-flag (clear) turns it off', () => {
    mkdirSync(dirname(unsandboxedMarkerPath(home)), { recursive: true });
    expect(loadUnsandboxedOptIn({ platform: 'win32', home })).toBe(false);
    saveUnsandboxedOptIn({ home, now: () => new Date('2026-11-04T00:00:00Z') });
    expect(JSON.parse(readFileSync(unsandboxedMarkerPath(home), 'utf8')))
      .toEqual({ unsandboxed: true, platform: 'win32', optedInAt: '2026-11-04T00:00:00.000Z' });
    expect(loadUnsandboxedOptIn({ platform: 'win32', home })).toBe(true);
    expect(clearUnsandboxedOptIn({ home })).toBe(true);
    expect(existsSync(unsandboxedMarkerPath(home))).toBe(false);
    expect(loadUnsandboxedOptIn({ platform: 'win32', home })).toBe(false);
    expect(clearUnsandboxedOptIn({ home })).toBe(false);
  });

  test('means nothing off Windows, even when the file is there', () => {
    mkdirSync(dirname(unsandboxedMarkerPath(home)), { recursive: true });
    saveUnsandboxedOptIn({ home });
    expect(loadUnsandboxedOptIn({ platform: 'linux', home })).toBe(false);
    expect(loadUnsandboxedOptIn({ platform: 'darwin', home })).toBe(false);
  });

  test('a malformed or look-alike file is not an opt-in', () => {
    const file = unsandboxedMarkerPath(home);
    mkdirSync(dirname(file), { recursive: true });
    for (const text of ['', 'yes', '{"unsandboxed":"true","platform":"win32"}', '{"unsandboxed":true}', '{"unsandboxed":true,"platform":"linux"}']) {
      writeFileSync(file, text);
      expect(loadUnsandboxedOptIn({ platform: 'win32', home })).toBe(false);
    }
  });
});

describe('who decides for a run', () => {
  test('the typed flag, or the marker only for a seat the daemon spawned', () => {
    const yes = () => true;
    expect(runOptedInUnsandboxed({ flag: true, env: {}, load: () => false })).toBe(true);
    expect(runOptedInUnsandboxed({ flag: false, env: { COMMONLY_MANAGED_RUNNER: '1' }, load: yes })).toBe(true);
    // A hand-started run ignores the daemon's marker.
    expect(runOptedInUnsandboxed({ flag: false, env: {}, load: yes })).toBe(false);
    expect(runOptedInUnsandboxed({ flag: undefined, env: { COMMONLY_MANAGED_RUNNER: 'true' }, load: yes })).toBe(false);
    expect(runOptedInUnsandboxed({ flag: false, env: { COMMONLY_MANAGED_RUNNER: '1' }, load: () => false })).toBe(false);
  });
});

describe('the environment one run hands its adapter', () => {
  test('opted in on win32: a Claude seat the host would refuse runs with no sandbox, and the record is not touched', () => {
    const stored = connectPage();
    const before = JSON.stringify(stored);
    const run = unsandboxedRunEnvironment(stored, { adapterName: 'claude', optedIn: true, platform: 'win32' });
    expect(run.sandbox).toEqual({ mode: 'none' });
    expect(run.mcp).toEqual(stored.mcp);
    expect(JSON.stringify(stored)).toBe(before);
    expect(hostSandboxRefusal({ environment: run, adapterName: 'claude', platform: 'win32' })).toBeNull();
  });

  test('an unconfined run never carries the grant broker', () => {
    const run = unsandboxedRunEnvironment(connectPage(), { adapterName: 'claude', optedIn: true, platform: 'win32' });
    const refusals = [];
    const out = withholdGrantBroker(run, 'claude', { instanceUrl: INSTANCE, platform: 'win32', onRefuse: (r) => refusals.push(r.reason) });
    expect(out.mcp).toEqual([kernel]);
    expect(refusals).toEqual(['sandbox_mode_none']);
  });

  test('nothing the server sends can stand in for the user: without the local opt-in the environment is returned as is', () => {
    const forged = [
      { ...connectPage(), unsandboxed: true },
      { ...connectPage(), sandbox: { ...defaultSeatSandbox(), unsandboxed: true, optedIn: true } },
      { ...connectPage(), sandbox: { trust: 'public', mode: 'none' } },
    ];
    for (const environment of forged) {
      for (const optedIn of [false, undefined, 'true', 1, { unsandboxed: true }]) {
        expect(unsandboxedRunEnvironment(environment, { adapterName: 'claude', optedIn, platform: 'win32' })).toBe(environment);
      }
    }
    // And the forged shapes are still refused on Windows, as before.
    expect(hostSandboxRefusal({ environment: forged[0], adapterName: 'claude', platform: 'win32' })).toContain(UNSANDBOXED_FLAG);
  });

  test('off Windows, and for seats the host does confine (Codex), nothing changes', () => {
    const env = connectPage();
    for (const platform of ['darwin', 'linux']) {
      expect(unsandboxedRunEnvironment(env, { adapterName: 'claude', optedIn: true, platform })).toBe(env);
    }
    expect(unsandboxedRunEnvironment(env, { adapterName: 'codex', optedIn: true, platform: 'win32' })).toBe(env);
    const none = { mcp: [kernel] };
    expect(unsandboxedRunEnvironment(none, { adapterName: 'claude', optedIn: true, platform: 'win32' })).toBe(none);
  });
});

describe('what a Windows user is told', () => {
  test('the refusal names Windows and the flag, and still offers no WSL route', () => {
    const message = windowsSandboxMessage('claude');
    expect(message).toContain('no sandbox for Windows yet');
    expect(message).toContain(`commonly agent run <name> ${UNSANDBOXED_FLAG}`);
    expect(message).toContain(`commonly daemon install ${UNSANDBOXED_FLAG}`);
    expect(message).toContain('no connector grants');
    expect(message).not.toContain('WSL');
  });

  test('the bwrap probe on Windows says Windows and the flag, not macOS', () => {
    const { error } = detectBwrap({ platform: 'win32' });
    expect(error).toContain('native Windows has no sandbox');
    expect(error).toContain(UNSANDBOXED_FLAG);
    expect(error).not.toMatch(/macOS|WSL/);
    expect(detectBwrap({ platform: 'darwin' }).error).not.toContain(UNSANDBOXED_FLAG);
  });
});
