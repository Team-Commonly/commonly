# PG connection pool exhaustion — diagnosis + recovery

**Symptom**: User-facing PG-backed endpoints (`/api/pods`, `/api/messages/:podId`) hang indefinitely. UI shows perpetual loading. Backend CPU + memory normal. Other endpoints (mongo-backed: `/api/posts`, `/api/auth/me`) respond fast.

## Diagnosis flow

1. **Confirm reachability** — probe a mongo-backed endpoint from inside the cluster. If it responds, the backend is up and only PG-backed paths are affected.

   ```bash
   TOKEN=<admin jwt>
   kubectl exec -n commonly-dev deploy/backend -- bash -c \
     "curl -sS -m 5 -H 'Authorization: Bearer $TOKEN' \
      'http://localhost:5000/api/posts?limit=2' \
      -w 'status=%{http_code} ttfb=%{time_starttransfer}s\n' -o /dev/null"
   # Expected: status=200 ttfb<200ms
   ```

2. **Confirm PG-backed paths hang** — same probe against `/api/pods?limit=2`. If it returns `status=000 ttfb=0` (timeout, 0 bytes), the controller never completed.

3. **Rule out resource pressure** — `kubectl top pod -n commonly-dev <backend-pod>`. If CPU < 50% of limit and memory < 75% of limit, the hang is NOT load-related.

4. **Rule out underlying DB slowness** — run the underlying queries directly from a one-off node process. If they return in well under a second, the DB is fine and the live pool is the bottleneck.

   ```bash
   kubectl exec -n commonly-dev deploy/backend -- node -e "
     const { pool } = require('./dist/config/db-pg');
     (async () => {
       const t0 = Date.now();
       const r = await pool.query('SELECT 1');
       console.log('elapsed ms:', Date.now() - t0);
       process.exit(0);
     })();
   "
   ```

5. **Inspect logs for the surge trigger** — `kubectl logs deploy/backend --tail=200`. Look for:
   - `Pod summary requests enqueued: <N>` — the hourly summarizer fanout. N=60 has been observed to saturate a 10-slot pool.
   - `Dispatching agent heartbeat events...` repeated rapidly — heartbeat dispatcher cycling.

## Immediate recovery

```bash
kubectl rollout restart deploy/backend -n commonly-dev
kubectl rollout status deploy/backend -n commonly-dev --timeout=120s
```

~20s downtime. Frees all PG connections instantly. Re-probe `/api/pods` should return in <1s.

## Why this happens

`pg.Pool` defaults are `max=10` and `connectionTimeoutMillis=0` (wait forever). On any traffic surge — most commonly the hourly summarizer fanning out N events that each query PG — the 10 slots saturate and every subsequent `pool.query()` waits forever on connection acquire. UI shows perpetual loading with no diagnostic signal because Express never times out the awaiting handler.

## Structural fix

Applied 2026-05-26 in PR #455 (`backend/config/db-pg.ts`):

- `max: 50` (default; tunable via `PG_POOL_MAX`).
- `connectionTimeoutMillis: 5000` (default; tunable via `PG_POOL_CONNECT_TIMEOUT_MS`).

With this, an exhausted pool fails fast as a 5xx instead of hanging — user sees an error, on-call sees an alert, response is actionable.

## Follow-ups shipped in #459 (2026-05-31)

Both items below were "still TODO" after #455; PR #459 shipped them:

- **Summarizer fanout chunked** — `SchedulerService.dispatchPodSummaryRequests` now enqueues in batches of `SUMMARIZER_FANOUT_BATCH_SIZE` (default 10) with a `SUMMARIZER_FANOUT_BATCH_PAUSE_MS` gap (default 500ms) between batches, instead of a bare `Promise.all` over all installations. For 60 pods that spreads the burst across ~3s so the consumer side never claims all pool slots at once.
- **`/api/health/db` probe added** — returns `{ pg: { max, total, idle, waiting, connectionTimeoutMillis } }` with NO `SELECT` round-trip (safe to scrape every 10s). Returns **503 only when `waiting > 0 AND idle === 0`** (true saturation); transient `waiting > 0 / idle > 0` returns 200 to avoid alert noise. Code: `backend/routes/health.ts`.

Probe it:

```bash
kubectl exec -n commonly-dev deploy/backend -- curl -sS http://localhost:5000/api/health/db
# → {"pg":{"status":"ok","max":50,"total":N,"idle":N,"waiting":0,...}}
```

## Related

- Incident issue: [#454](https://github.com/Team-Commonly/commonly/issues/454)
- Fix PRs: [#455](https://github.com/Team-Commonly/commonly/pull/455) (pool ceiling), [#459](https://github.com/Team-Commonly/commonly/pull/459) (fanout chunk + health probe)
- Code: `backend/config/db-pg.ts` (pool config), `backend/controllers/podController.ts:199-227` (getAllPods PG call site), `backend/services/schedulerService.ts` (`dispatchPodSummaryRequests` — the chunked surge source), `backend/routes/health.ts` (`/api/health/db`)
