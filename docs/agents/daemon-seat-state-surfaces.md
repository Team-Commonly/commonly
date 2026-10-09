# Daemon seat state: one report, two surfaces, two different contracts

**Measured 2026-09-18 at main `ac544d5c` (cli 0.1.50).** The field map below is
a read of the tree at that commit. The one thing measured by RUNNING the
supervisor is the spawn/report disagreement in Trap 3, via a throwaway probe.

**Re-anchored 2026-09-19 at main `cbc3fe38`:** #1761 merged as `c9eb7eb8`, so Trap
3's citation moved from `daemon-supervisor.js:357-359` (that range is now the adopt
loop) to `:408–410`, and its corollary is no longer conditional. Nothing else in
the field map was re-measured — the rest is still a read of `ac544d5c`.

**Re-anchored 2026-09-27 at main `1c883e46` (cli 0.1.79):** Trap 4 is measured on
the operator host today, including the counts and the install time it quotes. The
other traps still carry the 09-18/09-19 reads, and the field map below was **not**
re-measured.

**Where the daemon's own environment comes from** — the service file's `PATH`,
`HOME` and provider keys, and the symptoms when one is missing:
[daemon-service-environment.md](./daemon-service-environment.md) (TASK-049).

A local daemon reports each supervised seat as **ten fields**
(`cli/src/lib/daemon-supervisor.js:73-85`):

```js
agentName, instanceId, state, restarts,
adapter, model, effort, pid, lastTurnAt, lastError
```

That single value, `agentStates()`, feeds **two different consumers**, and they
do not keep the same fields:

```
agentStates()
  ├─ POST /api/machines/<id>/heartbeat  { agents: agentStates() }   ← :381
  │    └─ normalizeAgentStates()  backend/services/machineService.ts:28-47
  │         rebuilds each entry as a 4-field WHITELIST
  │         └─ Machine.agentStates   backend/models/Machine.ts:41-50
  │              └─ serializeMachine :60-76 (agentStates map :70-75) → GET /api/machines
  │
  └─ persist() → persistState(agentStates())  :63-71 (call at :65)
       └─ daemon.js:345 → saveDaemonState  daemon-state.js:49
            └─ publicDaemonState  daemon-state.js:42-47
                 └─ seatState  daemon-state.js:26-37
                      └─ loadDaemonState  daemon-state.js:65   ONLY reader: daemon.js:393
                           └─ `commonly daemon status --verbose`  prints :401-404
```

| field | `GET /api/machines` | local state file | `daemon status --verbose` |
|---|---|---|---|
| `agentName`, `instanceId`, `state`, `restarts` | ✅ (lowercased / defaulted) | ✅ | ✅ |
| `adapter` | ❌ dropped | ✅ | ✅ `adapter=…` |
| `model` | ❌ dropped | ✅ | ✅ `model=…` |
| `effort` | ❌ dropped | ✅ | ✅ `model=…/effort` |
| `pid` | ❌ dropped | ✅ | ✅ `pid=…` |
| `lastTurnAt` | ❌ dropped | ✅ **last turn** (`daemon.js:351`) | ✅ `lastTurn=…` |
| `lastError` | ❌ dropped | ⚠️ redacted (`daemon-state.js:18-24`) | ⚠️ `error=…` |

⚠️ is not "stored partially". `fixedLastError` keeps only `child exited with code N`,
collapses every other non-empty error to `child process error`, and maps empty to
`null` — so a seat's actual failure text never reaches an operator through either
of those two columns, by design.

## Trap 1 — the API is a whitelist, so it cannot witness your change

`normalizeAgentStates` does not spread the reported entry; it **rebuilds** it:

```ts
if (!agentName || !AGENT_RUN_STATES.has(state)) return null;   // :37
return {
  agentName,                                 // trimmed, lowercased
  instanceId: … || 'default',
  state,                                     // running | stopped | crashed
  restarts,                                  // finite and > 0, else 0
};                                             // …then .filter(e => e !== null)  :46
```

Note the shape of the drop: an entry whose `state` is unknown does **not** appear
in `/api/machines` with a missing state — the **whole entry disappears from the
list** (`:37` returns `null`, `:46` filters it out). A seat you expect to see is
absent rather than present-but-blank, which is a different thing to go looking for.

