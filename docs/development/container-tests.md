# Disposable local test runs (D66 / TASK-507)

CI remains the merge gate. This command runs tests in **pulled** CI-compatible
images; it never builds application images. Do not substitute a deploy build.

```sh
npm run test:container -- backend
npm run test:container -- cli
npm run test:container -- frontend
npm run test:container -- backend/__tests__/unit/routes/grants.test.js
npm run test:container -- service
# A backend/__tests__/service/*.test.js path also starts the real databases.
```

One suite or one repository-relative Jest file is accepted. `service` runs the
backend service tier with real Mongo and Postgres. Other suites use their usual
CI Jest setup. Tests run serially, without coverage or watch mode. The exit code
is the suite's code (including nonzero); setup/cleanup failures return 1.

## SRE policy: required before execution

SRE owns the limits and the **host-global** lock path. The runner reads
`~/.commonly/test-container-policy.json`, or the file named by
`COMMONLY_TEST_CONTAINER_POLICY`. A missing/invalid policy refuses execution;
there are no guessed resource defaults. SRE must confirm the Docker VM limits
are live before the first run. A written Docker Desktop setting that has not
been activated by a restart is not that confirmation.

The policy is JSON with these required fields:

| Field | Meaning |
|---|---|
| `lockPath` | Absolute, shared by all seats/worktrees on this host |
| `nodeMemory`, `serviceMemory` | Docker memory caps, e.g. a positive `m`/`g` size; memory-swap equals memory |
| `cpus`, `serviceCpus` | CPU caps for the test process and each DB |
| `workTmpfs` | Whole writable checkout and dependency tree cap |
| `tempTmpfs`, `homeTmpfs` | Temporary/Jest files and npm/home cache caps |
| `serviceTmpfs` | Each DB data directory cap |
| `logMaxSize`, `logMaxFiles` | Explicit json-file rotation limits |

The SRE task note fixes Node memory at **4g**, logs at **10m × 3**, and an atomic
mkdir lock under the operator's Commonly state directory. CPU/tmpfs/DB values
must also come from SRE; a caller must not widen them to make a test pass.
Policy is host configuration, not committed credentials or a repo-local lock.

## What stays off the host

- Source is bind mounted at `/source` **read-only**. A git-listed snapshot,
  including unignored new files, is copied to `/work` tmpfs; tests may mutate
  that disposable copy. Ignored host `node_modules`, `.git`, `.dev`, build and
  coverage directories are excluded. No host dependency installation occurs.
- Dependencies are installed fresh in `/work`; home/cache are tmpfs at
  `/home/test`, and temp/Jest output is tmpfs under `/tmp`. No persistent
  volumes, Docker socket, host HOME or production environment is mounted.
- Root filesystems are read-only. DB data directories are tmpfs. Container
  memory, CPU, process count and Docker log rotation limits are passed explicitly.
- All containers use `--rm`, `--pull=never` after a successful explicit pull,
  and `commonly.test=1`. They run the inspected image ID from that pull. The
  Node major and DB tags come from `.github/workflows/tests.yml`; conflicting
  declarations fail closed. At introduction these are Node 22, Postgres 16,
  Mongo 7, matching CI. No `docker build` path exists.
- Real DBs share a per-run network with the test container and publish no host
  ports. Dependency/binary downloads still need outbound network access.

The writable byte ceiling is the sum of the configured tmpfs sizes; those pages
also consume container memory. A full tmpfs/oom is a failed run, not permission
to use host storage. Docker image downloads live in Docker's image store and are
bounded operationally by SRE's Docker VM disk cap/pruning. stdout is streamed;
Docker's stored container logs are rotated at the policy cap.

## Lock and cleanup

The runner waits on the atomic mkdir lock, recording its PID. It never takes
over from a live PID. A dead owner permits recovery only after its PID-labelled
containers and networks have been removed. Signals and normal exit remove the
current run's resources before releasing the lock. A cleanup error retains the
lock. A partial lock without a PID, or an abandoned recovery mutex beside it,
needs SRE inspection; do not delete a lock based on age alone.

No VM restart, global prune, unrelated container stop or host temp cleanup is
performed by the runner. Docker Desktop must already be running.

## Verification of the runner

The single-file Jest regression is:

```sh
npm run test:container -- cli/__tests__/container-test-runner.test.mjs
```

It uses fake Docker/git executables inside the test container to exercise exit
propagation, pull failure, private service orchestration, limits, and cleanup
failure without launching nested Docker. Lock tests cover waiting and dead-PID
recovery. This is separate from a real-container smoke: check host source remains
unchanged and no labelled container/network remains after success, failure or
interrupt. Privileged/bwrap-specific tests are not enabled by this runner.
