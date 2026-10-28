/**
 * An adapter for test-support/fake-cli.mjs. It exists so the compatibility
 * runner is proven against a real child process — argv, env, stdio, exit codes
 * and kills — before any third-party CLI is wired in.
 *
 * `createFakeCliAdapter({ fault })` builds a deliberately broken variant, one
 * defect per name, so each check can be shown to fail for the reason it names:
 *   adapter-side: key-in-argv, retry-refusal, no-timeout, plain-error,
 *                 unscrubbed-error, bad-trace
 *   child-side (passed through FAKE_CLI_FAULT): echo-key, extra-text,
 *                 new-session, error-echo-key, double-call, retry-5xx-forever
 *   version:      { version } overrides what the child reports
 */
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { RunFailure, runFailure } from '../src/failures.js';
import { traceOf } from '../src/trace/events.js';
import { observeSpawn } from '../src/runtime-observation.js';

export const FAKE_CLI_PATH = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const CHILD_FAULTS = new Set(['echo-key', 'extra-text', 'new-session', 'error-echo-key', 'double-call', 'retry-5xx-forever']);
const DEFAULT_TIMEOUT_MS = 30000;
const KILL_GRACE_MS = 2000;

// A provider body that names a content policy is a refusal; anything else
// from the provider is an upstream failure the CLI could not get past.
const failureFor = (result, credentials, scrub) => {
  const status = Number(result?.status) || 0;
  const text = `provider answered ${status}: ${String(result?.error || '').slice(0, 300)}`;
  const kind = status === 400 && /content.policy|content_policy/i.test(String(result?.error)) ? 'refusal' : 'exited';
  return scrub ? runFailure(kind, text, { credentials }) : new RunFailure(kind, text);
};

const runOnce = ({ args, prompt, env, cwd, timeoutMs, signal, onSpawn, trace }) => new Promise((resolve) => {
  const child = childSpawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  observeSpawn(child, onSpawn, { model: env.FAKE_CLI_MODEL });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let result = null;
  let ended = null; // why we stopped the child, if we did
  let killTimer;
  const stop = (reason) => {
    if (ended) return;
    ended = reason;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  };
  const timer = timeoutMs ? setTimeout(() => stop('timeout'), timeoutMs) : null;
  const onAbort = () => stop('aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'message') trace.emit('agent.message_chunk', { text: String(event.text ?? '') });
      if (event.type === 'result') result = event;
    }
  });
  child.stderr.resume();
  child.on('error', () => stop('spawn-error'));
  child.on('close', (code, sig) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
    trace.emit('process.exited', { code, signal: sig });
    resolve({ result, code, ended });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
});

export const createFakeCliAdapter = ({ fault = null, version = null, bin = FAKE_CLI_PATH } = {}) => ({
  name: fault ? `fake-cli:${fault}` : 'fake-cli',
  runtimeType: 'fake-cli',
  providerKeyEnv: 'FAKE_CLI_API_KEY',

  async detect() {
    const env = { ...process.env, ...(version ? { FAKE_CLI_VERSION: version } : {}) };
    const probe = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', env, timeout: 10000 });
    const found = /^fake-cli (\S+)/.exec(String(probe.stdout || ''))?.[1];
    return probe.status === 0 && found ? { path: bin, version: found } : null;
  },

  async spawn(prompt, ctx = {}) {
    const trace = traceOf(ctx);
    const provider = ctx.provider;
    if (!provider?.baseURL) throw runFailure('unsupported', 'fake-cli needs ctx.provider');
    const credentials = provider.apiKey ? [provider.apiKey] : [];
    const env = {
      ...(ctx.env || {}),
      FAKE_CLI_BASE_URL: provider.baseURL,
      FAKE_CLI_MODEL: provider.model || '',
      FAKE_CLI_API_KEY: provider.apiKey || '',
      ...(CHILD_FAULTS.has(fault) ? { FAKE_CLI_FAULT: fault } : {}),
    };
    const args = [bin, 'run'];
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    if (fault === 'key-in-argv') args.push('--api-key', provider.apiKey);
    const requested = Number(ctx.timeoutMs);
    const timeoutMs = fault === 'no-timeout' ? 0
      : (Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS);
    const started = Date.now();
    const settle = (outcome, failure) => {
      const data = { outcome, durationMs: Date.now() - started, attempts };
      if (failure) data.failure = { kind: failure.kind, detail: failure.detail };
      trace.emit('run.settled', data);
    };

    let attempts = 0;
    const maxAttempts = fault === 'retry-refusal' ? 2 : 1;
    if (fault === 'bad-trace') trace.emit('turn.prompt_sent', { chars: prompt.length });
    for (;;) {
      attempts += 1;
      trace.emit('run.started', { adapter: this.name, cli: { name: 'fake-cli', version: version || '1.0.0' }, sessionId: ctx.sessionId, attempt: attempts });
      if (fault !== 'bad-trace') trace.emit('turn.prompt_sent', { chars: prompt.length });
      const { result, ended } = await runOnce({
        args, prompt, env, cwd: ctx.cwd, timeoutMs, signal: ctx.signal, onSpawn: ctx.onSpawn, trace,
      });
      let failure = null;
      if (ended === 'aborted') {
        const reason = ctx.signal?.reason;
        failure = reason instanceof RunFailure ? reason : runFailure('cancelled', 'the caller cancelled the turn');
      } else if (ended === 'timeout') {
        failure = runFailure('timeout', `fake-cli made no answer within ${timeoutMs}ms`);
      } else if (ended === 'spawn-error' || !result) {
        failure = runFailure('exited', 'fake-cli ended without a result');
      } else if (!result.ok) {
        failure = failureFor(result, credentials, fault !== 'unscrubbed-error' && fault !== 'error-echo-key');
      }
      if (!failure) {
        settle('ok');
        return { text: String(result.text ?? ''), newSessionId: result.session_id };
      }
      if (fault === 'retry-refusal' && failure.kind === 'refusal' && attempts < maxAttempts) continue;
      settle(failure.kind === 'cancelled' ? 'cancelled' : 'failed', failure);
      if (fault === 'plain-error') throw new Error(failure.detail);
      throw failure;
    }
  },
});

export default createFakeCliAdapter();
