# Commonly — Market & Competitive Intelligence

> Living doc. Each pass appends a dated entry below. Newest pass at the top of the log.
> Maintained by an in-session research loop (web search + analysis). **Outreach drafts are staged for human review — never sent automatically.**
>
> Positioning anchor: *one project memory shared by all your AI tools* — multi-human + multi-vendor, fully-OSS workspace where agents from any runtime connect over HTTP.

---

## Standing competitive map

Categorized by structural limitation relative to Commonly's multi-human + multi-vendor + OSS thesis.

### Direct — vendor-neutral agent workspaces (watch closest)
| Player | Shape | Notes / structural gap vs Commonly |
|---|---|---|
| **Multica** (`multica-ai/multica`, Apache 2.0) | Single-human + many agents; "agents as teammates", task/dashboard UX | **~28.9k★ as of v0.3.1 (2026-05-15)** — grew fast from ~10k in April. Supports Claude Code, Codex, Copilot CLI, OpenClaw, OpenCode, Hermes, Gemini, Cursor Agent, Kimi, Kiro. Go + Next.js 16 + Postgres/pgvector. **Closest competitor; project-management UX, not multi-human shared room.** ⚠️ YC draft cites stale 10.7k — update to ~28.9k. |
| **Slock** (slock.ai) | Slack-shaped: servers/channels/DMs, humans + agents as equals | Closest to Commonly's *shape*. Agents run on user's own hardware via daemon; `slock task claim` + thread progress. **Vendor-locked to EverMind/EverMemOS memory runtime** — that's the wedge against them (we're memory-neutral). |
| **Subspace** (subspace.build) | "Agent-first workspace" — run Claude Code, Codex, OpenCode, Gemini side by side, shared memory | Auto-captures observations/decision logs, replays into every new session across agents. **Direct hit on our shared-memory primitive** — needs deeper vetting (single-human? team? OSS?). NEW on radar. |

### Adjacent — memory/context-portability layers (commoditization risk on the memory primitive)
| Player | Shape | Notes |
|---|---|---|
| **agentmemory** (`rohitg00/agentmemory`) | Persistent memory for Claude Code, Codex CLI, Cursor, Gemini CLI via MCP/hooks | OSS memory layer. Validates the pain; competes on the *memory* slice, not coordination/multi-human. |
| **MyNeutron** | "Save context once, use in any AI" portability layer | Consumer-ish context portability. |
| **Unabyss** | Personal context vault exposed to any AI via MCP | Personal (single-user) context layer. |
| **EverMind / EverMemOS** | Memory infra (powers Slock) | Memory-as-infrastructure play. |
| **mcp-memory-service** (`doobidoo/...`) | Persistent memory for LangGraph/CrewAI/AutoGen + Claude | Pipeline-oriented, not workspace. |

### Big-platform entrants (structural-incentive moat is the defense)
| Player | Move | Why it doesn't kill the thesis |
|---|---|---|
| **Notion** | **2026-05-25: opened workspace to Claude Code, Cursor, Codex, Decagon as native agents** — Developer Platform: Workers (hosted runtime), DB sync, External Agents API | **Most significant new entrant.** Notion is doc-centric, not agent-runtime-neutral at the coordination layer; but the "External Agents API" overlaps our CAP pitch. Watch hard. |
| **Microsoft Conductor** | Deterministic orchestration for multi-agent workflows (OSS blog 2026-05-14) | Orchestration/workflow engine, not a multi-human social workspace. |
| **Moltbook → Meta** | Acquired into Meta Superintelligence Labs (Mar 2026) | No longer independent/vendor-neutral. |
| **Slack / Agentforce** | Slack pushing its own AI agents | Can't go vendor-neutral without sabotaging own AI revenue (the moat). |

### Single-vendor lock-in (the "you don't have to pick" argument targets these)
Devin (Cognition), Cursor agent mode, Replit Agent, Lindy, Manus, Grok Build, Windsurf — each locks to one runtime/editor. Feb 2026: every major tool shipped multi-agent within a two-week window (Grok Build 8 agents, Windsurf 5 parallel, Claude Code Agent Teams, Codex CLI Agents SDK, Devin parallel sessions).

---

## Market signals (demand-side)

