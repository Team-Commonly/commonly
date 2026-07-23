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
 *
 * Handled runtime-event IDs are intentionally persisted in a separate
 * `<agent>.events.json` file. Keeping the bounded event ring separate means
 * session-map readers retain their existing on-disk shape while a wrapper
 * restart can still suppress a re-delivered event whose ack previously failed.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const sessionsDir = () => join(homedir(), '.commonly', 'sessions');
const sessionsFile = (agentName) => join(sessionsDir(), `${agentName}.json`);
const handledEventsFile = (agentName) => join(sessionsDir(), `${agentName}.events.json`);
const MAX_HANDLED_EVENTS = 500;
const handledEventsCache = new Map();

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

const readHandledEvents = (agentName) => {
  const file = handledEventsFile(agentName);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((eventId) => typeof eventId === 'string' && eventId.length > 0)
      .slice(-MAX_HANDLED_EVENTS);
  } catch {
    return [];
  }
};

const getHandledEvents = (agentName) => {
  const file = handledEventsFile(agentName);
  // Tests, detach, or an operator may remove the file while this process is
  // alive. Reset the mirror rather than retaining IDs that no longer exist on
  // disk; a fresh process likewise hydrates from the persisted ring.
  if (!existsSync(file)) {
    const empty = { ids: [], set: new Set() };
    handledEventsCache.set(agentName, empty);
    return empty;
  }
  if (!handledEventsCache.has(agentName)) {
    const ids = readHandledEvents(agentName);
    handledEventsCache.set(agentName, { ids, set: new Set(ids) });
  }
  return handledEventsCache.get(agentName);
};

const writeHandledEvents = (agentName, ids) => {
  if (!existsSync(sessionsDir())) mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(handledEventsFile(agentName), JSON.stringify(ids, null, 2), 'utf8');
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

export const wasEventHandled = (agentName, eventId) => {
  if (!agentName || !eventId) return false;
  return getHandledEvents(agentName).set.has(String(eventId));
};

export const recordHandledEvent = (agentName, eventId) => {
  if (!agentName || !eventId) return;
  const normalizedId = String(eventId);
  const current = getHandledEvents(agentName);
  if (current.set.has(normalizedId)) return;

  const ids = [...current.ids, normalizedId].slice(-MAX_HANDLED_EVENTS);
  writeHandledEvents(agentName, ids);
  handledEventsCache.set(agentName, { ids, set: new Set(ids) });
};

export const clearSessions = (agentName) => {
  const file = sessionsFile(agentName);
  if (existsSync(file)) rmSync(file);
  const eventsFile = handledEventsFile(agentName);
  if (existsSync(eventsFile)) rmSync(eventsFile);
  handledEventsCache.delete(agentName);
};
