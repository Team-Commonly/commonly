import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, resolve as pathResolve } from 'node:path';

/**
 * ADR-026 Phase 2, slice 2: the resident supervision loop behind
 * `commonly daemon run`.
 *
 * The server's work list (GET /api/agent-binding/assigned) is the source of
 * truth (D2): a row `requested` gets adopted (the D3 CAS — the server refuses
 * the loser of a race cleanly), a row `bound` gets provisioned (token file)
 * and supervised (a `commonly agent run <name>` child), and a supervised
 * agent that leaves the list gets stopped. Per-agent state rides every
 * machine heartbeat (D5).
 *
 * D6 discipline: a replacement child is only ever scheduled from the previous
 * child's 'exit' event — there is no code path that spawns a second runner
 * for an agent whose child has not exited.
 *
 * All side effects (client, spawn, token file I/O, adapter detection, timers)
 * are injected so the loop's decisions are testable without processes.
 */

export const DEFAULT_POLL_MS = 30_000;
export const DEFAULT_HEARTBEAT_MS = 30_000;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;

const workspacePathFor = (environment) => {
  const declared = environment?.workspace?.path;
  if (typeof declared !== 'string' || !declared.trim()) return null;
  const expanded = declared === '~'
    ? homedir()
    : (declared.startsWith('~/') ? `${homedir()}/${declared.slice(2)}` : declared);
  return isAbsolute(expanded) ? expanded : pathResolve(expanded);
};

export const backoffMs = (restarts) => Math.min(
  BACKOFF_MAX_MS,
  BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(restarts, 10)),
);

const identityKey = (agentName, instanceId) => `${agentName} ${instanceId || 'default'}`;

