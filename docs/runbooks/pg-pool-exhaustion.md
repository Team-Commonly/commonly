# PostgreSQL pool exhaustion

Use this runbook when PostgreSQL-backed requests hang while Mongo-backed health
or read paths remain responsive.

## Diagnose

1. Check backend pod health and recent logs.
2. Compare a known Mongo-backed request with a PostgreSQL-backed request.
3. Read the pool counters without issuing a database query:

   ```bash
   kubectl exec -n commonly-dev deploy/backend -- \
     curl -sS http://127.0.0.1:5000/api/health/db
   ```

   The health response reports `max`, `total`, `idle`, `waiting`, and
   `connectionTimeoutMillis`. Saturation is the dangerous shape: waiters are
   present and idle connections are zero.
4. Inspect `kubectl top pod` and backend logs for a concurrent fan-out or a
   slow query. Do not increase the pool before checking the database and node
   connection limits.

The pool is configured in `backend/config/db-pg.ts`. It has a bounded acquire
timeout, so a full pool should fail with an actionable error rather than leave
Express handlers waiting forever.

## Immediate recovery

If the pool is wedged and the database is healthy, restart only the backend
deployment and watch it complete:

```bash
kubectl rollout restart deployment/backend -n commonly-dev
kubectl rollout status deployment/backend -n commonly-dev --timeout=120s
```

Re-run `/api/health/db`, then exercise the affected request with a bounded
client timeout. If the pool saturates again, stop restarting and capture the
fan-out, query, and connection counters for the owning code path.

## Prevention

- Keep scheduled fan-out bounded and chunked.
- Release clients and transactions on every success and error path.
- Keep query timeouts and pool acquire timeouts finite.
- Size the pool below the database's connection budget, leaving room for
  migrations and operator access.
- Alert on sustained `waiting > 0` with `idle === 0`, not on one transient
  waiter.

Validate pool changes with the backend service tests and a production-shaped
load test before rollout.
