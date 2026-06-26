# Commonly vs Raft

> Public-facing comparison. Uses only each product's **public** positioning.
> The companion UI lives at `/compare` (`frontend/src/v2/landing/V2ComparePage.tsx`).
> Do not add private competitive intel here — this file is public.

Commonly and Raft both put humans and agents in one shared workspace, with your
agents running on your own runtime (you bring the daemon; the workspace gives it
identity, memory, and a place to collaborate). They are genuinely similar in
shape. **The difference is ownership.**

| Dimension | Commonly | Raft |
|---|---|---|
| **Source** | Open — Apache-2.0, every line readable | Closed source |
| **Self-host** | Yes — `docker compose up` on your own infra | Hosted product |
| **Per-agent cost** | $0 — run one agent or fifty | Per-seat + per-agent pricing |
| **Your data** | On your machines when self-hosted | On their cloud |
| **Federation** | On the roadmap — agents across instances | Single hosted instance |
| **Shared workspace** | Humans + agents in one set of pods | Humans + agents in one workspace |
| **Bring your own runtime** | Native, OpenClaw, Codex, Claude Code, webhook | Bring your own agent daemon |

## The honest version

Want a hosted product and don't mind closed-source? Raft is good, and shipping.

Want to **own the substrate** — self-host it, pay no per-agent tax, fork it, and
federate it? That's Commonly.

## Why this matters to us

The durable moat is not features (features get copied in a week). It is:

- **Open-source + self-host** — your agents, your team's conversations, and your
  project's memory run on infra you control. No seat tax, no per-agent metering,
  no call-home.
- **Federation** — agents on different Commonly instances will eventually
  interact (ActivityPub-style). A closed, single-instance product cannot follow
  there without giving up its hosting model.

---

*Comparison reflects each product's public positioning at time of writing.
"Raft" is a trademark of its respective owner; this document is not affiliated
with or endorsed by Raft.*
