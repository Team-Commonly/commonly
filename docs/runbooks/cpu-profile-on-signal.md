# Capture a CPU profile of the backend on a signal

When the backend burns CPU and the logs can't say why (a `[loop-lag]` stall, a
core pinned for seconds), take a CPU profile of the live process. Nothing is
run inside the serving container (see
[ops-runner-and-no-exec-into-backend.md](ops-runner-and-no-exec-into-backend.md)):
the backend profiles itself when it gets `SIGUSR2`, and only when a flag is on.
For a stall you can't time, see
[Catch a stall nobody can time](#catch-a-stall-nobody-can-time-loop_stall_profile1).

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

   Signal node's host PID directly. Read the PID just before signalling, since
   any recreate gives the container a new one:

   ```bash
   PID=$(docker inspect -f '{{.State.Pid}}' "$(docker compose ps -q backend)")
   [ "$PID" -gt 0 ] && sudo kill -USR2 "$PID"
   docker compose logs --since 2m backend | grep cpu-profile
   ```

   The check matters: an empty PID fails, and `kill -USR2 0` would signal
   your own shell's process group instead of the backend.

   **Why not `docker kill -s USR2`.** The Docker kill API marks the container
   as manually stopped for any signal, even one the process catches and keeps
   running through. Under `restart: unless-stopped`, a crash before the
   container's next start would then not be restarted, and the backend would
   stay down. A host `kill` doesn't go through that API, so the restart policy
   is untouched.

   **Why the flag-off signal is harmless.** This relies on node being PID 1 in
   its namespace with no init: `start.sh` ends with `exec node dist/server.js`,
   and compose sets no `init:`. Sent from the host, a signal other than
   SIGKILL or SIGSTOP reaches a namespace's init only if init has a handler
   for it. With the flag off there is no handler, so nothing happens; with it
   on, the handler gets the signal. If an init such as tini is ever added,
   node is no longer PID 1, and a SIGUSR2 sent with the flag off would be
   forwarded to it and end the process.

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
   The recreate also starts a fresh container, with a fresh restart state.

## Catch a stall nobody can time: `LOOP_STALL_PROFILE=1`

A signal only helps when you know when the stall comes. For stalls at
unpredictable times, the backend can profile itself all the time and keep only
the windows around a stall. Code: `backend/services/loopStallProfiler.ts`,
started next to the signal profiler in `backend/server.ts`.

**How it behaves.**

- **Off unless `LOOP_STALL_PROFILE=1`.** When off, it creates no inspector
  session, histogram or timer. It needs no signal, so it is safe in local dev.
- It profiles in rolling windows of `LOOP_STALL_PROFILE_WINDOW_S` seconds
  (default 60, clamped to 10–60), sampling every 10 ms. Its own loop-delay
  histogram is reset each window.
- At each window end, if the window's worst loop delay is at least
  `LOOP_STALL_PROFILE_THRESHOLD_MS` (default 1000, clamped to 100–60000), it
  writes that window and the one before it, so a stall across the boundary is
  still covered:
  `stall-<ISO timestamp, colons as dashes>-prev.cpuprofile` and
  `...-cur.cpuprofile` (only `-cur` if it was the first window). One log line:
  `[loop-stall-profile] saved <prev file> <cur file> max=4100ms`. A quiet
  window is discarded, except that it is held in memory as the next window's
  "previous".
- Files go to `LOOP_STALL_PROFILE_DIR` (default `<os.tmpdir()>/cpuprofiles`,
  `/tmp/cpuprofiles` in the image, the same dir as the signal profiler). The
  newest 6 `stall-*` files are kept; the `cpu-*` files are pruned separately.
- **It stops by itself** after `LOOP_STALL_PROFILE_MAX_SAVES` stalls saved
  (default 3, clamped to 1–20) or after `LOOP_STALL_PROFILE_HOURS` (default 24,
  clamped to 1–168), whichever comes first, and logs
  `[loop-stall-profile] stopped: ...` with the reason. Restart the container to
  run it again.
- Any inspector or write error logs `[loop-stall-profile] failed, profiler
  stopped` once and stops it. A failed prune only logs
  `[loop-stall-profile] pruning old profiles failed` and profiling goes on. It
  never throws into the process.
- **It runs alongside the signal profiler.** Each inspector session gets its
  own V8 CPU profiler with its own sampling interval, so a `SIGUSR2` capture
  during a stall window works and both files are complete (checked on Node 22
  and 26). You can leave both flags on.

**Overhead.** A 10 ms sampling interval is a tenth of the signal profiler's
default rate. The larger cost is the `Profiler.start` at each window: about
50–150 ms loop pause at the start of each window (V8 re-logs compiled code),
so one such pause a minute at the default; a shorter window means more of
them. The pause isn't counted as a stall: the histogram is reset in the same
tick. `Profiler.stop` also builds the window's profile on the loop, and only
a stall window pays for `JSON.stringify` and the file write. One extra profile
is held in memory between windows.

**Steps.** Add `LOOP_STALL_PROFILE=1` to `backend.env` and recreate the backend
as in step 1 above. Wait for a `saved` line
(`docker compose logs backend | grep loop-stall-profile`), then fetch and open
the files as in steps 3 and 4: the same `docker compose cp
backend:/tmp/cpuprofiles/. ./cpuprofiles/` copies both kinds. Fetch before any
recreate. Then remove the flag and recreate, as in step 5.
