/**
 * At-wake session recycle (TASK-440).
 *
 * A seat resumes its CLI session on every wake, so a long-lived seat drags a
 * large cold context into each turn. When a wake finds the seat idle long
 * enough that the prompt cache is cold AND the last session's context is big
 * enough to matter, start a fresh session instead, seeded with a short
 * restart note. Otherwise resume exactly as before.
 *
 * F392: a seat woken every few minutes is never idle long enough for that
 * rule, so its context grew without bound. Past a hard ceiling it starts fresh
 * whatever the idle time.
 *
 * Thresholds are per-install: COMMONLY_SESSION_RECYCLE_IDLE_MINUTES,
 * COMMONLY_SESSION_RECYCLE_CONTEXT_TOKENS and
 * COMMONLY_SESSION_RECYCLE_MAX_CONTEXT_TOKENS override the defaults below.
 *
 * Context size is what the last model request of the turn was sent: claude and
 * codex from the transcript the child CLI wrote, under the env it ran with; pi
 * and dsh from the usage on their own JSON stream (F404). An adapter that
 * reports nothing keeps resuming, as before this module existed.
 */

import {
  closeSync, existsSync, fstatSync, openSync, readdirSync, readSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const RECYCLE_DEFAULTS = Object.freeze({
  idleMinutes: 60,
  contextTokens: 128000,
  maxContextTokens: 256000,
});

// Read this many bytes from the end of a transcript. The last assistant
// usage record sits near the end; a full read of a long-lived transcript
// would cost more than the recycle saves.
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

const positiveNumber = (raw, fallback) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const recycleThresholds = (env = process.env) => ({
  idleMinutes: positiveNumber(env.COMMONLY_SESSION_RECYCLE_IDLE_MINUTES, RECYCLE_DEFAULTS.idleMinutes),
  contextTokens: positiveNumber(env.COMMONLY_SESSION_RECYCLE_CONTEXT_TOKENS, RECYCLE_DEFAULTS.contextTokens),
  maxContextTokens: positiveNumber(env.COMMONLY_SESSION_RECYCLE_MAX_CONTEXT_TOKENS, RECYCLE_DEFAULTS.maxContextTokens),
});

// Pure decision: 'cold' (idle long enough AND large), 'size' (past the hard
// ceiling, however recent), or null to resume. No evidence (no last turn, no
// measured context) means resume.
export const recycleReason = ({
  lastTurn,
  contextTokens,
  now = Date.now(),
  thresholds = RECYCLE_DEFAULTS,
}) => {
  if (!lastTurn || !Number.isFinite(contextTokens)) return null;
  const last = Date.parse(lastTurn);
  if (!Number.isFinite(last)) return null;
  if (now - last >= thresholds.idleMinutes * 60_000 && contextTokens >= thresholds.contextTokens) return 'cold';
  const ceiling = thresholds.maxContextTokens ?? RECYCLE_DEFAULTS.maxContextTokens;
  return contextTokens >= ceiling ? 'size' : null;
};

export const shouldStartFreshSession = (args) => recycleReason(args) !== null;

export const idleMinutesSince = (lastTurn, now = Date.now()) => {
  const last = Date.parse(lastTurn);
  return Number.isFinite(last) ? Math.floor((now - last) / 60_000) : null;
};

// The restart note. The memory head and the pod focus are NOT repeated here:
// a fresh claude session already receives the full long_term memory through
// its preamble, and the pod focus is already in the wake prompt.
export const buildRecycleBriefing = ({
  agentName, reason = 'cold', idleMinutes, contextTokens, maxContextTokens = RECYCLE_DEFAULTS.maxContextTokens,
}) => [
  '=== Session restart ===',
  reason === 'size'
    ? `This wake starts a fresh session. The previous session had grown to about ${contextTokens}`
      + ` context tokens, past the ${maxContextTokens}-token ceiling, so it was not resumed.`
    : `This wake starts a fresh session. The previous session was idle ${idleMinutes} min`
      + ` with about ${contextTokens} context tokens, so it was not resumed.`,
  `Role: ${agentName}. Your saved memory and the pod focus follow below.`,
].join('\n');

// The config dir the CHILD claude process uses. A public seat runs claude
// under an isolated HOME, so reading the operator's ~/.claude would find no
// transcript and the recycle would never fire.
export const claudeConfigDirFor = (env = process.env) => (
  env?.CLAUDE_CONFIG_DIR || join(env?.HOME || homedir(), '.claude')
);

// Claude Code stores a session at
// <config>/projects/<cwd with every non-alphanumeric character as '-'>/<id>.jsonl
export const claudeTranscriptPath = ({ cwd, sessionId, configDir = claudeConfigDirFor() }) => {
  if (!cwd || !sessionId) return null;
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return join(configDir, 'projects', encoded, `${sessionId}.jsonl`);
};

const readTail = (file) => {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
};

// Context tokens of the most recent assistant turn: uncached input plus the
// cache creation and cache read that make up the prompt sent that turn.
export const contextTokensFromTranscript = (text) => {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // the first line of a tail read can be cut mid-record
    }
    const usage = record?.message?.usage;
    if (record?.type === 'assistant' && usage && typeof usage === 'object') {
      return (usage.input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0)
        + (usage.cache_read_input_tokens || 0);
    }
  }
  return null;
};

