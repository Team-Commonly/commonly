import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  RECYCLE_DEFAULTS,
  buildRecycleBriefing,
  claudeConfigDirFor,
  claudeContextTokens,
  claudeTranscriptPath,
  contextTokensFromTranscript,
  idleMinutesSince,
  recycleThresholds,
  shouldStartFreshSession,
} from '../src/lib/session-recycle.js';
import { getSessionEntry, setSession } from '../src/lib/session-store.js';

const NOW = Date.parse('2026-10-24T04:00:00.000Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const assistantLine = (usage) => JSON.stringify({
  type: 'assistant',
  message: { usage },
});

describe('shouldStartFreshSession', () => {
  test('idle at the threshold and context at the threshold starts fresh', () => {
    expect(shouldStartFreshSession({
      lastTurn: minutesAgo(60),
      contextTokens: 128000,
      now: NOW,
    })).toBe(true);
  });

  test('a recent turn resumes even with a large context', () => {
    expect(shouldStartFreshSession({
      lastTurn: minutesAgo(5),
      contextTokens: 400000,
      now: NOW,
    })).toBe(false);
  });

  test('an idle seat with a small context resumes', () => {
    expect(shouldStartFreshSession({
      lastTurn: minutesAgo(600),
      contextTokens: 20000,
      now: NOW,
    })).toBe(false);
  });

  test('no measured context means resume, never recycle blind', () => {
    expect(shouldStartFreshSession({
      lastTurn: minutesAgo(600),
      contextTokens: null,
      now: NOW,
    })).toBe(false);
  });

  test('no last turn means resume', () => {
    expect(shouldStartFreshSession({
      lastTurn: undefined,
      contextTokens: 500000,
      now: NOW,
    })).toBe(false);
  });

  test('thresholds are configurable per install', () => {
    const thresholds = { idleMinutes: 10, contextTokens: 1000 };
    expect(shouldStartFreshSession({
      lastTurn: minutesAgo(10),
      contextTokens: 1000,
      now: NOW,
      thresholds,
    })).toBe(true);
  });
});

describe('recycleThresholds', () => {
  test('defaults match the ruling', () => {
    expect(recycleThresholds({})).toEqual(RECYCLE_DEFAULTS);
    expect(RECYCLE_DEFAULTS).toEqual({ idleMinutes: 60, contextTokens: 128000 });
  });

  test('environment overrides apply; invalid values fall back to the default', () => {
    expect(recycleThresholds({
      COMMONLY_SESSION_RECYCLE_IDLE_MINUTES: '15',
      COMMONLY_SESSION_RECYCLE_CONTEXT_TOKENS: '64000',
    })).toEqual({ idleMinutes: 15, contextTokens: 64000 });
    expect(recycleThresholds({
      COMMONLY_SESSION_RECYCLE_IDLE_MINUTES: '-3',
      COMMONLY_SESSION_RECYCLE_CONTEXT_TOKENS: 'lots',
    })).toEqual(RECYCLE_DEFAULTS);
  });
});

describe('idleMinutesSince', () => {
  test('whole minutes since the last turn', () => {
    expect(idleMinutesSince(minutesAgo(61.5), NOW)).toBe(61);
  });

  test('an unparseable turn time is null', () => {
    expect(idleMinutesSince('not a date', NOW)).toBeNull();
  });
});

describe('buildRecycleBriefing', () => {
  test('names the restart, the idle time, the context size and the role', () => {
    const text = buildRecycleBriefing({
      agentName: 'nova', idleMinutes: 75, contextTokens: 140000,
    });
    expect(text).toContain('=== Session restart ===');
    expect(text).toContain('idle 75 min');
    expect(text).toContain('about 140000 context tokens');
    expect(text).toContain('Role: nova.');
  });
});

describe('claudeTranscriptPath', () => {
  test('encodes every non-alphanumeric character of the cwd as a dash', () => {
    expect(claudeTranscriptPath({
      cwd: '/Users/x/agents/nova.work',
      sessionId: 'abc',
      configDir: '/cfg',
    })).toBe('/cfg/projects/-Users-x-agents-nova-work/abc.jsonl');
  });

  test('no cwd or no session means no path', () => {
    expect(claudeTranscriptPath({ cwd: null, sessionId: 'abc', configDir: '/cfg' })).toBeNull();
    expect(claudeTranscriptPath({ cwd: '/x', sessionId: null, configDir: '/cfg' })).toBeNull();
  });
});

describe('contextTokensFromTranscript', () => {
  test('uses the last assistant turn: input plus both cache counts', () => {
    const text = [
      assistantLine({ input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 100 }),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistantLine({ input_tokens: 2, cache_creation_input_tokens: 2939, cache_read_input_tokens: 354133 }),
      '',
    ].join('\n');
    expect(contextTokensFromTranscript(text)).toBe(2 + 2939 + 354133);
  });

  test('a cut first line and malformed lines are skipped', () => {
    const text = [
      '{"type":"assis',
      'not json',
      assistantLine({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 9 }),
    ].join('\n');
    expect(contextTokensFromTranscript(text)).toBe(10);
  });

  test('a transcript with no assistant usage is unknown', () => {
    expect(contextTokensFromTranscript(JSON.stringify({ type: 'user' }))).toBeNull();
  });
});

describe('claudeContextTokens', () => {
  let configDir;
  let cwd;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'recycle-cfg-'));
    cwd = '/work/agent-one';
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test('reads the transcript for the session in the encoded cwd folder', () => {
    const dir = join(configDir, 'projects', '-work-agent-one');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess-1.jsonl'), assistantLine({
      input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3,
    }));
    expect(claudeContextTokens({ cwd, sessionId: 'sess-1', configDir })).toBe(6);
  });

  test('a missing transcript is unknown, so the seat resumes as before', () => {
    expect(claudeContextTokens({ cwd, sessionId: 'nope', configDir })).toBeNull();
  });
});

describe('session store contextTokens', () => {
  const agent = `recycle-test-${process.pid}-${Date.now()}`;
  const pod = 'pod-recycle';
  afterEach(() => {
    rmSync(join(process.env.HOME, '.commonly', 'sessions', `${agent}.json`), { force: true });
  });

  test('setSession stores contextTokens and getSessionEntry returns it', () => {
    setSession(agent, pod, 'sid-9', { contextTokens: 150000 });
    const entry = getSessionEntry(agent, pod);
    expect(entry.sessionId).toBe('sid-9');
    expect(entry.contextTokens).toBe(150000);
    expect(typeof entry.lastTurn).toBe('string');
  });

  test('setSession without contextTokens stores none', () => {
    setSession(agent, pod, 'sid-10');
    expect(getSessionEntry(agent, pod)).not.toHaveProperty('contextTokens');
  });
});

describe('claudeConfigDirFor', () => {
  test('an explicit CLAUDE_CONFIG_DIR wins', () => {
    expect(claudeConfigDirFor({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/x' })).toBe('/cfg');
  });

  test('otherwise the child HOME, so a public seat looks in its own state', () => {
    expect(claudeConfigDirFor({ HOME: '/state/public-1' })).toBe('/state/public-1/.claude');
  });
});
