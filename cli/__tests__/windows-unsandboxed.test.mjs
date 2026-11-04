// D245: the user's own opt-in to run without a sandbox on native Windows.
// The rule the tests pin: only a local action decides it, the environment never
// carries it, and no seat on native Windows carries the grant broker.
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
  hostUnconfinedForRun,
  hostSandboxReport,
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

describe('what the check-in reports', () => {
  test('native Windows never reports default, opted in or not', () => {
    expect(hostSandboxReport({ platform: 'win32', load: () => true })).toBe('unsandboxed-opted-in');
    expect(hostSandboxReport({ platform: 'win32', load: () => false })).toBe('native-windows');
    for (const platform of ['darwin', 'linux']) expect(hostSandboxReport({ platform, load: () => true })).toBe('default');
  });
});

describe('which runs skip the OS jail', () => {
  test('only win32, only the user\'s own opt-in, only Claude', () => {
    const environment = connectPage();
    expect(hostUnconfinedForRun({ optedIn: true, adapterName: 'claude', environment, platform: 'win32' })).toBe(true);
    expect(hostUnconfinedForRun({
      optedIn: true, adapterName: 'claude', environment: { sandbox: { trust: 'workspace' } }, platform: 'win32',
    })).toBe(true);
    for (const optedIn of [false, undefined, 'true', 1, { unsandboxed: true }]) {
      expect(hostUnconfinedForRun({ optedIn, adapterName: 'claude', environment, platform: 'win32' })).toBe(false);
    }
    for (const platform of ['darwin', 'linux']) {
      expect(hostUnconfinedForRun({ optedIn: true, adapterName: 'claude', environment, platform })).toBe(false);
    }
    // OpenCode and Qwen stay refused; Codex is never refused on Windows.
    for (const adapterName of ['codex', 'opencode', 'qwen', 'pi']) {
      expect(hostUnconfinedForRun({ optedIn: true, adapterName, environment, platform: 'win32' })).toBe(false);
    }
  });

  test('a legacy `internal` seat reads as public, so an opted-in one gets the policy-only spawn, not a refusal', () => {
    const environment = { sandbox: { trust: 'internal', mode: 'workspace' } };
    expect(hostUnconfinedForRun({ optedIn: true, adapterName: 'claude', environment, platform: 'win32' })).toBe(true);
    // host-check reads it the same way: confined, so refused without the flag and admitted with it.
    expect(hostSandboxRefusal({ environment, adapterName: 'claude', platform: 'win32' })).toContain(UNSANDBOXED_FLAG);
    expect(hostSandboxRefusal({ environment, adapterName: 'claude', platform: 'win32', hostUnconfined: true })).toBeNull();
    expect(hostUnconfinedForRun({ optedIn: false, adapterName: 'claude', environment, platform: 'win32' })).toBe(false);
  });

  test('a seat with no confined trust is not affected, so it is not told it gets the policy', () => {
    for (const environment of [null, undefined, {}, { sandbox: { mode: 'none' } }, { sandbox: { trust: 'trusted' } }]) {
      expect(hostUnconfinedForRun({ optedIn: true, adapterName: 'claude', environment, platform: 'win32' })).toBe(false);
    }
  });

  test('host-check admits an opted-in Claude seat on Windows and keeps its trust', () => {
    const stored = connectPage();
    expect(hostSandboxRefusal({ environment: stored, adapterName: 'claude', platform: 'win32', hostUnconfined: true })).toBeNull();
    // The environment is not what admits it: the same record without the local flag is refused.
    expect(hostSandboxRefusal({ environment: stored, adapterName: 'claude', platform: 'win32' })).toContain(UNSANDBOXED_FLAG);
    expect(stored.sandbox.trust).toBe('public');
  });

  test('nothing the server sends can stand in for the user', () => {
    const forged = [
      { ...connectPage(), unsandboxed: true, hostUnconfined: true },
      { ...connectPage(), sandbox: { ...defaultSeatSandbox(), unsandboxed: true, hostUnconfined: true } },
    ];
    for (const environment of forged) {
      expect(hostSandboxRefusal({ environment, adapterName: 'claude', platform: 'win32' })).toContain(UNSANDBOXED_FLAG);
      for (const hostUnconfined of ['true', 1, {}]) {
        expect(hostSandboxRefusal({ environment, adapterName: 'claude', platform: 'win32', hostUnconfined })).not.toBeNull();
      }
    }
  });

  test('OpenCode is still refused on Windows with the flag, and its message offers no flag', () => {
    const refusal = hostSandboxRefusal({ environment: connectPage(), adapterName: 'opencode', platform: 'win32', hostUnconfined: true });
    expect(refusal).not.toBeNull();
    expect(refusal).not.toContain(UNSANDBOXED_FLAG);
  });
});

describe('no seat on native Windows carries the grant broker', () => {
  for (const adapter of ['claude', 'codex']) {
    test(`${adapter}: withheld, with a reason that names Windows`, () => {
      const refusals = [];
      const out = withholdGrantBroker(connectPage(), adapter, {
        instanceUrl: INSTANCE, platform: 'win32', onRefuse: (r) => refusals.push(r),
      });
      expect(out.mcp).toEqual([kernel]);
      expect(refusals.map((r) => r.reason)).toEqual(['sandbox_mode_unenforceable']);
      expect(refusals[0].detail).toContain('native Windows');
      expect(refusals[0].detail).not.toMatch(/macOS only|bwrap on Linux/);
    });
  }

  test('off Windows the same seat keeps it', () => {
    for (const platform of ['darwin', 'linux']) {
      const out = withholdGrantBroker(connectPage(), 'claude', { instanceUrl: INSTANCE, platform });
      expect(out.mcp).toEqual([kernel, broker]);
    }
  });
});

describe('what a Windows user is told', () => {
  test('the refusal names Windows and the flag, and offers WSL, which runs Claude Code in the Linux sandbox since F96', () => {
    const message = windowsSandboxMessage('claude');
    expect(message).toContain('no sandbox for Windows yet');
    expect(message).toContain(`commonly agent run <name> ${UNSANDBOXED_FLAG}`);
    expect(message).toContain(`commonly daemon install ${UNSANDBOXED_FLAG}`);
    expect(message).toContain('no connector grants');
    expect(message).toContain("Commonly's restricted tool settings");
    expect(message).toContain('WSL 2 (Ubuntu): install Node and Claude Code inside WSL');
    // The flag is offered only where it does something.
    expect(windowsSandboxMessage('opencode')).not.toContain(UNSANDBOXED_FLAG);
  });

  test('the bwrap probe on Windows says Windows and the flag, not macOS', () => {
    const { error } = detectBwrap({ platform: 'win32' });
    expect(error).toContain('native Windows has no sandbox');
    expect(error).toContain(UNSANDBOXED_FLAG);
    expect(error).not.toMatch(/macOS|WSL/);
    expect(detectBwrap({ platform: 'darwin' }).error).not.toContain(UNSANDBOXED_FLAG);
  });
});
