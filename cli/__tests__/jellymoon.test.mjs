/**
 * `jellymoon run` in process: the paths the end-to-end suite cannot reach
 * without a real agent CLI (a CLI that is installed but has no credential),
 * and the seams the command relies on (the memory-preamble hook, the
 * registration under `commonly`). Adapters here are in-process stubs.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { FAILURE_KINDS } from '@commonlyai/seats/failures';
import {
  JELLYMOON_AGENTS, STALL_DEFAULT_MS, buildJellymoonProgram, performJellymoonRun, registerJellymoon,
} from '../src/commands/jellymoon.js';
import { buildMemoryPreamble, memoryPreambleFor } from '../src/lib/memory-bridge.js';
import { getAdapter } from '../src/lib/adapters/index.js';

let root;
let work;
let traces;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jellymoon-unit-')));
  work = join(root, 'work');
  traces = join(root, 'traces');
  mkdirSync(work);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const sink = () => {
  const chunks = [];
  return { write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') };
};

const stub = (name, spawn, { supportsProvider = false } = {}) => ({
  name, supportsProvider, detect: async () => ({ path: `/bin/${name}`, version: '1.0.0' }), spawn,
});

const runWith = async (agent, adapter, opts = {}) => {
  const stdout = sink();
  const stderr = sink();
  const code = await performJellymoonRun({
    agent,
    task: 'do the thing',
    opts: { cwd: work, traceDir: traces, ...opts },
    adapters: { [agent]: adapter },
    env: { PATH: '' },
    stdout,
    stderr,
  });
  const lines = stderr.text().trimEnd().split('\n');
  return { code, stdout: stdout.text(), stderr: stderr.text(), last: lines[lines.length - 1] };
};

test('the four agents are bound to the real adapters, each with a stall default', () => {
  expect([...JELLYMOON_AGENTS]).toEqual(['claude', 'codex', 'opencode', 'goose']);
  for (const agent of JELLYMOON_AGENTS) {
    expect(getAdapter(agent)).toBeTruthy();
    expect(Number.isInteger(STALL_DEFAULT_MS[agent])).toBe(true);
  }
  // claude prints nothing until its reply is done, so silence is not a hang.
  expect(STALL_DEFAULT_MS.claude).toBe(0);
});

test('the task reaches the adapter verbatim: no Commonly memory or board cue', async () => {
  const seen = [];
  const adapter = stub('codex', async (prompt, ctx) => {
    seen.push(memoryPreambleFor(ctx)(prompt, 'LONG-TERM MEMORY', { freshSession: true, workCues: ['a board cue'] }));
    return { text: 'done' };
  });
  const result = await runWith('codex', adapter);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe('done\n');
  expect(seen).toEqual(['do the thing']);
});

test('without the hook, an adapter still gets the Commonly preamble (the run loop is unchanged)', () => {
  expect(memoryPreambleFor({})).toBe(buildMemoryPreamble);
  expect(memoryPreambleFor(undefined)).toBe(buildMemoryPreamble);
});

test('goose found but given no provider settles not_authenticated (23) with a hint', async () => {
  let spawned = false;
  const result = await runWith('goose', stub('goose', async () => { spawned = true; return { text: '' }; }, { supportsProvider: true }));
  expect(spawned).toBe(false);
  expect(result.code).toBe(23);
  expect(result.stderr).toMatch(/^jellymoon: hint: pass --model, --provider-url and --provider-key-file/m);
  expect(result.last).toBe(`jellymoon: not_authenticated: ${FAILURE_KINDS.not_authenticated.meaning}`);
});

test('a CLI that says it is not signed in settles not_authenticated (23) with its login hint', async () => {
  const adapter = stub('codex', async () => { throw Object.assign(new Error('codex exited 1'), { stderr: 'Error: not logged in' }); });
  const result = await runWith('codex', adapter);
  expect(result.code).toBe(23);
  expect(result.stderr).toMatch(/^jellymoon: hint: run `codex login`$/m);
  expect(result.stderr).toMatch(/^jellymoon: detail: codex exited 1 Error: not logged in$/m);
});

test('an agent that cannot take a provider refuses --provider-url as usage (2), before any run', async () => {
  let detected = false;
  const adapter = { ...stub('claude', async () => ({ text: '' })), detect: async () => { detected = true; return null; } };
  const result = await runWith('claude', adapter, {
    model: 'some-model', providerUrl: 'http://127.0.0.1:1/v1', providerKeyFile: join(root, 'key'),
  });
  expect(result.code).toBe(2);
  expect(result.last).toBe('jellymoon: usage: claude cannot run on --provider-url; it signs in through its own CLI');
  expect(detected).toBe(false);
});

test('--provider-url without --provider-key-file is a usage error', async () => {
  const result = await runWith('opencode', stub('opencode', async () => ({ text: '' }), { supportsProvider: true }), {
    providerUrl: 'http://127.0.0.1:1/v1',
  });
  expect(result.code).toBe(2);
  expect(result.last).toMatch(/--provider-url and --provider-key-file go together/);
});

test('an empty task and a missing cwd are usage errors', async () => {
  const adapter = stub('codex', async () => ({ text: '' }));
  const stderr = sink();
  expect(await performJellymoonRun({
    agent: 'codex', task: '  ', opts: { traceDir: traces }, adapters: { codex: adapter }, stderr, stdout: sink(),
  })).toBe(2);
  const missing = await runWith('codex', adapter, { cwd: join(root, 'nope') });
  expect(missing.code).toBe(2);
  expect(missing.last).toMatch(/does not exist/);
});

test('registers as `commonly jellymoon run` and as the bin\'s own `run`', () => {
  const program = new Command();
  program.exitOverride();
  registerJellymoon(program);
  const jellymoon = program.commands.find((c) => c.name() === 'jellymoon');
  const run = jellymoon?.commands.find((c) => c.name() === 'run');
  expect(run).toBeTruthy();
  const flags = run.options.map((o) => o.long);
  for (const flag of ['--cwd', '--timeout', '--stall', '--json', '--trace-dir', '--model', '--provider-url', '--provider-key-file']) {
    expect(flags).toContain(flag);
  }
  const bin = buildJellymoonProgram({ version: '0.0.0' });
  expect(bin.name()).toBe('jellymoon');
  expect(bin.commands.map((c) => c.name())).toEqual(['run']);
});