export const createDaemonSupervisor = ({
  record,
  client,
  spawnChild, // (agentName) => child emitting 'exit'; must expose .kill()
  loadToken, // (agentName) => token record | null
  saveToken, // (agentName, record) => void
  resolveAdapter, // async (runtime) => adapter name for THIS machine
  log = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  // key → { agentName, instanceId, child, state, restarts, backoffTimer, desired }
  const seats = new Map();
  let stopped = false;

  const agentStates = () => Array.from(seats.values()).map((s) => ({
    agentName: s.agentName,
    instanceId: s.instanceId,
    state: s.state,
    restarts: s.restarts,
  }));

  const startChild = (seat) => {
    if (stopped || !seat.desired || seat.child) return;
    seat.child = spawnChild(seat.agentName);
    seat.state = 'running';
    log(`[${seat.agentName}] supervising (restarts so far: ${seat.restarts})`);
    seat.child.on('exit', (code) => {
      seat.child = null;
      if (stopped || !seat.desired) {
        seat.state = 'stopped';
        return;
      }
      seat.state = code === 0 ? 'stopped' : 'crashed';
      seat.restarts += 1;
      const delay = backoffMs(seat.restarts - 1);
      log(`[${seat.agentName}] exited (code ${code}) — respawn in ${Math.round(delay / 1000)}s`);
      seat.backoffTimer = setTimeoutFn(() => {
        seat.backoffTimer = null;
        startChild(seat);
      }, delay);
    });
  };

  const stopSeat = (seat) => {
    seat.desired = false;
    if (seat.backoffTimer) {
      clearTimeoutFn(seat.backoffTimer);
      seat.backoffTimer = null;
    }
    if (seat.child) {
      log(`[${seat.agentName}] no longer assigned here — stopping`);
      seat.child.kill('SIGTERM');
    } else {
      seat.state = 'stopped';
    }
  };

  // Preserve the complete ADR-008 environment when the daemon receives it.
  // Older installs only expose runtime.model/effort; those fields are a
  // compatibility overlay and must merge into an existing local environment
  // rather than erasing its workspace, skills, or MCP declarations.
  const environmentFor = (row) => {
    const declared = row.environment && typeof row.environment === 'object'
      && !Array.isArray(row.environment) ? { ...row.environment } : null;
    const runtime = row.runtime && typeof row.runtime === 'object' ? row.runtime : {};
    if (declared) {
      if (runtime.model && declared.model === undefined) declared.model = String(runtime.model);
      if (runtime.effort && declared.effort === undefined) declared.effort = String(runtime.effort);
      return { value: declared, declared: true };
    }
    const fallback = {};
    if (runtime.model) fallback.model = String(runtime.model);
    if (runtime.effort) fallback.effort = String(runtime.effort);
    return Object.keys(fallback).length ? { value: fallback, declared: false } : null;
  };

  // Ensure ~/.commonly/tokens/<name>.json exists so `agent run` can boot.
  // The mint refuses to clobber an existing token (409 token_exists); the
  // binding to THIS machine is the owner's explicit takeover choice (D3), so
  // that refusal is answered with rotate:true — loudly.
  // Returns 'ready' | 'changed' (record updated — the seat must restart to
  // load it) | false.
  const ensureToken = async (row) => {
    const existing = loadToken(row.agentName);
    if (existing) {
      // A model changed in the UI reaches the seat here: update the record,
      // and let the caller restart the child (`agent run` reads its record
      // once at boot). A row with NO declared model leaves the record alone —
      // never strip an operator's hand-set environment.
      const wanted = environmentFor(row);
      const declaredAdapter = row.runtime && typeof row.runtime === 'object'
        && typeof row.runtime.adapter === 'string'
        ? row.runtime.adapter.trim().toLowerCase()
        : null;
      let adapterChanged = false;
      let nextAdapter = existing.adapter;
      if (declaredAdapter) {
        const detectedAdapter = await resolveAdapter(row.runtime || null);
        // resolveAdapterForRuntime historically probes fallbacks when a
        // declared adapter is absent. A configuration edit must never accept
        // that fallback: it would report claude while running codex (or vice
        // versa). Keep the existing child/token untouched until the exact
        // requested adapter is detected locally.
        if (detectedAdapter !== declaredAdapter) {
          log(`[${row.agentName}] requested adapter '${declaredAdapter}' is not available on this machine — keeping the current seat`);
          return false;
        }
        nextAdapter = declaredAdapter;
        adapterChanged = existing.adapter !== nextAdapter;
      }
      if (wanted) {
        const nextEnvironment = wanted.declared
          ? wanted.value
          : { ...(existing.environment || {}), ...wanted.value };
        const workspacePath = workspacePathFor(nextEnvironment);
        const nextRecord = {
          ...existing,
          ...(adapterChanged ? { adapter: nextAdapter } : {}),
          environment: nextEnvironment,
          ...(workspacePath ? { workspacePath } : {}),
        };
        if (adapterChanged
          || !isDeepStrictEqual(existing.environment || null, nextEnvironment)
          || (workspacePath && existing.workspacePath !== workspacePath)) {
          saveToken(row.agentName, nextRecord);
          log('runtime config changed — restarting the seat to load it');
          return 'changed';
        }
      }
      if (adapterChanged) {
        saveToken(row.agentName, { ...existing, adapter: nextAdapter });
        log('runtime adapter changed — restarting the seat to load it');
        return 'changed';
      }
      return 'ready';
    }
    const requestedAdapter = row.runtime && typeof row.runtime === 'object'
      && typeof row.runtime.adapter === 'string'
      ? row.runtime.adapter.trim().toLowerCase()
      : null;
    let adapter = null;
    if (requestedAdapter) {
      adapter = await resolveAdapter(row.runtime || null);
      if (adapter !== requestedAdapter) {
        log(`[${row.agentName}] requested adapter '${requestedAdapter}' is not available on this machine — skipping token mint`);
        return false;
      }
    }
    const body = { agentName: row.agentName, instanceId: row.instanceId };
    let minted;
    try {
      minted = await client.post('/api/agent-binding/runtime-token', body);
    } catch (error) {
      if (error?.status === 409 && error?.body?.code === 'token_exists') {
        log(`[${row.agentName}] a runtime token exists elsewhere — rotating it to this machine (the old token stops working)`);
        try {
          minted = await client.post('/api/agent-binding/runtime-token', { ...body, rotate: true });
        } catch (rotateError) {
          log(`[${row.agentName}] token rotation failed: ${rotateError.message}`);
          return false;
        }
      } else {
        log(`[${row.agentName}] token mint failed: ${error.message}`);
        return false;
      }
    }
    if (!minted?.token) {
      log(`[${row.agentName}] mint returned no token — skipping`);
      return false;
    }
    if (!adapter) adapter = await resolveAdapter(row.runtime || null);
    if (!adapter) {
      log(`[${row.agentName}] no usable CLI adapter on this machine — install claude or codex, or attach manually`);
      return false;
    }
    const environment = environmentFor(row);
    saveToken(row.agentName, {
      agentName: row.agentName,
      instanceId: row.instanceId,
      runtimeToken: minted.token,
      instanceUrl: record.instanceUrl,
      podId: row.podIds?.[0] || null,
      adapter,
      ...(environment ? { environment: environment.value } : {}),
      ...(environment?.value ? (() => {
        const workspacePath = workspacePathFor(environment.value);
        return workspacePath ? { workspacePath } : {};
      })() : {}),
    });
    log(`[${row.agentName}] provisioned runtime token (adapter: ${adapter}${environment?.value?.model ? `, model: ${environment.value.model}` : ''})`);
    return 'ready';
  };

  const tick = async () => {
    if (stopped) return;
    let assigned;
    try {
      assigned = await client.get('/api/agent-binding/assigned');
    } catch (error) {
      log(`work-list fetch failed: ${error.message}`);
      return;
    }
    const rows = Array.isArray(assigned?.agents) ? assigned.agents : [];

    const bound = [];
    for (const row of rows) {
      if (row.state === 'requested') {
        try {
          // eslint-disable-next-line no-await-in-loop
          await client.post('/api/agent-binding/adopt', {
            agentName: row.agentName, instanceId: row.instanceId,
          });
          log(`[${row.agentName}] adopted onto this machine`);
          bound.push(row);
        } catch (error) {
          // A clean CAS refusal (409) means another machine won — drop it.
          log(`[${row.agentName}] adopt refused: ${error.message}`);
        }
      } else {
        bound.push(row);
      }
    }

    const desiredKeys = new Set();
    for (const row of bound) {
      const key = identityKey(row.agentName, row.instanceId);
      desiredKeys.add(key);
      let seat = seats.get(key);
      if (!seat) {
        seat = {
          agentName: row.agentName,
          instanceId: row.instanceId || 'default',
          child: null,
          state: 'stopped',
          restarts: 0,
          backoffTimer: null,
          desired: true,
        };
        seats.set(key, seat);
      }
      seat.desired = true;
      // eslint-disable-next-line no-await-in-loop
      const ready = await ensureToken(row);
      if (ready === 'changed' && seat.child) {
        // desired stays true, so the exit handler respawns with the updated
        // record — the restart path IS the D6 path, no second spawner.
        seat.child.kill('SIGTERM');
      } else if (ready && !seat.child && !seat.backoffTimer) {
        startChild(seat);
      }
    }

    for (const [key, seat] of seats) {
      if (!desiredKeys.has(key) && seat.desired) stopSeat(seat);
    }
  };

  const heartbeat = async () => {
    if (stopped) return;
    try {
      await client.post(`/api/machines/${record.machineDbId}/heartbeat`, { agents: agentStates() });
    } catch (error) {
      log(`heartbeat failed: ${error.message}`);
    }
  };

  const stop = () => {
    stopped = true;
    for (const seat of seats.values()) stopSeat(seat);
  };

  return {
    tick, heartbeat, stop, agentStates,
  };
};
