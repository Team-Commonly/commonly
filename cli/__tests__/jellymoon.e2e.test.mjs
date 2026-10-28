/**
 * `jellymoon run` end to end: the command runs as its own process, drives the
 * test-support fake CLI (a real child) against the fake provider, and is read
 * back only through what a script sees — the exit code, stdout, the last
 * stderr line, and the trace file. No real agent CLI runs here: the four real
 * agents are exercised only with an empty PATH and a fresh HOME, where none
 * can be found.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider } from '../../packages/seats/test-support/fake-provider.js';
import { FAILURE_KINDS } from '../../packages/seats/src/failures.js';
import { verifyRecord } from '../../packages/seats/src/record/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'jellymoon-fake-cli.cjs');
const BIN = join(here, '..', 'src', 'jellymoon.js');
const COMMONLY_BIN = join(here, '..', 'src', 'index.js');

let provider;
let root;
let work;
let traces;
let home;

beforeAll(async () => { provider = await startFakeProvider(); });
afterAll(async () => { await provider?.close(); });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jellymoon-e2e-')));
  work = join(root, 'work');
  traces = join(root, 'traces');
  home = join(root, 'home');
  mkdirSync(work);
  mkdirSync(home);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Every run gets an empty PATH directory (never an unset PATH) and a fresh
// HOME, so no real agent CLI can be found, let alone run. The fake CLI is
// started by absolute path through process.execPath and needs neither.
const run = (script, args, { env = {}, timeoutMs = 30000 } = {}) => new Promise((resolve, reject) => {
  const emptyBin = join(root, 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });
  const child = spawn(process.execPath, [script, ...args], {
    cwd: work,
    env: {
      ...process.env, PATH: emptyBin, HOME: home, JM_FAKE_PROVIDER_URL: provider.baseURL, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${stderr}`)); }, timeoutMs);
  child.on('error', reject);
  child.on('close', (code) => {
    clearTimeout(timer);
    const lines = stderr.trimEnd().split('\n');
    resolve({ code, stdout, stderr, last: lines[lines.length - 1] });
  });
});

const fake = (task, ...flags) => run(FIXTURE, ['run', 'fake-cli', task, '--trace-dir', traces, ...flags]);
const lineFor = (kind) => `jellymoon: ${kind}: ${FAILURE_KINDS[kind].meaning}`;
const tracePathFrom = (stderr) => /^jellymoon: trace: (.+)$/m.exec(stderr)?.[1];

describe('jellymoon run (fake CLI, fake provider)', () => {
  test('ok: exit 0, the reply on stdout, nothing on stderr, a verifiable trace', async () => {
    const result = await fake('[[reply:hello from fake]]');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello from fake\n');
    const runs = join(traces, 'runs');
    expect(existsSync(runs)).toBe(true);
  });

  test('ok --json: the settle as one JSON object, pointing at its trace', async () => {
    const result = await fake('[[reply:PONG]]', '--json');
    expect(result.code).toBe(0);
    const settle = JSON.parse(result.stdout);
    expect(settle).toMatchObject({
      outcome: 'ok', agent: 'fake-cli', kind: null, exitCode: 0, text: 'PONG', attempts: 1,
    });
    expect(typeof settle.runId).toBe('string');
    expect(settle.trace).toBe(join(traces, 'runs', `${settle.runId}.jsonl`));
    const verified = verifyRecord(readFileSync(settle.trace, 'utf8'));
    expect(verified.errors).toEqual([]);
    expect(verified.ok).toBe(true);
  });

  test('stuck: no progress inside --stall settles stuck, exit 10', async () => {
    const result = await fake('[[stall]]', '--stall', '0.5', '--timeout', '20');
    expect(result.code).toBe(10);
    expect(result.stdout).toBe('');
    expect(result.last).toBe(lineFor('stuck'));
    expect(existsSync(tracePathFrom(result.stderr))).toBe(true);
  });

  test('stuck --json: the settle names the kind and the code', async () => {
    const result = await fake('[[stall]]', '--stall', '0.5', '--json');
    expect(result.code).toBe(10);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'stuck', kind: 'stuck', exitCode: 10, failure: { kind: 'stuck' } });
    expect(result.last).toBe(lineFor('stuck'));
  });

  test('refusal: a content-policy answer settles refusal, exit 14, key not echoed', async () => {
    const result = await fake('[[refuse]]');
    expect(result.code).toBe(14);
    expect(result.stdout).toBe('');
    expect(result.last).toBe(lineFor('refusal'));
    expect(result.stderr).toMatch(/^jellymoon: detail: .*content policy/m);
    expect(result.stderr).not.toContain('fake-key-0123456789');
  });

  test('missing binary: the CLI is not there, exit 22, with the named last line', async () => {
    const result = await run(FIXTURE, ['run', 'fake-cli', 'hi', '--trace-dir', traces],
      { env: { JM_FAKE_CLI_BIN: join(root, 'no-such-cli.mjs') } });
    expect(result.code).toBe(22);
    expect(result.stdout).toBe('');
    expect(result.last).toBe(lineFor('not_installed'));
  });
});

describe('the shipped bin, with no agent CLI reachable', () => {
  // run() gives every child an empty PATH and a fresh HOME (claude also looks
  // in ~/.local/bin), so none of the four can be found or run.
  const bare = (agent, ...flags) => run(BIN, ['run', agent, 'hello', '--trace-dir', traces, ...flags]);

  test.each(['claude', 'codex', 'opencode', 'goose'])('%s not on PATH: exit 22 and an install hint', async (agent) => {
    const result = await bare(agent);
    expect(result.code).toBe(22);
    expect(result.last).toBe(lineFor('not_installed'));
    expect(result.stderr).toMatch(new RegExp(`^jellymoon: hint: install ${agent}: `, 'm'));
  });

  test('`commonly jellymoon run` reaches the same command', async () => {
    const result = await run(COMMONLY_BIN, ['jellymoon', 'run', 'codex', 'hello', '--trace-dir', traces]);
    expect(result.code).toBe(22);
    expect(result.last).toBe(lineFor('not_installed'));
  });

  test('--help lists every exit code', async () => {
    const result = await run(BIN, ['run', '--help']);
    expect(result.code).toBe(0);
    for (const kind of Object.keys(FAILURE_KINDS)) expect(result.stdout).toMatch(new RegExp(`\\d+  ${kind}$`, 'm'));
  });
});

describe('usage errors exit 2 and start no run', () => {
  test('an unknown agent', async () => {
    const result = await run(BIN, ['run', 'nope', 'hi', '--trace-dir', traces]);
    expect(result.code).toBe(2);
    expect(result.last).toMatch(/^jellymoon: usage: unknown agent "nope"/);
    expect(existsSync(traces)).toBe(false);
  });

  test('a missing argument', async () => {
    const result = await run(BIN, ['run', 'claude']);
    expect(result.code).toBe(2);
  });

  test('a trace dir inside the repository the agent works in', async () => {
    mkdirSync(join(work, '.git'));
    const result = await fake('[[reply:x]]', '--trace-dir', join(work, '.traces'));
    expect(result.code).toBe(2);
    expect(result.last).toMatch(/^jellymoon: usage: the trace directory .* is inside the repository/);
  });

  test('a bad --timeout', async () => {
    const result = await fake('[[reply:x]]', '--timeout', '0');
    expect(result.code).toBe(2);
    expect(result.last).toMatch(/--timeout must be a positive number of seconds/);
  });

  test('claude refuses --provider-url', async () => {
    const result = await run(BIN, ['run', 'claude', 'hi', '--trace-dir', traces,
      '--model', 'some-model', '--provider-url', 'http://127.0.0.1:1/v1', '--provider-key-file', join(root, 'key')]);
    expect(result.code).toBe(2);
    expect(result.last).toMatch(/claude cannot run on --provider-url/);
  });
});

// A provider key must not reach a terminal, a trace,
// a log or a failure line. These drive the REAL claude, codex and opencode
// adapters through the shipped bin, against a fake CLI on PATH (a /bin/sh
// script) that echoes the key back the way a real CLI's auth error would.
describe('the shipped bin never prints or records a provider key', () => {
  const writeFakeCli = (name, body) => {
    const bin = join(root, 'fake-bin');
    mkdirSync(bin, { recursive: true });
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return bin;
  };
  const filesUnder = (dir) => (existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
      ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]))
    : []);
  // Fails the run, then checks every surface the key could reach: the
  // `detail:` line and the rest of stderr, the --json settle, the run file
  // and the index.
  const expectKeyNowhere = async (agent, keys, { env = {}, flags = [] } = {}) => {
    const results = [];
    for (const json of [false, true]) {
      const result = await run(BIN, ['run', agent, 'hello', '--trace-dir', traces, ...flags, ...(json ? ['--json'] : [])], { env });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/^jellymoon: detail: .*\[redacted\]/m);
      const files = filesUnder(traces);
      expect(files).toEqual(expect.arrayContaining([join(traces, 'index.jsonl')]));
      expect(files.some((file) => file.startsWith(join(traces, 'runs')))).toBe(true);
      for (const key of keys) {
        expect(result.stderr).not.toContain(key);
        expect(result.stdout).not.toContain(key);
        for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain(key);
      }
      if (json) expect(JSON.parse(result.stdout)).toMatchObject({ outcome: expect.any(String), failure: expect.any(Object) });
      results.push(result);
    }
    return results;
  };

  test('claude: a key the CLI inherited and echoed on its auth error', async () => {
    const key = 'sk-ant-api03-CANARY-claude-0123456789abcdef';
    const bin = writeFakeCli('claude', [
      'if [ "$1" = "--version" ]; then echo "2.5.1 (Claude Code)"; exit 0; fi',
      'echo "Invalid API key: $ANTHROPIC_API_KEY" >&2',
      'exit 1',
    ].join('\n'));
    await expectKeyNowhere('claude', [key], { env: { PATH: `${bin}:/usr/bin:/bin`, ANTHROPIC_API_KEY: key } });
  });

  test('codex: keys of another provider the CLI inherited and echoed', async () => {
    const anthropic = 'sk-ant-api03-CANARY-codex-0123456789abcdef';
    const openrouter = 'sk-or-v1-CANARY-codex-0123456789abcdef';
    const bin = writeFakeCli('codex', [
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.133.0"; exit 0; fi',
      'echo "Invalid API key: $ANTHROPIC_API_KEY and $OPENROUTER_API_KEY" >&2',
      'exit 1',
    ].join('\n'));
    await expectKeyNowhere('codex', [anthropic, openrouter], {
      env: { PATH: `${bin}:/usr/bin:/bin`, ANTHROPIC_API_KEY: anthropic, OPENROUTER_API_KEY: openrouter },
    });
  });

  test('opencode: the --provider-key-file key, echoed in an error event', async () => {
    const key = 'sk-CANARY-keyfile-opencode-0123456789abcdef';
    const keyDir = join(root, 'keys');
    mkdirSync(keyDir, { mode: 0o700 });
    const keyFile = join(keyDir, 'provider.key');
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
    const bin = writeFakeCli('opencode', [
      'if [ "$1" = "--version" ]; then echo "1.19.4"; exit 0; fi',
      `KEY=$(cat '${keyFile}')`,
      'echo "{\\"type\\":\\"error\\",\\"error\\":{\\"message\\":\\"401 Incorrect API key provided: $KEY\\"}}"',
      'exit 1',
    ].join('\n'));
    const [plain] = await expectKeyNowhere('opencode', [key], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      flags: ['--model', 'some-model', '--provider-url', 'https://provider.invalid/v1', '--provider-key-file', keyFile],
    });
    // The key came from the file, so the fix is the file, not opencode's own login.
    expect(plain.last).toBe(lineFor('not_authenticated'));
    expect(plain.stderr).toContain(`jellymoon: hint: check the key in --provider-key-file ${keyFile}`);
    expect(plain.stderr).not.toContain('opencode auth login');
  });
});
