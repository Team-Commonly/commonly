# ADR-026: the local agent daemon — one install, zero per-agent commands

**Status:** Proposed (2026-08-27; rev 2 same day, after adversarial review —
three Sharpen findings on the PR + Vera's nine, all folded below). Remaining
acknowledged unknown: whether multi-machine users need rebinding UX in v1
(D3 now ships safe either way).

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

**D3 — The binding owner is the agent IDENTITY, and adoption is an atomic
transition.** (Rewritten per review: an unbound identity visible to every
daemon is an adoption race, and binding the installation row would still run
one identity from two machines — runtime credentials expand to every active
installation, `agentRuntimeAuth.ts:81-102`.) The agent identity carries
`machineId`; adoption is a server-side conditional transition
`unbound → bound(machineId)` (compare-and-set — the loser of a concurrent
adopt gets a clean refusal, never a second runner). Rebinding is an explicit
release-then-rebind operation, user-initiated. In v1 no daemon adopts
anything without a user choice: attach names the machine, or the UI asks —
"offer to whichever machine polls first" is the race and does not ship. The
UI shows where every agent runs.

**D4 — The daemon holds a scoped daemon token, never the user JWT — and the
token SUBSTRATE is a prerequisite, not a detail.** (Rewritten per review.)
Today there is nothing to build this on: `User.apiToken` is a single string
that `generateApiToken` overwrites; runtime-token records hold only
hash/label/timestamps (`User.ts:261-268`); auth grants all active
installations for the identity. On that model, D4's revocation promise is
false — revoking a daemon token leaves its minted children live, and a
removed machine keeps operating its agents. And the blast radius is total: a
stolen daemon token is every agent on that machine at once, because mint is
transitive and a runtime token is a full agent identity (Vera; the 15-seat
operator laptop is the worst possible first deployment for getting this
wrong).

So **D4.5 — Phase 0 is a real token collection**: per-token records with
immutable issuer lineage (`parentTokenId`, `machineId`, scope), auth that
rejects a child whose parent is revoked (or revocation that atomically
revokes all descendants — either, but enforced server-side), and the
bound-agent predicate checked by the server, never trusted from a
caller-supplied machineId. #1296's browser-login/refresh flow does NOT supply
this authorization model — the two land together but #1296 alone is not the
prerequisite. No daemon ships before Phase 0.

**D5 — The daemon heartbeats per machine; liveness becomes a server fact.**
`machine.lastSeen`, plus per-agent `running | stopped | crashed(n)` reported
by the supervisor. The server can now render truthful state on every surface
("nothing is running gavin-codex"), auto-nudge on registered-but-never-adopted
(the Gavin email, automated), and alert on crash loops. The dormant-install
class stops being invisible.

**D6 — Supervision is boring on purpose, and restart is NOT free under
today's claims.** (Amended per review: a delivery claim has no owner or
generation — `acknowledge` gates only event/id/name/instance/status, so an
old child waking after the 10-minute requeue can ack the NEW child's delivery
(`agentEventService.ts:1029-1045`), both having already spawned. Daemon
upgrade/restart makes that race routine, and the cascade cap cannot prevent
the first duplicate turn.) Therefore: event fetch/ack carries a delivery
nonce (supervisor generation), invalidated on requeue; a replacement child
waits for the prior child to exit or lose its lease before fetching; and the
race is pinned by an old-claim-acks-after-requeue mutation test before the
daemon's first restart path merges. Everything else stays boring: restart
with backoff, one log location, `commonly daemon status`, harness upgrades
applied by the daemon. Existing `agent run` remains supported forever; the
daemon is its supervisor, not its successor.

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
- **Build order is forced by the findings**: Phase 0 token substrate (D4.5)
  → Phase 1 bind + adopt + heartbeat (D3/D5) → Phase 2 supervision with the
  delivery-nonce work (D6). The fleet migration (D7) waits for all three.

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
