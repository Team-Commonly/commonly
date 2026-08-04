# Idea register

Append-only. One line per idea, kept cheap on purpose — the point is that a
thought has somewhere to go the moment it happens, not that it arrives
well-formed.

**Status** — `raw` (captured, unjudged) · `decided` (an ADR settled it) ·
`building` (has an issue) · `parked` (deliberately not now, with a trigger) ·
`rejected` (with a reason, so it does not come back)

Anything that grows past a few lines graduates: a decision becomes an
`docs/adr/ADR-*.md`, a body of work becomes a GitHub issue under a milestone.
This file should never be where the real thinking lives. It is the inbox.

**Two trackers, on purpose.** Engineering work becomes an issue in this repo
under a milestone. Positioning, content and competitive work becomes an issue
in the private `commonly-gtm` repo, because it carries material that should not
be public. This register indexes both so they do not drift apart.

Currently open: milestone #11 *Sharpen* (#768 #769 #770 #771 #772), milestone
#12 *Agent network experiment* (#773 #774), and gtm #13–#16 (positioning).

---

## Product structure

| # | Idea | Why it might matter | Status |
|---|---|---|---|
| P1 | Collapse pod `type` to a `kind` (dm / room) and expose listing, joining, and reading as three explicit settings | Every non-DM pod is structurally identical today. The "Team Pod vs Private Pod" fork at creation sets only `joinPolicy`, and the word "Private" means three different things across creation, sidebar, and inspector | `raw` |
| P2 | Pods as nodes — a pod is a graph of pods, not a flat list | `parentPod` and a gated `/children` endpoint already exist in the backend with **zero** v2 UI. Comparable products are flat; this is open ground, but we cannot claim it until it is demoable | `raw` |
| P3 | Agent discovery across pods | Agents cannot find pods they are not already in. Without this, a "network" only moves when a human speaks | `raw` |
| P4 | Sub-discussion spawning — an agent splits a thread into its own room | Depends on P2 and on the create-pod fix (N1). Interesting only if it emerges rather than being scripted | `raw` |
| P5 | Creation flow as a considered modal, not a one-line prompt | The current "+ New Pod" affordance offers almost no choice and no explanation, so users cannot express intent at the moment they have it | `raw` |

## Attention routing (human-in-the-loop)

The framing: **humans will not sit and watch.** Approval gates assume an
audience that is not there. The primitive is not "gate every action", it is
"decide what deserves a human".

| # | Idea | Why it might matter | Status |
|---|---|---|---|
| H0 | **The agent spends a budget of human attention; it is not a judge's job to infer** | The agent already knows what it is uncertain about. Budget it, and conserving becomes the agent's own interest. Deletes H1 from v1 | `raw` |
| H1 | ~~A cheap judge model watches agent output and escalates on drift~~ | Superseded by H0 for v1 — becomes the fallback for agents that misreport their own uncertainty | `parked` |
| H7 | Two modes, borrowed from Claude Code / Codex: full-autonomy, and attention-on-boundary-crossing with the permitted set declared up front | Proven prior art we use daily. Their prompt blocks; ours must queue — that is the entire delta | `raw` |
| H2 | Escalation budget (N per agent per day) | Scarcity forces the judge to rank. Unbudgeted notification becomes noise, and noise gets muted, which is worse than no notification | `raw` |
| H3 | Learn from silence — approved or ignored 3× for a class of action, stop escalating it | The anti-spam mechanism that does not require configuration | `raw` |
| H4 | Escalate on irreversibility, not importance | Outward-facing, spending, destructive. Importance is subjective; irreversibility is a property of the action | `raw` |
| H5 | Request-access instead of a silent 403 | Turns a permission wall into a conversation with a reason attached | `raw` |
| H6 | Interrupt / steer a turn in flight | The human-initiated end of the same spectrum. Needs turn cancellation through the wrapper | `raw` |

## Runtime and commercial

| # | Idea | Why it might matter | Status |
|---|---|---|---|
| R1 | Prove developer users before the consumer path | The sandbox layer is what makes a consumer offering defensible; developers are the only users who will stress it hard enough to prove it | `raw` |
| R2 | Closed-source VM / sandbox layer as the commercial moat | The one part of the stack worth not giving away. Everything else can be open | `raw` |
| R3 | BYO-key hosted runtime as the bridge to consumers | No LLM cost to us, no CLI for them — but pasting an API key is still a developer-shaped act, so this is a bridge, not the destination | `raw` |
| R4 | Reactivation trigger for the hosted tier | Proposed bar: the sandbox layer runs untrusted third-party agent code for 30 consecutive days without an escape. A condition, not a date | `raw` |

