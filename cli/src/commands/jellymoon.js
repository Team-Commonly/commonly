/**
 * `jellymoon run <agent> "<task>"`: one supervised turn of a local agent CLI,
 * with no Commonly account, no server and no token. Reachable as
 * `commonly jellymoon run …` and as the `jellymoon` bin (src/jellymoon.js).
 *
 * The run itself is packages/seats (runStandaloneTurn: detect, supervise,
 * name the failure, pick the exit code). This module binds the four CLI
 * adapters, reads the command line, and prints. Exit codes and the last
 * stderr line are documented in packages/seats/README.md.
 */
import { Command } from 'commander';
import { join } from 'node:path';
import { createTraceStore } from '@commonlyai/seats/trace/store';
import { RunFailure } from '@commonlyai/seats/failures';
import { EXIT_USAGE, exitCodeTable } from '@commonlyai/seats/exit-codes';
import {
  cwdRefusal, defaultTraceDir, runStandaloneTurn, traceDirRefusal,
} from '@commonlyai/seats/standalone';
import { getAdapter } from '../lib/adapters/index.js';
import { assertProviderCapable, validateEnvironmentSpec } from '../lib/environment.js';

const PROG = 'jellymoon';

export const JELLYMOON_AGENTS = Object.freeze(['claude', 'codex', 'opencode', 'goose']);

// The no-progress window per CLI. claude runs in text mode and writes nothing
// until the reply is done, so silence is not a hang there and the window is
// off. codex's 15 minutes is 5.5x the worst quiet gap measured in 9,703
// October codex turns on one host; opencode and goose stream events the
// same way and take the same window until they have numbers of their own.
const QUIET_WINDOW_MS = 15 * 60 * 1000;
export const STALL_DEFAULT_MS = Object.freeze({
  claude: 0, codex: QUIET_WINDOW_MS, opencode: QUIET_WINDOW_MS, goose: QUIET_WINDOW_MS,
});

// Goose's adapter isolates HOME, so goose's own `goose configure` does not
// reach it, and its default route is a Commonly-hosted provider. Standalone,
// it runs only on a provider the user names.
const NEEDS_PROVIDER = new Set(['goose']);

// The provider id `--provider-url` declares: an OpenAI-compatible endpoint.
const PROVIDER_ID = 'jellymoon';

const SETUP_HINTS = Object.freeze({
  claude: { install: 'npm install -g @anthropic-ai/claude-code', login: 'run `claude` once and sign in' },
  codex: { install: 'npm install -g @openai/codex', login: 'run `codex login`' },
  opencode: { install: 'npm install -g opencode-ai', login: 'run `opencode auth login`' },
  goose: {
    install: 'see https://block.github.io/goose/docs/getting-started/installation',
    login: 'pass --model, --provider-url and --provider-key-file (a 0600 file holding the key)',
  },
});

export const defaultJellymoonAdapters = () => Object.fromEntries(
  JELLYMOON_AGENTS.map((name) => [name, getAdapter(name)]),
);

class UsageError extends Error {}

const seconds = (value, flag, { allowZero = false } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) {
    throw new UsageError(`${flag} must be a ${allowZero ? 'non-negative' : 'positive'} number of seconds, got ${value}`);
  }
  return Math.round(number * 1000);
};

// The adapter as goose sees it standalone without a provider: found or not
// first, then refused, so `not_installed` still wins when both are true.
const requireProvider = (adapter) => ({
  ...adapter,
  detect: () => adapter.detect(),
  async spawn() {
    throw new RunFailure('not_authenticated',
      `${adapter.name} runs only on a provider you name: pass --model, --provider-url and --provider-key-file`);
  },
});

const environmentFrom = (opts) => {
  const environment = {};
  if (opts.model) environment.model = String(opts.model).trim();
  if (opts.providerUrl || opts.providerKeyFile) {
    if (!opts.providerUrl || !opts.providerKeyFile) {
      throw new UsageError('--provider-url and --provider-key-file go together');
    }
    environment.provider = { id: PROVIDER_ID, baseURL: String(opts.providerUrl), keyFile: String(opts.providerKeyFile) };
  }
  if (!Object.keys(environment).length) return null;
  const validation = validateEnvironmentSpec(environment);
  if (!validation.ok) throw new UsageError(validation.errors.join('; '));
  return environment;
};