So six of the daemon's ten fields never leave the reporting process. The intent is
on the model (`Machine.ts:39-40`: *"replaced wholesale by each heartbeat that
carries an agents array — the daemon's report is the truth, so no per-entry
merging"*) — the report is the truth, but only a 4-field subset of it is stored;
the subdoc at `Machine.ts:41-50` declares exactly those four paths.

**Consequence for tests and reviews:** a change to what the daemon reports as
`adapter` / `model` / `effort` **cannot be witnessed through `/api/machines`**.
An integration test that registers a machine, drives a seat, and asserts on the
API response is testing the whitelist, not your change — it passes identically
before and after. The only instrument that observes those three fields end-to-end
is the local state file (mode `0600`, dir `0700`), read back through
`loadDaemonState()`.

**This is the trap that cost real time:** a PR was characterised as "not an
operator-visible fix" on the strength of a frontend trace (the only UI reader of
`machine.agentStates` is `frontend/src/v2/components/V2AgentBYO.tsx:156`, which
uses `state`). The characterisation was wrong in the other direction — the field
*is* operator-visible, through the CLI's own status line, which sits in the file
being edited.

## Trap 2 — `lastTurnAt` means two different things

Same field name, both surfaces:

- **Heartbeat payload:** set once in `startChild` (`daemon-supervisor.js:91`) —
  i.e. it is the **spawn** time, not the last turn, and nothing in the
  supervisor updates it afterwards. (The server drops the field anyway — Trap 1
  — so this is a stale quantity in a payload nobody stores.)
- **Local state path:** `daemon.js:351` overrides it per seat with
  `getLastTurn(seat.agentName) || seat.lastTurnAt`, so the value an operator
  reads is a genuine last turn.

A value that is named, documented, and read on one surface may be a different
quantity on another — and the correction can live at the boundary (`daemon.js:351`)
rather than in the producer. If you are reasoning about "when did this seat last
work", the heartbeat payload never had the answer.

## Trap 3 — the report and the boot must read the same precedence

The status path and the spawn path **disagree at `ac544d5c`**, so a seat can boot
one model and report another (`row.runtime.model` ahead of the record the seat
actually runs). The contract is documented in-tree: `environmentFor`'s comment
treats `row.runtime` as a **compatibility overlay** on the record, overlaying
only where the record is silent — and `agent run` boots from the record, reading
`getAdapter(record.adapter)` (`cli/src/commands/agent.js:2453`) and
`environment: record.environment || null` (`:2476`), and exits 1 on an unknown
adapter.