## AX — agent experience

Treating agents as a first-class consumer of our API, the way DX treats
developers. Not a metaphor: an agent hits our surface with no ability to ask a
human what a confusing field means.

| # | Idea | Why it might matter | Status |
|---|---|---|---|
| X1 | Audit our own API as an agent consumer would experience it | Predictable errors, discoverable capabilities, stable identifiers, cheap context, self-describing endpoints | `raw` |
| X4 | Remaining attention budget as readable agent state | You cannot ration what you cannot see. Makes AX load-bearing rather than courtesy | `raw` |
| X5 | Structured escalation format, so a human resolves a request in seconds not minutes | The other half of X4 — spending the resource well requires an interface for spending it | `raw` |
| X2 | Machine-readable affordances — tell an agent what it may do, not only what it may not | Today an agent discovers its limits by hitting 403s | `raw` |
| X3 | A metric for agent activity distinct from human activity | Human DAU does not describe a workspace where most participants are not human | `raw` |

## Hardening

Verified against the codebase, not assumed. Each is a real current gap.

| # | Idea | Why it might matter | Status |
|---|---|---|---|
| S1 | Sandbox is **fail-open** when an agent declares no sandbox | `sandbox.mode` defaults to `none` when undeclared, and nothing binds public-pod attachment to `trust: public`. The policy is real and attack-tested — but only once declared | `raw` |
| S2 | Audit trail covers 2 event types | An `AuditLog` model and service exist; only attachment-token mints and the showcase toggle write to it. No admin action, token, login, or install is recorded | `raw` |
| S3 | Human `cm_` API tokens stored plaintext and re-displayable | Unlike agent tokens, which are hashed | `raw` |
| S4 | No MFA, no per-account lockout, no password policy, login enumerates accounts | Brute-force defense is per-IP only; registration accepts a one-character password | `raw` |
| S5 | `helmet` is a dependency but never applied | No app-layer CSP/HSTS/X-Frame-Options; relies entirely on edge defaults | `raw` |
| S6 | CLI credential files written with default umask | `~/.commonly/config.json` and `tokens/*.json` hold live bearer tokens without `0600` | `raw` |
| S7 | `getPodsByType` leaks pod existence instance-wide | Membership filtering covers only the three personal pod types | `raw` |

## Agent network primitives

These block the "do agents spontaneously DM and form sub-groups?" experiment.
All verified broken or unreachable for BYO agents; all small.

| # | Idea | Why it might matter | Status |
|---|---|---|---|
| N1 | `commonly_create_pod` omits the required `type` field | The published MCP tool sends `{name, description}`; the backend rejects without `type`. Agent-created pods 400 every time | `raw` |
| N2 | No MCP tool for pod discovery or self-install | Both kernel routes exist and are unexposed | `raw` |
| N3 | The consult primitive (`agent.ask`) is unreachable end-to-end | Live in the kernel, absent from the published tool surface, and the wrapper drops the event as `no_action` | `raw` |
| N4 | No heartbeat for local agents | BYO agents are purely reactive — nothing happens unless a human speaks | `raw` |
| N5 | Per-agent model assignment is not persisted | The token file has no model field, so restarting a wrapper silently drops its role-model pairing | `raw` |

## Agent identity

| # | Idea | Why it might matter | Status |
|---|---|---|---|
| I1 | Per-agent GitHub principals (machine users or per-agent PATs) | Agents share the operator's identity, so GitHub blocks self-approval and required-reviews would deadlock rather than gate. Agents cannot be held to the process humans are held to | `building` |
| I2 | Tiered verification levels, each deployment setting its own floor | Avoids forcing one identity cost on every deployment. Prior art exists | `raw` |
| I3 | Owner-signed scoped delegation, so a leaked agent key is revocable without touching the human behind it | Ours currently cannot revoke one agent without disturbing the operator identity | `raw` |
| I4 | Identity that survives moving between instances | Federation is stated ambition and is not expressible in `(agentName, instanceId)` | `raw` |

## Process

| # | Idea | Why it might matter | Status |
|---|---|---|---|
| W1 | Retire the competing milestone schemes | Two half-used sets exist; a third would make it worse | `raw` |
| W2 | Backlog triage pass — ~20 of 33 open issues carry no label | Unsorted backlog is why priorities feel unclear | `raw` |
| W3 | Add agents only for work that would otherwise not happen | More agents multiply review load, and the human is already the bottleneck | `raw` |
