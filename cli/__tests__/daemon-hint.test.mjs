import { createFirstAnswerNotice, foregroundDaemonHint, keepRunningStep } from '../src/lib/daemon-hint.js';

// The foreground hint must tell the truth for both states: with no daemon, the
// full add-this-computer path; with one, only the placement step. Neither may
// promise a reboot, and the run path itself is not in this test.
test('with no daemon registered, the hint names register, install, then the web placement', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: false });
  expect(hint).toContain('commonly daemon register && commonly daemon install');
  expect(hint).toContain('Agents → Bring your own → On my computer');
  expect(hint).not.toMatch(/reboot|restart|log ?in/i);
});

// F570: run through npx (the Bring your own page's line), `daemon install`
// would pin the service to npx's evictable cache, so the hint names the setup
// line, which installs a stable copy first, and never `daemon install`.
const NPX_ENTRY = '/Users/a/.npm/_npx/0123abcd/node_modules/@commonlyai/cli/src/index.js';
const NPX_ENTRY_WIN = 'C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\0123abcd\\node_modules\\@commonlyai\\cli\\src\\index.js';

test('run from npx with no daemon, the hint names daemon setup for this instance, never daemon install', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: false, platform: 'darwin', entry: NPX_ENTRY, instanceUrl: 'https://api.commonly.me' });
  expect(hint).toContain('add this computer once with: npx -y @commonlyai/cli@latest daemon setup --instance https://api.commonly.me\n');
  expect(hint).toContain('Agents → Bring your own → On my computer');
  expect(hint).not.toMatch(/daemon (install|register)|--unsandboxed/);
});

test('run from npx on Windows, the setup line uses npx.cmd and carries --unsandboxed', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: false, platform: 'win32', entry: NPX_ENTRY_WIN, instanceUrl: 'https://api.commonly.me' });
  expect(hint).toContain('npx.cmd -y @commonlyai/cli@latest daemon setup --instance https://api.commonly.me --unsandboxed');
  expect(hint).not.toMatch(/daemon (install|register)/);
});

test('run from npx with a daemon registered, the hint is still only the placement step', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: true, entry: NPX_ENTRY });
  expect(hint).toContain('add the agent to this computer in the web app');
  expect(hint).not.toMatch(/daemon (setup|install)/);
});

test('with a daemon registered, the hint names only the placement step', () => {
  const hint = foregroundDaemonHint({ daemonRegistered: true });
  expect(hint).toContain('add the agent to this computer in the web app');
  expect(hint).toContain('Agents → Bring your own → On my computer');
  expect(hint).not.toContain('commonly daemon');
  expect(hint).not.toMatch(/reboot|restart|log ?in/i);
});

// F642: a foreground run says how to keep the agent running once, right after
// its first answer, when the person has just seen it work. Never twice, never
// under the daemon (which already keeps it running), and it reuses the same
// keep-it-running step the start-time hint names.
describe('createFirstAnswerNotice', () => {
  const notice = (overrides = {}) => {
    const lines = [];
    const onAnswered = createFirstAnswerNotice({
      managed: false,
      hintArgs: () => ({
        daemonRegistered: false, platform: 'darwin', entry: NPX_ENTRY, instanceUrl: 'https://api.commonly.me',
      }),
      log: (line) => lines.push(line),
      ...overrides,
    });
    return { lines, onAnswered };
  };

  test('after the first answer it says the agent answered, that the run stops with the terminal, and the setup step', () => {
    const { lines, onAnswered } = notice();
    onAnswered();
    const text = lines.join('\n');
    expect(text).toMatch(/your agent just answered/i);
    expect(text).toContain('stops when the terminal closes');
    expect(text).toContain('npx -y @commonlyai/cli@latest daemon setup --instance https://api.commonly.me');
    expect(text).toContain('Agents → Bring your own → On my computer');
  });

  test('a second answer prints nothing more', () => {
    const { lines, onAnswered } = notice();
    onAnswered();
    const after = lines.length;
    onAnswered();
    onAnswered();
    expect(after).toBeGreaterThan(0);
    expect(lines).toHaveLength(after);
  });

  test('a run the daemon supervises never prints it', () => {
    const { lines, onAnswered } = notice({ managed: true });
    onAnswered();
    expect(lines).toEqual([]);
  });

  test('on Windows from npx, the setup line carries --unsandboxed', () => {
    const { lines, onAnswered } = notice({
      hintArgs: () => ({
        daemonRegistered: false, platform: 'win32', entry: NPX_ENTRY_WIN, instanceUrl: 'https://api.commonly.me',
      }),
    });
    onAnswered();
    expect(lines.join('\n')).toContain('npx.cmd -y @commonlyai/cli@latest daemon setup --instance https://api.commonly.me --unsandboxed');
  });

  test('on Windows from a global install, each daemon step is on its own line, never joined with &&', () => {
    const { lines, onAnswered } = notice({
      hintArgs: () => ({
        daemonRegistered: false, platform: 'win32', entry: 'C:\\npm\\node_modules\\@commonlyai\\cli\\src\\index.js',
      }),
    });
    onAnswered();
    const text = lines.join('\n');
    expect(text).not.toContain('&&');
    expect(text).toMatch(/\n\s*commonly\.cmd daemon register\n\s*commonly\.cmd daemon install/);
  });

  test('the block reuses the start-time hint step, not a copy of its logic', () => {
    const args = { daemonRegistered: true, platform: 'darwin' };
    const { lines, onAnswered } = notice({ hintArgs: () => args });
    onAnswered();
    expect(lines.join('\n')).toContain(keepRunningStep(args));
    expect(foregroundDaemonHint(args)).toContain(keepRunningStep(args));
  });
});