- **Context-fragmentation pain is mainstream, not niche.** Multiple 2026 dev.to / LinkedIn / Medium pieces on "AI tools don't share context"; a viral LinkedIn post ("I hate switching between ChatGPT and Claude…") drew 173 comments. Reinforces founder language: *"every new session means re-explaining everything."*
- **Solo-founder-with-agent-team is a recognized category.** Fortune (2026-05-18) on solo founders doing the work of entire teams; multiple "solo founder AI stack" pieces. AI-augmented founders reportedly ship 8–12 features/mo vs 2–4. Agent stack ~$300–500/mo vs $80–120k/mo human equiv. **This is exactly Commonly's wedge-buyer narrative — externally corroborated.**
- **MCP is now cross-vendor infra** under Linux Foundation's Agentic AI Foundation; A2A (Google) emerging for agent-to-agent. **Key insight for our moat:** MCP standardizes agent→tool; agent↔agent *coordination* across vendors is still "an open problem." That's the network-effect gap Commonly sits in — consistent with the "why might this fail?" framing.

---

## Prospect candidates (vetted list — drafts staged, NOT sent)

Sourcing rule: public builders voicing the exact pain (multi-tool context fragmentation, duplicate skill dirs, solo-founder-with-agents). Contact = public channel only. **No message is sent without explicit approval.**

| # | Who | Signal (why they fit) | Public contact | Status |
|---|---|---|---|---|
| 1 | **itlackey** (dev.to) | Maintains 3 duplicate skill dirs (Claude/Codex/Cursor) that drift weekly; Sunday re-sync ritual. Canonical wedge user (already in PAIN_RESEARCH). | dev.to profile | draft below |
| 2 | **nolynchong** (dev.to) | Wrote "How I solved AI context fragmentation between Claude, ChatGPT, and Cursor" — actively built a workaround = high-intent. | dev.to profile | draft below |
| 3 | **Wenxiao Pan** (existing user, AI-chip founder) | Already on Commonly; asked unprompted for "more runtime types / local runtimes." Expansion/testimonial, not cold. | already connected | follow-up note below |

> More prospects accumulate on each loop pass.

### Draft outreach (review before sending — tone: human dev, lowercase, specific, no pitch-deck voice)

**#1 itlackey (dev.to comment / DM):**
> hey — saw your post about keeping three skill dirs in sync for claude/codex/cursor and re-syncing them every sunday. that exact drift problem is why i started building commonly (open source) — one project memory all your agents read from, so the skills/context live with the project instead of per-tool. would genuinely value your eyes on it if you're up for it, not trying to sell you anything: github.com/Team-Commonly/commonly

**#2 nolynchong (dev.to comment / DM):**
> read your writeup on the claude/chatgpt/cursor context fragmentation fix — nice approach. i went a different direction with it: commonly (oss) makes the memory belong to the project, not the tool, so any agent plugs into the same context. curious what you'd think given you've clearly hit the pain hard: github.com/Team-Commonly/commonly

**#3 Wenxiao Pan (existing-user follow-up):**
> hey Wenxiao — you asked about more runtime types + local runtime support a while back. that's exactly the direction we've been pushing. would love to show you what's landed and hear what's still missing for your setup — got 15 min this week?

---

## Pass log

### Pass 0 — 2026-05-30 (seed)
**New / changed since the YC draft:**
- **Multica ~28.9k★** (v0.3.1, 2026-05-15) — draft's 10.7k is stale. Update before YC submission.
- **Notion opened workspace to external agents (2026-05-25)** — Claude Code/Cursor/Codex/Decagon as native agents + External Agents API. New top-tier entrant; overlaps CAP.
- **Subspace** surfaced as a direct shared-memory competitor — needs a dedicated vetting pass.
- **Microsoft Conductor** (2026-05-14) — deterministic multi-agent orchestration, OSS. Adjacent, not a workspace.
- Memory-layer crowd thickening (agentmemory, MyNeutron, Unabyss, EverMind) → reinforces the "memory primitive could commoditize" failure mode; defensibility must rest on coordination + multi-human network effect, not memory alone.

**Actions for Sam:**
- [ ] Correct Multica star count in YC app (10.7k → ~28.9k).
- [ ] Decide whether to add Notion + Subspace to the YC competitor list.
- [ ] Approve/edit the 3 outreach drafts above before any send.

**Sources (Pass 0):** Multica GitHub + toolchew/agentconn reviews; TechTimes (Notion, 2026-05-25); Subspace.build; knightli/agentmemory; Slock.ai + EverMind.ai; Microsoft OSS blog (Conductor); Fortune (solo founders, 2026-05-18); deepsense/Linux-Foundation MCP coverage; dev.to context-fragmentation posts.
