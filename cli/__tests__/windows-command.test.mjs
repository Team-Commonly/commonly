// resolveWindowsCommand: launching npm-installed CLIs on Windows without a
// shell (#2141). Every case runs with an injected platform, env and
// filesystem, so the suite runs the same on macOS and Linux CI.

import {
  parseCmdShim, resolveLaunch, resolveWindowsCommand, resolveWindowsCommandWithReason,
} from '../src/lib/windows-command.js';
import {
  currentExeShim, currentJsShim, currentShShim, fakeFs, legacyJsShim, NPM_NPX_CMD,
} from './fixtures/windows-shims.cjs';

const NPM = 'C:\\Users\\ada\\AppData\\Roaming\\npm';
const LOCAL_BIN = 'C:\\Users\\ada\\.local\\bin';
const SYS = 'C:\\Windows\\System32';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CODEX_JS = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;

const win = (files, env = { Path: `${SYS};${NPM}` }) => ({
  platform: 'win32', env, execPath: NODE, ...fakeFs(files),
});

describe('resolveWindowsCommand — off Windows', () => {
  test.each(['darwin', 'linux'])('%s is a passthrough that touches nothing', (platform) => {
    const touch = () => { throw new Error('filesystem must not be read off Windows'); };
    expect(resolveWindowsCommand('codex', {
      platform, env: { PATH: '/usr/bin' }, existsSync: touch, readFileSync: touch,
    })).toEqual({ command: 'codex', args: [] });
    expect(resolveLaunch('claude', ['-p', 'hi'], { platform })).toEqual({
      command: 'claude', args: ['-p', 'hi'], source: undefined,
    });
  });
});

describe('resolveWindowsCommand — .exe and .com on PATH', () => {
  test('a native claude.exe resolves to itself with no argv prefix', () => {
    const exe = `${LOCAL_BIN}\\claude.exe`;
    const result = resolveWindowsCommandWithReason('claude', win(
      { [exe]: 'MZ' },
      { Path: `${SYS};${LOCAL_BIN}` },
    ));
    expect(result).toEqual({ command: exe, args: [], source: exe });
  });

  test('a .com hit is spawned directly too', () => {
    const com = `${SYS}\\tool.com`;
    expect(resolveWindowsCommand('tool', win({ [com]: 'MZ' }))).toEqual({ command: com, args: [] });
  });

  test('nothing on PATH is null, with a reason', () => {
    const result = resolveWindowsCommandWithReason('codex', win({}));
    expect(result.command).toBeNull();
    expect(result.reason).toMatch(/not found on PATH/);
    expect(resolveWindowsCommand('codex', win({}))).toBeNull();
  });
});

describe('resolveWindowsCommand — npm cmd-shims', () => {
  test('current cmd-shim JS form: node + the absolute script, PATH node when none beside the shim', () => {
    const shim = `${NPM}\\codex.cmd`;
    const result = resolveWindowsCommandWithReason('codex', win({
      [shim]: currentJsShim('node_modules\\@openai\\codex\\bin\\codex.js'),
      [CODEX_JS]: '#!/usr/bin/env node',
    }));
    expect(result).toEqual({ command: NODE, args: [CODEX_JS], source: shim });
  });

  test('current JS form prefers the node.exe beside the shim', () => {
    const shim = `${NPM}\\codex.cmd`;
    const besideNode = `${NPM}\\node.exe`;
    expect(resolveWindowsCommand('codex', win({
      [shim]: currentJsShim('node_modules\\@openai\\codex\\bin\\codex.js'),
      [CODEX_JS]: '',
      [besideNode]: 'MZ',
    }))).toEqual({ command: besideNode, args: [CODEX_JS] });
  });

  test('current JS form keeps the shebang flags, ahead of the script', () => {
    const shim = `${NPM}\\claude.cmd`;
    const script = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    expect(resolveWindowsCommand('claude', win({
      [shim]: currentJsShim('node_modules\\@anthropic-ai\\claude-code\\cli.js', '--no-warnings'),
      [script]: '',
    }))).toEqual({ command: NODE, args: ['--no-warnings', script] });
  });

  test('a relative target with .. segments resolves against the shim folder', () => {
    const shim = 'C:\\proj\\node_modules\\.bin\\codex.cmd';
    const script = 'C:\\proj\\node_modules\\@openai\\codex\\bin\\codex.js';
    expect(resolveWindowsCommand('codex', win(
      { [shim]: currentJsShim('..\\@openai\\codex\\bin\\codex.js'), [script]: '' },
      { Path: 'C:\\proj\\node_modules\\.bin' },
    ))).toEqual({ command: NODE, args: [script] });
  });

  test('current cmd-shim direct .exe form: the vendored exe, no prefix', () => {
    const shim = `${NPM}\\codex.cmd`;
    const exe = `${NPM}\\node_modules\\@openai\\codex\\vendor\\codex.exe`;
    expect(resolveWindowsCommand('codex', win({
      [shim]: currentExeShim('node_modules\\@openai\\codex\\vendor\\codex.exe'),
      [exe]: 'MZ',
    }))).toEqual({ command: exe, args: [] });
  });

  test('legacy cmd-shim (@IF EXIST "%~dp0\\node.exe") form', () => {
    const shim = `${NPM}\\codex.cmd`;
    expect(resolveWindowsCommand('codex', win({
      [shim]: legacyJsShim('node_modules\\@openai\\codex\\bin\\codex.js'),
      [CODEX_JS]: '',
    }))).toEqual({ command: NODE, args: [CODEX_JS] });
  });

  test('a .bat shim parses the same way as a .cmd', () => {
    const shim = `${NPM}\\codex.bat`;
    expect(resolveWindowsCommand('codex', win({
      [shim]: currentJsShim('node_modules\\@openai\\codex\\bin\\codex.js'),
      [CODEX_JS]: '',
    }))).toEqual({ command: NODE, args: [CODEX_JS] });
  });
});

