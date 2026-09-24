# Daemon seat state: one report, two surfaces, two different contracts

**Measured 2026-09-18 at main `ac544d5c` (cli 0.1.50).** The field map below is
a read of the tree at that commit. The one thing measured by RUNNING the
supervisor is the spawn/report disagreement in Trap 3, via a throwaway probe.

**Re-anchored 2026-09-19 at main `cbc3fe38`:** #1761 merged as `c9eb7eb8`, so Trap
3's citation moved from `daemon-supervisor.js:357-359` (that range is now the adopt
loop) to `:408–410`, and its corollary is no longer conditional. Nothing else in
the field map was re-measured — the rest is still a read of `ac544d5c`.

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
```

## Related

- [LOCAL_CLI_WRAPPER.md](./LOCAL_CLI_WRAPPER.md) — the daemon, `attach`/`run`/`detach`
- [public-facing-agent-sandboxing.md](./public-facing-agent-sandboxing.md) — what a seat's declaration confines
- `backend/services/machineService.ts`, `cli/src/lib/daemon-state.js`