/**
 * The prompt one request was sent, from a usage block that counts cached tokens
 * apart from `input` (pi's message usage, dsh's step usage). Null when `input`
 * is missing, so a stream without usage reads as unknown, not as zero.
 */
export const promptTokens = ({ input, cacheRead, cacheWrite } = {}) => {
  if (!Number.isFinite(input)) return null;
  return input + (Number.isFinite(cacheRead) ? cacheRead : 0) + (Number.isFinite(cacheWrite) ? cacheWrite : 0);
};

// F404. codex keeps a session as <home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl,
// dated by when it began; `exec resume` appends to that same file. Newest day
// first, so a live session is found after a few directory reads.
const newestFirst = (dir) => {
  try {
    return readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
};

export const codexHomeFor = (env = process.env) => env?.CODEX_HOME || join(env?.HOME || homedir(), '.codex');

export const codexRolloutPath = ({ codexHome = codexHomeFor(), sessionId }) => {
  if (!sessionId) return null;
  const root = join(codexHome, 'sessions');
  const suffix = `-${sessionId}.jsonl`;
  for (const year of newestFirst(root)) {
    for (const month of newestFirst(join(root, year))) {
      for (const day of newestFirst(join(root, year, month))) {
        const name = newestFirst(join(root, year, month, day)).find((file) => file.endsWith(suffix));
        if (name) return join(root, year, month, day, name);
      }
    }
  }
  return null;
};

// The last request's prompt from codex's own `token_count` record. Its
// `input_tokens` already includes the cached part (`cached_input_tokens` is a
// subset), and `last_token_usage` is one request, where `total_token_usage` and
// the stream's `turn.completed` sum every request in the turn.
export const contextTokensFromCodexRollout = (text) => {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || !line.includes('token_count')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const input = record?.payload?.type === 'token_count'
      ? record.payload.info?.last_token_usage?.input_tokens : undefined;
    if (Number.isFinite(input)) return input;
  }
  return null;
};

export const codexContextTokens = ({ codexHome = codexHomeFor(), sessionId }) => {
  try {
    const file = codexRolloutPath({ codexHome, sessionId });
    return file ? contextTokensFromCodexRollout(readTail(file)) : null;
  } catch {
    return null;
  }
};

export const claudeContextTokens = ({ cwd, sessionId, configDir = claudeConfigDirFor() }) => {
  const file = claudeTranscriptPath({ cwd, sessionId, configDir });
  if (!file || !existsSync(file)) return null;
  try {
    return contextTokensFromTranscript(readTail(file));
  } catch {
    return null;
  }
};