describe('resolveWindowsCommand — refusals, never a shell', () => {
  const refused = (text, extra = {}) => resolveWindowsCommandWithReason('codex', win({
    [`${NPM}\\codex.cmd`]: text, [CODEX_JS]: '', ...extra,
  }));

  test('a hand-written .cmd that is not a shim is null with a reason', () => {
    const result = refused('@echo off\r\npowershell -File "%~dp0\\codex.ps1"\r\n');
    expect(result.command).toBeNull();
    expect(result.reason).toMatch(/not an npm cmd-shim/);
    expect(resolveWindowsCommand('codex', win({ [`${NPM}\\codex.cmd`]: '@echo off\r\n' }))).toBeNull();
  });

  test('a shim whose program is /bin/sh, not node, is refused', () => {
    const script = `${NPM}\\node_modules\\x\\run.sh`;
    const result = resolveWindowsCommandWithReason('codex', win({
      [`${NPM}\\codex.cmd`]: currentShShim('node_modules\\x\\run.sh'), [script]: '',
    }));
    expect(result.command).toBeNull();
    expect(result.reason).toMatch(/neither a script nor an \.exe|other than node/);
  });

  test('a shim whose target is missing is refused', () => {
    const result = resolveWindowsCommandWithReason('codex', win({
      [`${NPM}\\codex.cmd`]: currentJsShim('node_modules\\@openai\\codex\\bin\\codex.js'),
    }));
    expect(result.command).toBeNull();
    expect(result.reason).toMatch(/does not exist/);
  });

  test('a launch line with redirection or chaining after the target is refused', () => {
    const result = refused('@echo off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" >log.txt %*\r\n');
    expect(result.command).toBeNull();
  });

  test('a target outside %dp0% (an arbitrary absolute path) is refused', () => {
    const result = refused('@echo off\r\nnode "C:\\evil\\codex.js" %*\r\n', { 'C:\\evil\\codex.js': '' });
    expect(result.command).toBeNull();
    expect(result.reason).toMatch(/does not name a target beside itself/);
  });

  test('an unreadable shim is null with the read error', () => {
    const result = resolveWindowsCommandWithReason('codex', {
      ...win({ [`${NPM}\\codex.cmd`]: '' }),
      readFileSync: () => { throw new Error('EACCES'); },
    });
    expect(result.command).toBeNull();
    expect(result.reason).toMatch(/could not be read: EACCES/);
  });

  test('resolveLaunch throws ENOENT with the reason instead of falling back', () => {
    expect(() => resolveLaunch('codex', ['exec'], win({}))).toThrow(
      expect.objectContaining({ code: 'ENOENT', message: expect.stringMatching(/without a shell: codex was not found/) }),
    );
  });
});

