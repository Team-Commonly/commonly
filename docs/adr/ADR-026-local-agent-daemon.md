# ADR-026: the local agent daemon — one install, zero per-agent commands

**Status:** Proposed (2026-08-27). Acknowledged unknowns: the machine-binding
model (D3) and the daemon-token shape (D4, blocked on #1296) are designs, not
measurements.

**Scope boundary.** ADR-023 (ratification-ready) removes the install step for
users who do not care where their agent runs — hosted is the default path for
new signups, and for pure casual-signup activation it is the bigger lever.
This ADR covers the users for whom LOCAL is the value proposition: developers
whose agents need their codebase, credentials, and local CLIs (a BYO codex
seat runs on the user's own ChatGPT auth by construction); self-hosters; and
the operator fleet itself. ADR-005 (wrapper driver) defined `commonly agent
run`; this ADR is its supervision layer, not its replacement. ADR-008 env
specs are consumed unchanged. Nothing here touches the kernel.

## Context

The per-agent-command model makes every new agent a fresh activation cliff,
and we have same-day measurements at both ends of the funnel:

- **The newcomer.** 2026-08-27: user `gavin` signed up at 03:06Z, walked the
  entire self-serve path unassisted, registered `gavin-codex` at 03:37:31 —
  and his `lastActive` froze at 03:37:18. One hour later the `first_contact`
  event was still `pending`, never delivered: no runtime ever polled with his
  token. He completed registration and fell at "now run this command in a
  terminal." This is the 41% first-contact cliff, one user at a time, and it
  recurs on every agent a surviving user adds.
- **The power user.** The operator laptop runs 15+ hand-started
  `nohup commonly agent run <name>` processes. No supervision, no restart, no
  upgrade path; a dead seat looks identical to a quiet one (the silent-seat
  runbook exists because of this). The wrapper fleet's 98-minute redelivery
  incident (pod-architect, 2026-08-26) was found by hand-reading logs.
- The server cannot answer "is anything running this agent?" — the BYO page's
  listening check (#888) polls for first token auth, but after that, silence
  and health are indistinguishable. The biomed pattern (11 of 14 installs
  never started) was invisible for weeks for exactly this reason.

Raft ships a resident daemon that adopts new agents without new commands. That
is not their moat; it is table stakes we lack, and our differentiation (the
workspace behind the agent) is unaffected by adopting it.

## Decision

**D1 — One resident daemon per machine, installed once.** `commonly daemon
install` registers a launchd/systemd service and authenticates once. From then
on, no terminal is ever required to add, start, restart, or upgrade an agent
on that machine.

**D2 — The server-side agent list is the source of truth.** The daemon
watches the user's attached-agent set (poll first; push later). Creating an
agent — from the web UI, from Scout during onboarding, from another agent —
is sufficient: the daemon notices, pulls the ADR-008 env spec (adapter, model
pin, workspace, MCP), provisions the harness, and reports it live. The BYO
page's final step changes from "run this command" to watching the agent come
up.

**D3 — Agents bind to a machine at attach time.** An agent row carries an
optional `machineId` (daemon-generated, named by the user: "Sam's MacBook").
A daemon adopts only agents bound to its machine; an unbound local agent is
offered to the user's machines on the next daemon poll. The UI shows where an
agent runs. Unknown being guessed at: whether multi-machine users need
rebinding UX in v1 or a single-machine assumption holds (measure first).

**D4 — The daemon holds a scoped daemon token, never the user JWT.** User
JWTs expire (2026-08-26: every saved CLI profile died at once, #1296) and
carry the user's full authority. A daemon token: long-lived, revocable from
the UI ("Sam's MacBook — revoke"), scoped to agent-lifecycle operations
(list/adopt/report) plus minting per-agent runtime tokens for agents bound to
its machine. Blocked on #1296's token-refresh work; the two should land as
one design.

**D5 — The daemon heartbeats per machine; liveness becomes a server fact.**
`machine.lastSeen`, plus per-agent `running | stopped | crashed(n)` reported
by the supervisor. The server can now render truthful state on every surface
("nothing is running gavin-codex"), auto-nudge on registered-but-never-adopted
(the Gavin email, automated), and alert on crash loops. The dormant-install
class stops being invisible.

**D6 — Supervision is boring on purpose.** Restart with backoff, log capture
to one predictable location, `commonly daemon status` for the terminal-
inclined, harness upgrades applied by the daemon (one upgrade point instead of
N stale wrappers). The daemon runs harness processes exactly as `agent run`
does today — same poller, same cascade cap, same claims. Existing `agent run`
remains supported forever (CI, containers, debugging); the daemon is its
supervisor, not its successor.

**D7 — The operator fleet migrates first.** The 15-process laptop is the
worst current deployment and the best test bed. Migration = attach existing
token files to the daemon's adoption list; no seat identity changes (rule 8:
identity survives).

## Consequences

- New-agent flow on a daemon machine: click in the UI → agent live in
  seconds. The Gavin cliff closes for every agent after the first install.
- The first install is now the ONLY cliff, and it is one command + one auth.
  Hosted (ADR-023) remains the zero-install path; the BYO page should offer
  both honestly: "run it here (hosted)" / "run it on your machine (daemon)".
- Security surface: a resident process holding a durable credential. Mitigated
  by D4 scoping + revocation; the daemon never holds model-provider keys
  (those stay in each harness's own auth, e.g. codex's ChatGPT login).
- `cli/` grows a `daemon` command group; the server grows machine rows +
  adoption/heartbeat endpoints (driver-layer, no kernel change).

## Alternatives rejected

- **Status quo (per-agent commands):** measured cost above; recurs per agent.
- **Hosted-only (lean entirely on ADR-023):** abandons the users whose value
  proposition is local access — developers, self-hosters, the fleet. Both
  ADRs exist because the population is genuinely split.
- **Electron/menu-bar app as the daemon:** heavier build surface for the same
  supervision; can be layered on top of the daemon later, not instead of it.
- **Auto-starting the runtime from the web page:** browsers cannot spawn
  local processes; every workaround (custom URL schemes into a helper app) is
  the daemon with extra steps.
