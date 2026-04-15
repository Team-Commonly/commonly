/**
 * Session store — per-(agent, pod) session IDs at ~/.commonly/sessions/<agent>.json.
 *
 * Used by the local-CLI wrapper driver (ADR-005). Wrapped CLIs that support
 * conversation session IDs (claude --session-id, codex --session, …) call
 * getSession / setSession around each spawn so the next turn continues where
 * the previous one left off.
 *
 * One file per agent so two `commonly agent run` processes for different
 * agents never race on the same file (ADR-005 §Spawning semantics permits
 * parallel agents). Shape on disk:
 *   {
 *     "<podId>": { "sessionId": "abc123", "lastTurn": "2026-04-14T18:00:00Z" }
 *   }
 *
 * CLIs without sessions simply never call setSession — getSession returns null.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const sessionsDir = () => join(homedir(), '.commonly', 'sessions');
const sessionsFile = (agentName) => join(sessionsDir(), `${agentName}.json`);

const readAgent = (agentName) => {
  const file = sessionsFile(agentName);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

const writeAgent = (agentName, state) => {
  if (!existsSync(sessionsDir())) mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(sessionsFile(agentName), JSON.stringify(state, null, 2), 'utf8');
};

export const getSession = (agentName, podId) => {
  if (!agentName || !podId) return null;
  return readAgent(agentName)[podId]?.sessionId || null;
};

export const setSession = (agentName, podId, sessionId) => {
  if (!agentName || !podId) return;
  const state = readAgent(agentName);
  state[podId] = { sessionId, lastTurn: new Date().toISOString() };
  writeAgent(agentName, state);
};

export const clearSessions = (agentName) => {
  const file = sessionsFile(agentName);
  if (existsSync(file)) rmSync(file);
};
