/**
 * Aider, one turn per process:
 *   aider --model openai/<model> --openai-api-base <url> --message <prompt> --no-stream …
 *
 * Aider reaches the provider through litellm's OpenAI route; the key goes in
 * OPENAI_API_KEY, never argv. It has no machine-readable output: stdout is a
 * banner, the reply, then a `Tokens: … sent, … received.` line. A provider
 * error prints in place of the reply, with no Tokens line, and aider still
 * exits 0, so the Tokens line is what says the turn answered.
 *
 * Aider has no session ids. A session here is a chat-history file under the
 * run's HOME, named by an id the adapter makes; a resume restores it with
 * --restore-chat-history.
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runFailure } from '../failures.js';
import { createHeadlessAdapter, failureFromText } from './headless.js';

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const TOKENS_LINE = /^Tokens: [\d.,]+k? sent/;
// What aider prints before the reply; none of it is the agent's answer.
const BANNER_LINE = /^(?:Aider v\d|Model: |Weak model: |Editor model: |Git repo: |Repo-map: |Restored previous conversation history|Added .* to the chat|https:\/\/aider\.chat\/|Warning: |Note: |Cur working dir: |HTTPSConnectionPool\(|Can't initialize prompt toolkit)/;

export const readAiderLine = (line, state) => {
  (state.lines ||= []).push(line);
};

/** The reply is what sits between the banner and the last Tokens line. */
export const settleAider = (state, { code, stderr, credentials }) => {
  const lines = state.lines || [];
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (TOKENS_LINE.test(lines[i])) { end = i; break; }
  let start = 0;
  for (let i = 0; i < (end === -1 ? lines.length : end); i += 1) if (BANNER_LINE.test(lines[i])) start = i + 1;
  if (end === -1) {
    const said = lines.slice(start).filter((l) => l.trim() && !/^Retrying in /.test(l)).join(' ');
    throw failureFromText('aider', said || stderr || `exit ${code} with no reply`, { credentials, exitCode: code });
  }
  if (code !== 0) throw failureFromText('aider', stderr || `exit ${code}`, { credentials, exitCode: code });
  const text = lines.slice(start, end).join('\n').trim();
  if (!text) throw runFailure('protocol', 'aider printed a Tokens line and no reply');
  return { text, newSessionId: state.sessionId };
};

export const createAiderAdapter = createHeadlessAdapter({
  name: 'aider',
  cli: 'aider',
  command: 'aider',
  versionPattern: /aider\s+v?(\d+\.\d+\.\d+[^\s]*)/,
  async launch(prompt, ctx, { provider, env, home }) {
    if (ctx.sessionId && !SESSION_ID.test(ctx.sessionId)) throw runFailure('unsupported', 'aider: session id is not one this adapter made');
    const sessionId = ctx.sessionId || randomUUID();
    const dir = join(home, '.seats-aider');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return {
      args: [
        '--model', `openai/${provider.model}`, '--openai-api-base', provider.baseURL,
        '--message', prompt,
        '--chat-history-file', join(dir, `${sessionId}.chat.md`),
        '--input-history-file', join(dir, `${sessionId}.input`),
        ...(ctx.sessionId ? ['--restore-chat-history'] : ['--no-restore-chat-history']),
        '--llm-history-file', '/dev/null',
        '--yes-always', '--no-git', '--no-gitignore', '--no-auto-commits', '--no-auto-lint',
        '--no-pretty', '--no-stream', '--no-fancy-input', '--no-detect-urls', '--no-suggest-shell-commands',
        '--no-check-update', '--no-analytics', '--no-show-model-warnings', '--no-show-release-notes',
        '--map-tokens', '0',
      ],
      env: {
        ...env,
        OPENAI_API_KEY: provider.apiKey,
        // litellm would otherwise fetch its model price list from GitHub on start.
        LITELLM_LOCAL_MODEL_COST_MAP: 'True',
        AIDER_ANALYTICS: 'false',
        AIDER_CHECK_UPDATE: 'false',
      },
      state: { sessionId },
    };
  },
  read: readAiderLine,
  settle: settleAider,
});

export default createAiderAdapter;
