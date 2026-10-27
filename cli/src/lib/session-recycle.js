/**
 * At-wake session recycle (TASK-440).
 *
 * A seat resumes its CLI session on every wake, so a long-lived seat drags a
 * large cold context into each turn. When a wake finds the seat idle long
 * enough that the prompt cache is cold AND the last session's context is big
 * enough to matter, start a fresh session instead, seeded with a short
 * restart note. Otherwise resume exactly as before.
 *
 * Thresholds are per-install: COMMONLY_SESSION_RECYCLE_IDLE_MINUTES and
 * COMMONLY_SESSION_RECYCLE_CONTEXT_TOKENS override the defaults below.
 *
 * Context size is read from the transcript the child CLI wrote, under the env
 * the child ran with. Only the claude adapter reports one today; an adapter
 * that reports nothing keeps resuming, as before this module existed.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const RECYCLE_DEFAULTS = Object.freeze({
  idleMinutes: 60,
  contextTokens: 128000,
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
});

// Pure decision. No evidence (no last turn, no measured context) means resume.
export const shouldStartFreshSession = ({
  lastTurn,
  contextTokens,
  now = Date.now(),
  thresholds = RECYCLE_DEFAULTS,
}) => {
  if (!lastTurn || !Number.isFinite(contextTokens)) return false;
  const last = Date.parse(lastTurn);
  if (!Number.isFinite(last)) return false;
  const idleMs = now - last;
  return idleMs >= thresholds.idleMinutes * 60_000
    && contextTokens >= thresholds.contextTokens;
};

export const idleMinutesSince = (lastTurn, now = Date.now()) => {
  const last = Date.parse(lastTurn);
  return Number.isFinite(last) ? Math.floor((now - last) / 60_000) : null;
};

// The restart note. The memory head and the pod focus are NOT repeated here:
// a fresh claude session already receives the full long_term memory through
// its preamble, and the pod focus is already in the wake prompt.
export const buildRecycleBriefing = ({ agentName, idleMinutes, contextTokens }) => [
  '=== Session restart ===',
  `This wake starts a fresh session. The previous session was idle ${idleMinutes} min`
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

export const claudeContextTokens = ({ cwd, sessionId, configDir = claudeConfigDirFor() }) => {
  const file = claudeTranscriptPath({ cwd, sessionId, configDir });
  if (!file || !existsSync(file)) return null;
  try {
    return contextTokensFromTranscript(readTail(file));
  } catch {
    return null;
  }
};