describe('resolveWindowsCommand — PATH and PATHEXT order', () => {
  const exe = `${NPM}\\codex.exe`;
  const shim = `${NPM}\\codex.cmd`;
  const files = {
    [exe]: 'MZ', [shim]: currentJsShim('node_modules\\@openai\\codex\\bin\\codex.js'), [CODEX_JS]: '',
  };

  test('within one folder, the first PATHEXT extension that exists wins', () => {
    expect(resolveWindowsCommand('codex', win(files, { Path: NPM, PATHEXT: '.COM;.EXE;.BAT;.CMD' })))
      .toEqual({ command: exe, args: [] });
    expect(resolveWindowsCommand('codex', win(files, { Path: NPM, PATHEXT: '.CMD;.EXE' })))
      .toEqual({ command: NODE, args: [CODEX_JS] });
  });

  test('an earlier PATH folder beats a better extension in a later one', () => {
    const later = 'C:\\later\\codex.exe';
    expect(resolveWindowsCommand('codex', win(
      { [shim]: files[shim], [CODEX_JS]: '', [later]: 'MZ' },
      { Path: `${NPM};C:\\later` },
    ))).toEqual({ command: NODE, args: [CODEX_JS] });
  });

  test('PATHEXT defaults to .COM;.EXE;.BAT;.CMD and unknown extensions are skipped', () => {
    expect(resolveWindowsCommand('codex', win(files, { Path: NPM }))).toEqual({ command: exe, args: [] });
    expect(resolveWindowsCommand('codex', win(
      { [`${NPM}\\codex.ps1`]: '', [shim]: files[shim], [CODEX_JS]: '' },
      { Path: NPM, PATHEXT: '.PS1;.CMD' },
    ))).toEqual({ command: NODE, args: [CODEX_JS] });
  });

  test('extensions are matched case-insensitively', () => {
    const upper = `${NPM}\\CODEX.CMD`;
    expect(resolveWindowsCommand('codex', win(
      { [upper]: currentJsShim('node_modules\\@openai\\codex\\bin\\codex.js'), [CODEX_JS]: '' },
      { Path: NPM, PATHEXT: '.Exe;.Cmd' },
    ))).toEqual({ command: NODE, args: [CODEX_JS] });
    expect(resolveWindowsCommand(`${NPM}\\codex.EXE`, win({ [exe]: 'MZ' })))
      .toEqual({ command: `${NPM}\\codex.EXE`, args: [] });
  });

  test('reads Path and PATH, Path first, so an added ~/.local/bin is still searched', () => {
    const native = `${LOCAL_BIN}\\claude.exe`;
    expect(resolveWindowsCommand('claude', win(
      { [native]: 'MZ' },
      { Path: SYS, PATH: `${SYS};${LOCAL_BIN}` },
    ))).toEqual({ command: native, args: [] });
  });

  test('quoted PATH entries are unquoted', () => {
    expect(resolveWindowsCommand('codex', win(files, { Path: `"${NPM}"` }))).toEqual({ command: exe, args: [] });
  });
});

describe('parseCmdShim', () => {
  test('resolves %~dp0 without a separator', () => {
    const shimPath = `${NPM}\\codex.cmd`;
    const fs = fakeFs({ [CODEX_JS]: '' });
    expect(parseCmdShim(
      'node "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      shimPath,
      { ...fs, execPath: NODE },
    )).toEqual({ command: NODE, args: [CODEX_JS] });
  });
});

describe("npm's own npx.cmd (not a cmd-shim)", () => {
  const NODEJS = 'C:\\Program Files\\nodejs';
  const bundled = `${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`;
  const appData = 'C:\\Users\\ada\\AppData\\Roaming';
  const upgraded = `${appData}\\npm\\node_modules\\npm\\bin\\npx-cli.js`;
  const files = { [`${NODEJS}\\npx.cmd`]: NPM_NPX_CMD, [`${NODEJS}\\node.exe`]: 'MZ', [bundled]: '' };

  test('resolves to the node.exe beside it and the bundled npx-cli.js', () => {
    expect(resolveWindowsCommand('npx', win(files, { Path: NODEJS, APPDATA: appData })))
      .toEqual({ command: `${NODEJS}\\node.exe`, args: [bundled] });
  });

  test('an npm upgraded into %APPDATA%\\npm wins, as npm-prefix.js would decide', () => {
    expect(resolveWindowsCommand('npx', win({ ...files, [upgraded]: '' }, { Path: NODEJS, APPDATA: appData })))
      .toEqual({ command: `${NODEJS}\\node.exe`, args: [upgraded] });
  });

  test('missing npx-cli.js is refused with a reason', () => {
    const result = resolveWindowsCommandWithReason('npx', win(
      { [`${NODEJS}\\npx.cmd`]: NPM_NPX_CMD },
      { Path: NODEJS },
    ));
    expect(result.command).toBeNull();
    expect(result.reason).toMatch(/does not exist/);
  });
});