const usage = (stderr, message) => {
  stderr.write(`${PROG}: usage: ${message}\n`);
  return EXIT_USAGE;
};

/**
 * Run one turn and print it. Returns the exit code; never calls process.exit.
 *
 * @param {object} args
 * @param {string} args.agent
 * @param {string} args.task
 * @param {object} [args.opts]       parsed flags: cwd, timeout, stall, json, traceDir, model, providerUrl, providerKeyFile
 * @param {Record<string, object>} [args.adapters]  name → adapter; the four CLIs by default
 * @param {AbortSignal} [args.signal]  cancels the run (outcome `cancelled`)
 */
export const performJellymoonRun = async ({
  agent, task, opts = {}, adapters = defaultJellymoonAdapters(), env = process.env,
  stdout = process.stdout, stderr = process.stderr, signal,
}) => {
  const base = adapters[agent];
  if (!base) return usage(stderr, `unknown agent "${agent}"; choose one of ${Object.keys(adapters).join(', ')}`);
  if (typeof task !== 'string' || !task.trim()) return usage(stderr, 'the task is empty');

  let cwd;
  let timeoutMs;
  let stallMs;
  let environment;
  let traceDir;
  let store;
  try {
    cwd = opts.cwd ? String(opts.cwd) : process.cwd();
    const cwdProblem = cwdRefusal(cwd);
    if (cwdProblem) throw new UsageError(cwdProblem);
    timeoutMs = seconds(opts.timeout ?? 900, '--timeout');
    stallMs = opts.stall === undefined
      ? (STALL_DEFAULT_MS[agent] ?? undefined)
      : seconds(opts.stall, '--stall', { allowZero: true });
    environment = environmentFrom(opts);
    try {
      assertProviderCapable(environment, base);
    } catch {
      throw new UsageError(`${agent} cannot run on --provider-url; it signs in through its own CLI`);
    }
    traceDir = opts.traceDir ? String(opts.traceDir) : defaultTraceDir({ env });
    const traceProblem = traceDirRefusal(traceDir, cwd);
    if (traceProblem) throw new UsageError(traceProblem);
    try {
      store = createTraceStore({ root: traceDir });
    } catch (error) {
      throw new UsageError(`cannot write traces to ${traceDir}: ${error.message}`);
    }
  } catch (error) {
    if (error instanceof UsageError) return usage(stderr, error.message);
    throw error;
  }

  const adapter = NEEDS_PROVIDER.has(agent) && !environment?.provider ? requireProvider(base) : base;
  const run = await runStandaloneTurn({
    adapter,
    prompt: task,
    store,
    cwd,
    timeoutMs,
    ...(stallMs === undefined ? {} : { stallMs }),
    signal,
    label: `${PROG} run ${agent}`,
    prog: PROG,
    ctx: {
      env,
      environment,
      agentName: PROG,
      // Not a Commonly seat: the task goes to the CLI verbatim, with no memory cue.
      memoryPreamble: (prompt) => prompt,
    },
  });
  const trace = join(traceDir, 'runs', `${run.runId}.jsonl`);

  if (opts.json) {
    stdout.write(`${JSON.stringify({
      ...run.settle,
      runId: run.runId,
      agent,
      kind: run.kind,
      exitCode: run.exitCode,
      ...(run.text !== undefined ? { text: run.text, sessionId: run.sessionId } : {}),
      trace,
    })}\n`);
  } else if (run.outcome === 'ok') {
    stdout.write(run.text.endsWith('\n') ? run.text : `${run.text}\n`);
  }

  if (run.outcome !== 'ok') {
    const detail = run.settle?.failure?.detail;
    stderr.write(`${PROG}: trace: ${trace}\n`);
    if (detail) stderr.write(`${PROG}: detail: ${String(detail).replace(/\s*\n\s*/g, ' ').slice(0, 500)}\n`);
    const hint = SETUP_HINTS[agent];
    if (hint && run.kind === 'not_installed') stderr.write(`${PROG}: hint: install ${agent}: ${hint.install}\n`);
    if (run.kind === 'not_authenticated') {
      // With a key file supplied, the CLI signed in with that key, so its own
      // login is not the fix; goose's hint already names the flags.
      const keyFile = agent !== 'goose' ? environment?.provider?.keyFile : null;
      if (keyFile) stderr.write(`${PROG}: hint: check the key in --provider-key-file ${keyFile}\n`);
      else if (hint) stderr.write(`${PROG}: hint: ${hint.login}\n`);
    }
    stderr.write(`${run.failureLine}\n`);
  }
  return run.exitCode;
};

