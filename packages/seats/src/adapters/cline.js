/**
 * Cline CLI, one headless turn per process:
 *   cline --json --config <dir> -P openai-compatible -m <model> [--id <taskId>] <prompt>
 *
 * Cline takes a provider only from its settings store (`cline auth` wants the
 * key in argv), so the adapter writes <config>/data/settings/providers.json
 * itself, mode 0600, with the run's base URL and key. The config directory
 * lives under the run's HOME, so a resume finds the task the first turn made.
 * The prompt is the one positional argument; the key is never in argv.
 *
 * stdout is NDJSON: agent_event content_start carries text, and run_result
 * closes the turn with finishReason and text. A failure also arrives on
 * stderr as {"type":"error","message":...}.
 *
 * The id `--id` resumes is the session id `cline history` lists, which
 * stdout never prints (its taskId is a different id). Each turn records one
 * directory under <config>/data/sessions/ named by it, so the session id is
 * the one directory the turn added. Measured on 3.0.73: `--id` with `--json`
 * then refuses every prompt form (positional, after `--`, piped stdin) with
 * "JSON output mode requires a prompt argument or piped stdin", so a resume
 * fails by name; targets.json carries that as a limit.
 */
import { readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHeadlessAdapter, failureFromText } from './headless.js';
import { runFailure } from '../failures.js';

const PROVIDER = 'openai-compatible';

const parse = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

export const readClineEvent = (line, state) => {
  const event = parse(line);
  if (!event || typeof event !== 'object') return;
  if (event.type === 'agent_event') {
    const inner = event.event || {};
    if (inner.type === 'content_start' && inner.contentType === 'text' && typeof inner.text === 'string' && inner.text) state.chunks.push(inner.text);
    if (inner.type === 'error') state.lastError = String(inner.error?.message || 'agent error');
  } else if (event.type === 'run_result') {
    if (event.finishReason === 'completed') state.text = String(event.text ?? '');
    else state.error = String(event.text || state.lastError || `cline finished with ${event.finishReason}`);
  } else if (event.type === 'error' && !state.error) {
    state.error = String(event.message || 'cline error');
  }
};

// Cline ignores a provider entry with no updatedAt and falls back to its own
// default route (api.openai.com, or api.cline.bot with no -P), measured on
// 3.0.73: the file `cline auth` writes differs from this one only by it.
export const providersFile = ({ baseURL, apiKey, model }, now = new Date()) => ({
  version: 1,
  lastUsedProvider: PROVIDER,
  modes: {},
  providers: {
    [PROVIDER]: {
      settings: { provider: PROVIDER, apiKey, model, baseUrl: baseURL },
      updatedAt: now.toISOString(),
      tokenSource: 'manual',
    },
  },
});

const sessionsOf = (dir) => {
  try { return readdirSync(dir); } catch { return []; }
};

export const settleCline = (state, { code, stderr, credentials }) => {
  if (state.error || code !== 0) {
    throw failureFromText('cline', state.error || stderr || `exit ${code}`, { credentials, exitCode: code });
  }
  if (typeof state.text !== 'string') throw runFailure('protocol', 'cline exited 0 without a run_result');
  const before = new Set(state.sessionsBefore || []);
  const added = state.sessionsDir ? sessionsOf(state.sessionsDir).filter((name) => !before.has(name)) : [];
  const sessionId = state.resumed || (added.length === 1 ? added[0] : null);
  return { text: state.text, ...(sessionId ? { newSessionId: sessionId } : {}) };
};

export const createClineAdapter = createHeadlessAdapter({
  name: 'cline',
  cli: 'cline',
  command: 'cline',
  versionPattern: /(\d+\.\d+\.\d+[^\s]*)/,
  async launch(prompt, ctx, { provider, env, home }) {
    const config = join(home, '.cline');
    const settings = join(config, 'data', 'settings');
    await mkdir(settings, { recursive: true, mode: 0o700 });
    await writeFile(join(settings, 'providers.json'), JSON.stringify(providersFile(provider), null, 2), { mode: 0o600 });
    const sessionsDir = join(config, 'data', 'sessions');
    return {
      state: { sessionsDir, sessionsBefore: sessionsOf(sessionsDir), resumed: ctx.sessionId || null },
      args: [
        '--json', '--config', config, '-P', PROVIDER, '-m', provider.model,
        ...(ctx.sessionId ? ['--id', ctx.sessionId] : []),
        '--', prompt,
      ],
      env,
    };
  },
  read: readClineEvent,
  settle: settleCline,
});

export default createClineAdapter;
