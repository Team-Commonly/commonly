# Capture a CPU profile of the backend on a signal

When the backend burns CPU and the logs can't say why (a `[loop-lag]` stall, a
core pinned for seconds), take a CPU profile of the live process. Nothing is
run inside the serving container (see
[ops-runner-and-no-exec-into-backend.md](ops-runner-and-no-exec-into-backend.md)):
the backend profiles itself when it gets `SIGUSR2`, and only when a flag is on.

Code: `backend/services/cpuProfileOnSignal.ts`, started next to the loop-lag
monitor in `backend/server.ts`.

## How it behaves

- **Off unless `CPU_PROFILE_ON_SIGNAL=1`.** When off, no handler is registered.
  Keep it off in local dev: nodemon restarts the dev server by sending
  `SIGUSR2` and waiting for it to exit, and the handler would swallow that.
- `SIGUSR2` starts one capture. A signal during a capture is logged and ignored.
  `SIGUSR1` (Node's inspector) is never touched.
- A capture lasts `CPU_PROFILE_SECONDS` (default 30, clamped to 5–60), then
  writes `cpu-<ISO timestamp, colons as dashes>.cpuprofile` to `CPU_PROFILE_DIR`
  (default `<os.tmpdir()>/cpuprofiles`, which is `/tmp/cpuprofiles` in the
  image). The newest 5 files are kept.
- Two log lines per capture:
  `[cpu-profile] started, 30s, writing to /tmp/cpuprofiles` and
  `[cpu-profile] wrote <path> (<bytes> bytes, 30s)`. A failure logs
  `[cpu-profile] capture failed` and the next signal works again.
- Profiling costs some CPU while it runs. The file write is async, but turning
  the profile into JSON takes a moment on the loop at the end of a capture.

## Which backend

Signal the `backend` service. In `deploy/vm/docker-compose.yml` it is the one
that runs the worker, the scheduler included, so the stalls on regular minutes
happen there. It runs the worker because `RUN_WORKER` is left unset on it (the
worker starts unless `RUN_WORKER=0`, `backend/services/backgroundWorkerStart.ts`).
The web-only second backend, `backend-2` under the `two-workers` profile, sets
`RUN_WORKER=0`.

`backend-2` reads the same `backend.env`, so it picks the flag up on its next
recreate. That is harmless, since the flag only adds the listener. But when you
turn the flag off, recreate both if both run.

## Steps

Run these from the compose directory on the host.

1. **Enable the flag.** Add `CPU_PROFILE_ON_SIGNAL=1` and
   `CPU_PROFILE_SECONDS=45` to `backend.env`, then recreate the container so it
   reads them. This restarts the backend:

   ```bash
   docker compose up -d backend
   docker compose logs backend | grep 'Server running'
   ```

2. **Trigger it** just before the moment you want covered. To catch a stall at
   minute :x4 (:04, :14, :24), signal at about :x3:50, so a 45 s capture spans
   it:

   ```bash
   docker compose kill -s USR2 backend
   docker compose logs --since 2m backend | grep cpu-profile
   ```

   This relies on node being PID 1 with no init: `start.sh` ends with
   `exec node dist/server.js`, and compose sets no `init:`. A PID 1 process
   ignores signals it has no handler for, so with the flag off this signal does
   nothing. If an init such as tini is ever added, a SIGUSR2 sent with the flag
   off would be forwarded to node and end the process.

3. **Fetch the files** after the `wrote` line appears:

   ```bash
   docker compose cp backend:/tmp/cpuprofiles/. ./cpuprofiles/
   ```

   The trailing `/.` copies the files themselves, without nesting a
   `cpuprofiles` folder inside `./cpuprofiles/`. Outside compose, the same works
   as `docker cp <backend-container>:/tmp/cpuprofiles/. ./cpuprofiles/`.

   The files live in the container's writable layer, so they are lost when the
   container is recreated. Fetch them before step 5.

4. **Open it.** Chrome DevTools > Performance > Load profile, or drag the file
   onto [speedscope.app](https://www.speedscope.app/) (left heavy view shows
   where the time went). The file holds function names and source paths, not
   request data, but treat it as internal: don't attach it anywhere public.

5. **Turn the flag off.** Remove both lines from `backend.env` and recreate
   every backend that runs: `docker compose up -d backend`, and under
   `two-workers` also `docker compose --profile two-workers up -d backend-2`.