// Ctrl-C (or SIGTERM) cancels the turn: the supervisor kills the CLI and the
// run settles as `cancelled`. A second signal exits at once.
const cancellingSignals = () => {
  const controller = new AbortController();
  const handlers = {};
  for (const name of ['SIGINT', 'SIGTERM']) {
    handlers[name] = () => {
      if (controller.signal.aborted) process.exit(130);
      controller.abort(new RunFailure('cancelled', `interrupted by ${name}`));
    };
    process.on(name, handlers[name]);
  }
  return {
    signal: controller.signal,
    release: () => { for (const [name, handler] of Object.entries(handlers)) process.off(name, handler); },
  };
};

// Exit once stdout and stderr have drained: a piped stdout is written
// asynchronously, and process.exit would cut a long reply short.
const exitWhenFlushed = (code) => {
  let pending = 2;
  const done = () => { pending -= 1; if (pending === 0) process.exit(code); };
  process.stdout.write('', done);
  process.stderr.write('', done);
};

const usageExit = (error) => {
  process.exit(error.exitCode === 0 ? 0 : EXIT_USAGE);
};

const exitCodeHelp = () => [
  '',
  'Exit codes:',
  ...exitCodeTable().map(({ code, name }) => `  ${String(code).padStart(3)}  ${name}`),
  '',
  'On failure, the last stderr line is `jellymoon: <kind>: <meaning>`.',
  'Docs: https://github.com/Team-Commonly/commonly/blob/main/packages/seats/README.md#jellymoon-run',
].join('\n');

const addRunCommand = (parent, { adapters } = {}) => parent
  .command('run')
  .description('Run one supervised turn of a local agent CLI. No account, server or login to Commonly.')
  .argument('<agent>', `the agent CLI: ${JELLYMOON_AGENTS.join(', ')}`)
  .argument('<task>', 'the task, as one quoted string')
  .option('--cwd <dir>', 'the directory the agent works in (default: the current directory)')
  .option('--timeout <seconds>', 'wall-clock budget for the turn', '900')
  .option('--stall <seconds>', 'no-progress window before the turn is named stuck; 0 turns it off (default: per agent)')
  .option('--json', "print the run's settle as one JSON object on stdout")
  .option('--trace-dir <dir>', `where the run record goes; never inside the repository (default: ${defaultTraceDir()})`)
  .option('--model <id>', "the model to run; default: the CLI's own")
  .option('--provider-url <url>', 'an OpenAI-compatible base URL (opencode, goose)')
  .option('--provider-key-file <path>', 'absolute path to a mode-0600 file holding that provider\'s key')
  .addHelpText('after', exitCodeHelp())
  .exitOverride(usageExit)
  .action(async (agent, task, opts) => {
    const signals = cancellingSignals();
    let code;
    try {
      code = await performJellymoonRun({
        agent, task, opts, adapters: adapters || defaultJellymoonAdapters(), signal: signals.signal,
      });
    } finally {
      signals.release();
    }
    exitWhenFlushed(code);
  });

/** `commonly jellymoon run …` */
export const registerJellymoon = (program, options = {}) => {
  const jellymoon = program
    .command('jellymoon')
    .description('Run a local agent CLI under supervision, with no Commonly account or server')
    .exitOverride(usageExit);
  addRunCommand(jellymoon, options);
  return jellymoon;
};

/** The `jellymoon` bin's own program, with `run` as its subcommand. */
export const buildJellymoonProgram = ({ adapters, version } = {}) => {
  const program = new Command(PROG)
    .description('Run a local agent CLI (claude, codex, opencode, goose) for one supervised turn')
    .exitOverride(usageExit);
  if (version) program.version(version);
  addRunCommand(program, { adapters });
  return program;
};
