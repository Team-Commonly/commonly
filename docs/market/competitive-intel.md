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
| 4 | **amariahak** (dev.to) | Wrote "I Got Tired of Re-Explaining My Codebase to AI Every Single Session" (May 2026). Names the exact pain in the title; high-intent. | dev.to profile / comment | draft below |
| 5 | **escott** (dev.to) | Wrote "I Got Tired of Re-Explaining My Codebase to AI — So I Built a Memory Layer." Already built a workaround = very high intent, technical, opinionated. | dev.to profile / comment | draft below |

> More prospects accumulate on each loop pass.

### Draft outreach (review before sending — tone: human dev, lowercase, specific, no pitch-deck voice)

**#1 itlackey (dev.to comment / DM):**
> hey — saw your post about keeping three skill dirs in sync for claude/codex/cursor and re-syncing them every sunday. that exact drift problem is why i started building commonly (open source) — one project memory all your agents read from, so the skills/context live with the project instead of per-tool. would genuinely value your eyes on it if you're up for it, not trying to sell you anything: github.com/Team-Commonly/commonly

**#2 nolynchong (dev.to comment / DM):**
> read your writeup on the claude/chatgpt/cursor context fragmentation fix — nice approach. i went a different direction with it: commonly (oss) makes the memory belong to the project, not the tool, so any agent plugs into the same context. curious what you'd think given you've clearly hit the pain hard: github.com/Team-Commonly/commonly

**#3 Wenxiao Pan (existing-user follow-up):**
> hey Wenxiao — you asked about more runtime types + local runtime support a while back. that's exactly the direction we've been pushing. would love to show you what's landed and hear what's still missing for your setup — got 15 min this week?

**#4 amariahak (dev.to comment):**
> this post is basically my whole reason for building commonly. the re-explain-every-session tax is real — i went with "the memory belongs to the project, not the tool," so any agent you point at it (claude code, codex, cursor) reads the same context and you stop re-pasting. it's open source if you want to poke at it: github.com/Team-Commonly/commonly — would genuinely value a builder's take.

**#5 escott (dev.to comment):**
> nice — you built the memory layer i kept wishing existed. i went one step out from per-tool memory: commonly makes the memory belong to the *project* so it's shared across tools AND across teammates, not just across your own sessions. curious whether the cross-human part resonates with how you work, or if solo-session memory is really the whole problem for you. oss: github.com/Team-Commonly/commonly

---

## Differentiation stress-test — 2026-05-30

**Question asked:** what can a user do in Commonly that they genuinely can't in Multica or Subspace today? And how does solo-vs-backed + no-marketing change the picture?

**Multica (~29k★, OSS):**
- Shape is **project-management for agents** (assignee picker, issue tracker, activity timeline), single-operator-centric. Its own issue #815: *"Multica still manages AI the way it manages people."*
- **No first-class memory layer.** Reviewers (mem0, agentpedia) note: skills say *how*, but there's no first-class place for *what's true about the codebase*. **This is exactly Commonly's wedge (project memory) — Multica does not have it.**
- No event-driven orchestration (schedule triggers only as of v0.3.1; no fire-on-PR/Slack), weak agent output visibility.
- Funding: **no Crunchbase entry** ("Multicast" is unrelated). Star spike looks like trending/build-in-public, not a VC war chest.

**Subspace ($12/mo or $99/yr; Mac Apple-Silicon only; CLOSED source):**
- Structurally the **inverse of Commonly on every axis**: closed-source (vs OSS), Mac-only (vs web/self-host any platform), and **explicitly single-developer** ("built for people running 3–10 agents," "before anyone else sees them").
- Strong *background memory* — but it's a **personal desktop power-user tool. No multi-human collaboration.** Nobody else joins your Subspace.

**Verdict:** Commonly's combination — **multi-human + multi-vendor + OSS + project-owned memory** — is **genuinely unoccupied.** Multica = single-operator PM (no memory primitive). Subspace = single-dev closed desktop (no multi-human). Notion = doc-centric/backed. The premise holds; the gap is structural, not wishful.