**Report what spawns.** The fix inverts the status path to read the record
`ensureToken` just wrote, using `row.runtime` only for a seat with no record at
all — *an unmerged PR at the time of writing (#1761, TASK-065)*. It landed as
`c9eb7eb8`: the record-first trio is `daemon-supervisor.js:408–410` on
`cbc3fe38`, and the citation this trap carried when it was written (`:357-359`)
now falls inside the adopt loop, so the line range moved with the code rather
than the behaviour changing again.

Corollary for a `null`: a record with no `adapter` cannot start at all — `agent run`
does `getAdapter(record.adapter)` and exits 1 on an unknown name
(`agent.js:2453-2456`) — so `adapter=unknown` is honest rather than a missing
value. The status path now agrees with it: `:408–410` reads the record first and
falls back to `row.runtime?.…` only when there is no record at all, so a seat
whose *record* has no adapter reports `unknown` rather than the row's adapter.

## Trap 4 — `state: running` names a process, not the build it is executing

No field in this report says *which* cli a seat is running, and the obvious
stand-ins do not answer it. `pid` is the **supervisor's** pid. The supervisor's
argv does not name the build either: `/opt/homebrew/bin/commonly` is a symlink
into the installed package, so the *command* is the same string before and after
an upgrade.

The *interpreter* is not the same, and it is a **wrong instrument that currently
returns the right answer** — worth writing down, because it is the first thing a
reader reaches for. On this host the fifteen supervisors split 13/2 on that path:
the thirteen hand-started ones print `/opt/homebrew/bin/node`, and the daemon's
own two print `/opt/homebrew/Cellar/node/26.0.0/bin/node`. That difference tracks
**who launched the seat** (by hand under `ppid 1` versus the daemon), not which
cli it loaded. The two partitions coincide today only because the hand-started
ones happen to be the pre-install ones; one seat hand-started after an upgrade
breaks the coincidence, and the instrument then says "current" about a stale
seat. The module was read at boot; the file changed underneath it.

Two signals outside this report do separate them:

- **the supervisor's start time against the installed file's mtime.** This is the
  only cheap per-seat signal, for the reason [rule 38 of the review
  checklist](../development/review-checklist.md) gives — Node closes the module
  handle after reading it, so `lsof` shows nothing to read. Compare **seconds**
  (`ps -axo pid=,lstart=` against `date -r <resolved target>`); both round to the
  same minute in the case that rule was earned on.
- **the seat's MCP child argv**, while it has one: `npm exec @commonlyai/mcp@latest`
  from the shared `~/.npm/_npx/6d82e98be466b586` dir is a pre-TASK-174
  supervisor, while `node ~/.commonly/mcp/<version>/…` is 0.1.77 or later. A seat
  with no live child has nothing to read, which is not the same as a seat that
  passes.

**And the report's population is the seats *this daemon* supervises.** The state
file is rebuilt from the supervisor's in-memory `seats` Map (`daemon-supervisor.js:62`,
persisted through `persistState(agentStates())` at `:67`), which is filled from
the machine's bound rows — so a hand-started `commonly agent run <seat>` never
appears in it, and `commonly daemon restart` SIGTERMs only that daemon's own
children. The chain runs: restart the service (`launchctl unload -w` then
`load -w`, or `systemctl --user restart`) → SIGTERM to the daemon → its shutdown
handler (`commands/daemon.js:402–410`, `supervisor.stop()` at `:406`;
rule 38 anchors the same claim from the caller's side at `:403`) → `stop()`
(`daemon-supervisor.js:458`) → `stopSeat` (`:118`) → `seat.child.kill('SIGTERM')`
(`:126`). **`:126` reads as the wrong line if you arrive at it alone**, because
its log line is *"no longer assigned here — stopping"*, which says de-assignment
rather than restart; `:458` is the link that makes it the restart path. `:436` is
a different path — the per-seat respawn when a *record* changes (`:433`) — whose
comment, *"the restart path IS the D6 path"*, is about a record change while
reading as if it were about `daemon restart`.

Measured on the operator host 2026-09-27 14:20Z, with cli 0.1.79 installed
14:04:06Z (the mtime of the resolved `src/index.js`):

| what | count |
|---|---|
| seats in `daemon status --verbose` / `state.json` | **2** (quill, c4-smoke) |
| `commonly agent run` supervisors running | **15** |
| …of those, `ppid 1` **and** started before the install | **13** |

So the ship recipe "install the cli, restart the daemon" reaches the daemon's own
two seats and those seats only. The other thirteen keep the module they booted
with until each supervisor restarts on its own, and nothing on these surfaces
says which of them has. A criterion shaped "no seat logs `CONNECTION_CLOSED`
across the next publish" is therefore a per-seat question rather than a
daemon-restart one, and `state=running` is evidence about a **process** — never
evidence that a seat runs the new code.

**What would close it** (named, not built): a `version` (or `gitHead`) recorded by
the supervisor at boot and carried into the report. That is two edits rather than
one — see the security boundary in *When you change a seat field*.

## When you change a seat field

1. **Find every surface the field reaches** — the heartbeat/API path, the local
   state file, and the CLI's own status output. Stopping at "the API returns it"
   or at the frontend is an incomplete consumer trace.
2. **If the field is not in the server whitelist, say so** and test on the
   surface that actually carries it (`daemon-state.test.mjs` is the harness).
3. **If the field is derived, check the boot path reads it the same way** — the
   spawn path is the authority; the report must describe the running process.
4. **`publicDaemonState` / `seatState` pick fields deliberately** — it is a
   security boundary (`daemon-state.js:39-41`: *"no token, environment, or
   child-process metadata can be persisted merely because a future caller adds
   it"*). Adding a field to the report does not add it to the file; that is by
   design, and the reverse is the reason a new field needs two edits.

## Verify

```bash
# the whitelist: nothing outside this object survives the heartbeat
sed -n '28,47p' backend/services/machineService.ts

# the report: ten fields, two consumers
sed -n '63,95p'   cli/src/lib/daemon-supervisor.js
sed -n '345,355p' cli/src/commands/daemon.js
sed -n '26,47p'   cli/src/lib/daemon-state.js

# the only renderer of adapter/model/effort
grep -rn 'loadDaemonState' cli/src

# the report's POPULATION is this daemon's own seats, with their start times.
# ANCHOR it: an agent quoting this doc carries the phrase in its own prompt, so
# the unanchored form counts that agent too (16 here, the sixteenth a `claude -p`
# seat reading this file; 15 anchored)
ps -axo pid=,ppid=,lstart=,args= | grep -E '[c]ommonly agent run [a-z0-9-]+$'
python3 -c "import json,os;print([s['agentName'] for s in json.load(open(os.path.expanduser('~/.commonly/daemon/state.json')))['seats']])"

# when the installed cli landed, and which build a seat's MCP child is running
T=$(python3 -c "import os;print(os.path.realpath('$(command -v commonly)'))"); date -r "$T" '+%F %T %z'
ps -axo pid=,ppid=,args= | grep -E '[c]ommonlyai/mcp|mcp/0\.3'
```

## Related

- [LOCAL_CLI_WRAPPER.md](./LOCAL_CLI_WRAPPER.md) — the daemon, `attach`/`run`/`detach`
- [public-facing-agent-sandboxing.md](./public-facing-agent-sandboxing.md) — what a seat's declaration confines
- `backend/services/machineService.ts`, `cli/src/lib/daemon-state.js`
- [review-checklist.md](../development/review-checklist.md) — rule 38: a read of
  the installed artifact is not a read of the process running it, and the two
  disagree for as long as the process outlives the file
