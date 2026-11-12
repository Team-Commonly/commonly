import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { cliName, cliSteps, npmName, npxName } from '../src/lib/cli-hint.js';
import { foregroundDaemonHint } from '../src/lib/daemon-hint.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('the command names a hint prints (F435)', () => {
  test('Windows gets the .cmd shims, which run under any PowerShell execution policy', () => {
    expect(cliName('win32')).toBe('commonly.cmd');
    expect(npxName('win32')).toBe('npx.cmd');
    expect(npmName('win32')).toBe('npm.cmd');
  });

  test.each(['darwin', 'linux'])('%s keeps the bare names', (platform) => {
    expect(cliName(platform)).toBe('commonly');
    expect(npxName(platform)).toBe('npx');
    expect(npmName(platform)).toBe('npm');
  });

  test('dependent steps join with && off Windows, and print one per line on it, where PowerShell 5.1 has no &&', () => {
    expect(cliSteps(['a register', 'a install'], { platform: 'darwin' })).toBe('a register && a install');
    const win = cliSteps(['a register', 'a install'], { platform: 'win32', indent: '    ' });
    expect(win).toBe('\n    a register\n    a install');
    expect(win).not.toContain('&&');
  });

  test('the foreground daemon hint on Windows names commonly.cmd, one step per line', () => {
    const hint = foregroundDaemonHint({ daemonRegistered: false, platform: 'win32' });
    expect(hint).toContain('\n    commonly.cmd daemon register\n    commonly.cmd daemon install\n');
    expect(hint).not.toContain('&&');
    expect(hint).toContain('Agents → Bring your own → On my computer');
  });
});

// Every top-level subcommand index.js registers (registerAgent → agent).
const subcommands = () => {
  const index = readFileSync(join(SRC, 'index.js'), 'utf8');
  const names = [...index.matchAll(/register(\w+)\(program\)/g)].map(([, name]) => name.toLowerCase());
  return names;
};

// Not hints a person types. The launcher script and the Task description are
// written for the Task Scheduler, which runs the CLI by its full path; the hook
// command is matched as written by hooks-config itself.
const NOT_HINTS = new Set([
  'lib/cli-hint.js',
  'lib/daemon-service-windows.js',
  'lib/hooks-config.js',
]);

const sourceFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return /\.(?:m?js)$/.test(name) ? [path] : [];
});

// Code only: whole-line comments and trailing `// ` comments are prose about
// the command, not text printed to a person.
const codeLines = (text) => text.split('\n').map((line, i) => ({
  n: i + 1,
  code: /^\s*(?:\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, ''),
}));

describe('no hint in cli/src names the bare CLI (F435)', () => {
  test('index.js still registers the subcommands this guard knows about', () => {
    expect(subcommands()).toEqual(expect.arrayContaining(['agent', 'daemon', 'login', 'pod', 'doctor', 'task']));
  });

  test('every `commonly <subcommand>` and `npx -y` / `npm install` in a string goes through cli-hint.js', () => {
    const bareCli = new RegExp(`\\bcommonly (?:${subcommands().join('|')})\\b`);
    const bareNpm = /(?:^|[^\w.$}-])(?:npx -y|npm (?:install|i) )/;
    const hits = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (NOT_HINTS.has(rel)) continue;
      for (const { n, code } of codeLines(readFileSync(file, 'utf8'))) {
        if (bareCli.test(code) || bareNpm.test(code)) hits.push(`${rel}:${n}: ${code.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