**The real risk is distribution, not product.** Solo + no marketing budget vs teams with earlier flywheel momentum. Mitigations grounded in precedent:
- Competitors are **indie/small, not heavily VC-funded** (Multica no funding record; Subspace a $12/mo indie app). Beatable.
- Solo-OSS distribution playbook needs one repeatable motion, not budget: **launch small + often, show up where devs are, reply within hours** (the thing backed teams can't match). Precedent: Supermemory (solo → 25k★ → $3M raise), Pieter Levels ($1M ARR, 0 employees, 0 paid marketing, build-in-public).
- **Unique owned asset:** the repo is built by its own agents. That narrative *is* the marketing — a live self-demo neither Multica nor Subspace can tell.

**Action items for Sam:**
- [ ] Reframe YC "competitors" answer: Multica = single-operator PM w/ no memory layer; Subspace = closed single-dev desktop. Commonly's multi-human + memory combo is the unoccupied slice.
- [ ] Pick ONE build-in-public motion (e.g. weekly "what the agent team shipped" post) — distribution is the binding constraint, and it's the lever you actually control.
- [ ] Lead with the "built by its own agents" story everywhere — it's your unfair distribution asset.

**Sources:** [Multica GitHub](https://github.com/multica-ai/multica) · [Multica issue #815](https://github.com/multica-ai/multica/issues/815) · [mem0 on Multica memory](https://mem0.ai/blog/how-memory-works-in-a-multi-agent-system-inside-multica) · [Subspace](https://www.subspace.build/) · [Subspace on Product Hunt](https://www.producthunt.com/products/subspace-4) · [Supermemory/Levels solo-OSS distribution](https://www.indiehackers.com/post/i-did-it-my-open-source-company-now-makes-14-2k-monthly-as-a-single-developer-f2fec088a4)

---

## Pass log

### Pass 1 — 2026-05-30

**🚨 Surfaced to Sam in chat (urgent):**
- **Notion Developer Platform + External Agents API — launched 2026-05-13** (seed doc said May 25; corrected). Brings Claude/Codex/Decagon in as "first-class workspace participants"; lets teams bring *their own* internal agents into Notion; **1M+ Custom Agents already built**; ships a Notion CLI. This is the strongest "teams + humans + external agents in one workspace" play yet — closest to Commonly's multi-human pitch. **Wedge survives** because Notion is doc-centric and not runtime-neutral at the *memory* layer, but this is the #1 competitor to position against in the YC app. ([TechCrunch](https://techcrunch.com/2026/05/13/notion-just-turned-its-workspace-into-a-hub-for-ai-agents/) · [Notion blog](https://www.notion.com/blog/introducing-developer-platform) · [InfoWorld](https://www.infoworld.com/article/4171166/notion-courts-developers-with-platform-for-ai-agents-and-workflow-automation/))

**Other deltas:**
- **Google: Vertex AI → "Gemini Enterprise Agent Platform" (2026-05-21)** — agent-first rehierarchy, 200+ models incl. Claude, pushing **A2A as the cross-vendor coordination protocol**. Validates the "agent↔agent coordination is the open problem" thesis, but enterprise-flavored, not a multi-human social room. ([roborhythms](https://www.roborhythms.com/gemini-enterprise-agent-platform-launch/) · [TNW](https://thenextweb.com/news/google-cloud-next-ai-agents-agentic-era))
- **Taskade** claims to be the **only platform with real-time human+agent co-edit** (Google-Docs-style OT, human cursor in the agent's doc). Narrow but a direct multi-human claim — watch. ([Taskade](https://www.taskade.com/blog/agent-teams-collaboration))
- **Anthropic (2026-05-19):** Managed Agents now have self-hosted sandboxes + "MCP tunnels" (outbound-only gateway to internal MCP servers). Relevant to Commonly's driver/runtime story.
- **Memory-layer crowd still thickening** (Mneme, ContextStream, plus the dev.to "I got tired of re-explaining my codebase" genre is now a recurring post format). Demand for the memory primitive keeps compounding; defensibility must stay on coordination + multi-human, not memory alone.

**Demand-side signal (strong, for marketing):** "I got tired of re-explaining my codebase to AI every session" is now a **repeating viral dev.to headline** (multiple near-identical posts, May 2026). This is a ready-made content wedge — Commonly's "memory belongs to the project" line answers the exact title. Devs report **10–15 min/session** lost to context rebuild ([The New Stack](https://thenewstack.io/context-is-ai-codings-real-bottleneck-in-2026/)).

**New prospects added:** #4 amariahak, #5 escott (both below).

**Action items for Sam:**
- [ ] YC app: add **Notion Developer Platform** as the headline competitor in the big-platform row; correct any May-25 reference to **May 13**.
- [ ] Marketing: the dev.to "tired of re-explaining my codebase" headline is a proven format — write a Commonly version (build-in-public asset).
- [ ] Approve/edit outreach drafts for #4 and #5 before any send.

**Sources (Pass 1):** Notion (TechCrunch/InfoWorld/Notion blog, 2026-05-13); Google Gemini Enterprise (roborhythms/TNW, 2026-05-21); Taskade agent-teams blog; Anthropic Managed Agents update (2026-05-19); dev.to context-loss posts ([amariahak](https://dev.to/amariahak/i-got-tired-of-re-explaining-my-codebase-to-ai-every-single-session-10dk), [escott](https://dev.to/escott/i-got-tired-of-re-explaining-my-codebase-to-ai-so-i-built-a-memory-layer-4dhl)); The New Stack (context bottleneck).

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
