# ADR-013: Agent file production, skill bundles, and v2 install surfaces (Marketplace + inspector tabs)

**Status:** Draft — 2026-05-03
**Author:** Lily Shen
**Companion:** [`ADR-001`](ADR-001-installable-taxonomy.md), [`ADR-002`](ADR-002-attachments-and-object-storage.md), [`ADR-008`](ADR-008-agent-environment-primitive.md), [`ADR-011`](ADR-011-shell-first-pre-gtm.md)

---

## Context

ADR-002 shipped object storage and inline file previews. Humans can now upload PDFs, DOCX, XLSX, CSV, MD, images into pod chat and have them render as preview pills. Agents can already *post messages*, but they cannot meaningfully *produce a file* and surface it in chat.

The gap has three layers:

1. **Toolchain** — the OpenClaw gateway image (`node:22-bookworm` + bun + optional gh CLI) has no document-generation binaries. Agents cannot run `pandoc`, `python-docx`, `libreoffice`, `docx-js`, `openpyxl`, `python-pptx`, etc. They can only emit text-encodable formats by hand (md, csv, html, svg, json).

2. **Protocol glue** — even if an agent produced a `report.pdf` in its workspace, there is no path to surface it as a chat attachment. The new `[[upload:fn|on|sz|kind|fileId]]` directive (PR #278) and the agent runtime upload endpoint (`POST /api/agents/runtime/pods/:podId/uploads`) both exist, but no clawdbot tool wraps them. Agents can't author the directive correctly without protocol knowledge they don't have.

3. **Skill bundles for dev agents are empty.** `PRESET_DEFINITIONS` already has a `defaultSkills` field and the install pipeline already syncs skills to `/workspace/<accountId>/skills/` on the gateway PVC (via `syncOpenClawSkills` in `agentProvisionerServiceK8s.ts`). But the four production dev personas — `dev-pm` (Theo), `backend-engineer` (Nova), `frontend-engineer` (Pixel), `devops-engineer` (Ops) — all ship with `defaultSkills: []`. They have been operating on Codex CLI's raw shell access alone. The `engineering-copilot` preset (which is *not* installed for any of them) is the only dev-flavored preset with `github` + `tmux` declared.

So the question "how do agents make files" surfaces a deeper question: **what is in a dev agent's skill bundle, ever?** Right now: nothing. We've been treating skills as a separate concern from "make the agent capable" — but skills are how capability ships in this architecture.

### What we already have (don't rebuild)

| Surface | Status | Reference |
|---|---|---|
| Skill catalog (~1,659 community-authored skills as of 2026-02-05 sync) | Synced from `VoltAgent/awesome-agent-skills` | `external/awesome-openclaw-skills/`, `docs/skills/awesome-agent-skills-index.json` |
| Skill install API | Shipped | `backend/routes/skills.ts` — `GET /catalog`, `POST /import`, `GET /requirements`, `GET/DELETE /pods/:podId/imported`, ratings |
| Skill sync to gateway PVC | Shipped | `syncOpenClawSkills` in `agentProvisionerServiceK8s.ts`; called from provision + reprovision + `/api/skills/import` |
| `defaultSkills` in preset definitions | Shipped, mostly unused | `backend/routes/registry/presets.ts` |
| File upload endpoints | Shipped (ADR-002) | User: `POST /api/uploads`. Agent runtime: `POST /api/agents/runtime/pods/:podId/uploads`. Returns `{fileName, _id, kind, size, originalName}` |
| File pill rendering with click-to-preview | Shipped (PR #278) | `[[upload:fn\|on\|sz\|kind\|fileId]]` directive; inspector preview for PDF/CSV/MD/Office/images |
| V1 skills UI | Shipped, bloated | `frontend/src/components/skills/SkillsCatalogPage.tsx` (2,061 lines), `frontend/src/components/agents/AgentsHub.tsx` (4,954 lines) |
| V2 inspector tabs | Shipped | overview / members / tasks / manage. No skills tab. No agent install/fork UI in v2 yet. |

### Office-relevant skills already in the catalog

Filtering the catalog (~1,659 skills as of the 2026-02-05 sync — see caveat at end of this section) for Linux-runnable file generation:

| Skill | What it does | Tools it shells out to |
|---|---|---|
| **`pandic-office`** | Markdown → PDF | `pandoc` |
| **`ai-pdf-builder`** | Markdown → PDF with AI content scaffolding | `pandoc` + LaTeX |
| **`pdf`** (awspace) | Extract text/tables, create, merge, split PDFs | Python (likely `pypdf`, `reportlab`) |
| **`pdf-2`** (seanphan) | Same as `pdf`, fork | Python |
| **`markdown-converter`** | Binary doc → Markdown for LLM consumption | `markitdown` (Microsoft) |
| **`research-company`** | B2B company research → branded PDF | composite |

Excluded: `tiangong-wps-*` (Windows COM only — won't run in our Linux gateway); `gamma` (third-party SaaS API).

**Observation:** the catalog has solid PDF coverage and decent parse-direction tooling, but **no Linux-runnable PPTX or XLSX generation skills**. That's a gap we may fill upstream later (§Phase 4); for now we ship without it.

> **Caveat on catalog-derived numbers throughout this ADR.** The skill count (~1,659), star counts (e.g. `github` skill 603 stars, used below), category counts, and license fields are all read from `docs/skills/awesome-agent-skills-index.json`, which is a **frozen snapshot from `scripts/sync-awesome-agent-skills.sh` last run on 2026-02-05** (nearly 3 months ago at draft time). Upstream `VoltAgent/awesome-agent-skills` is actively maintained — every figure cited from the index drifts daily. Numbers are point-in-time evidence that the skill / count / popularity *exists*, not live counts. Re-sync before publishing or making sales-pitchy claims; treat all sync-derived figures as ≥ that value, never == it. Numbers fetched live via GitHub API in this ADR (notably OfficeCLI's 2,768 stars and v1.0.70 release date) are timestamped explicitly and are real-time as of 2026-05-03.

### Why this ADR now

1. The shell-polish track (ADR-011 Phase 1, shipped 2026-04-29) plus the file-attach UX wave (PRs #266–#278) made file output the next visible deficiency. Pods now look ready for files — but the agents can't put them there.
2. YC application sprint deadline 2026-05-04 is past. The next demo loop will want at least one "agent generated a brief / report / spec and dropped it in chat."
3. Dev agents shipping with empty skill bundles is a quiet correctness bug. The infrastructure was built and never wired up.
4. The marketplace install flow exists in v1 but is hidden behind a 2k-line page. v2 needs a much smaller, faster install affordance, and the file-tools rollout is the right forcing function.

---

## Decision

Four coordinated changes, ordered by dependency:

1. **Add `commonly_attach_file` to the OpenClaw `commonly` extension** as a first-class tool. This is protocol glue, not a skill — same category as `commonly_post_message`. It reads a file from the agent's workspace, posts it to the upload endpoint, and (optionally) sends a chat message containing the directive in one call.

2. **Install the document-generation toolchain in `clawdbot-gateway`'s Dockerfile.** Pandoc, TeX, LibreOffice (`soffice`), Python office libs (`python-docx`, `python-pptx`, `openpyxl`, `markitdown`), and `docx-js` (npm). Adds ~600MB to the image; absorbed once.

3. **Define and apply default skill bundles for the four production dev presets** (`dev-pm`, `backend-engineer`, `frontend-engineer`, `devops-engineer`). Add a baseline community skill set covering file generation, doc parsing, and source control. Reuse the existing install pipeline — no new infrastructure.

4. **Add a "Skills" tab to the v2 inspector and a "Fork / Install" affordance to the v2 Agent surface.** Compact, search-first, two-pane: catalog on the left, this-agent's-installed on the right. Replace nothing in v1; v2 surface only.

A two-line addition to **SOUL.md** ("If you produce a file, attach it via `commonly_attach_file`. Don't paste contents.") completes the loop — the rule belongs in shared behavior, not per-skill prose.

---

## Detailed design

### Part 1: `commonly_attach_file` extension tool

Lives in `_external/clawdbot/extensions/commonly/src/tools.ts` alongside `commonly_post_message`, `commonly_create_pod`, etc.

```ts
commonly_attach_file({
  podId: string,             // required
  filePath: string,          // relative to /workspace/<accountId>/
  message?: string,          // optional caption — if present, posts a chat
                             //   message with the directive appended
  replyToId?: string,        // optional reply threading
})
  → { fileId: string, fileName: string, originalName: string,
      size: number, kind: string, signedUrl: string }
```

Implementation steps:

1. Read file bytes from `/workspace/<accountId>/<filePath>`. Reject if file is missing, unreadable, larger than 25 MB, or path escapes the workspace.
2. Detect MIME from extension + (later) magic bytes; reject types not on the allowlist. Same allowlist as `POST /api/uploads` — see ADR-002 §allowlist.
3. POST multipart to `/api/agents/runtime/pods/:podId/uploads` using the agent's runtime token. Returns `{_id, fileName, originalName, size, kind}`.
4. If `message` is present, POST `${message}\n[[upload:fileName|originalName|size|kind|_id]]` to `/api/agents/runtime/pods/:podId/messages` (with `replyToId` if supplied). Otherwise return the file metadata so the agent can compose its own message.

The tool description in the schema (visible to the model on every turn) carries the teaching:

> Use after producing a deliverable file in your workspace. Examples:
> after `pandoc input.md -o report.pdf`, call `commonly_attach_file({podId, filePath: 'report.pdf', message: "Q1 brief attached."})`. The recipient sees a clickable file pill that opens an inline preview.

**Why a tool, not a skill.** Skills are for capabilities the agent learns to use (how to drive pandoc, how to author a PowerPoint). Tools are for protocol verbs the kernel exposes (post a message, create a pod, attach a file). The choice mirrors the existing extension surface and avoids a new install dependency just to surface the upload endpoint.

### Part 2: `clawdbot-gateway` Dockerfile additions

The toolchain centers on **OfficeCLI** (`iOfficeAI/OfficeCLI`, Apache-2.0, single 30MB static binary, purpose-built for AI agents — see §Rejected alternatives F for why this beats the pandoc-plus-Python stack). Pandoc remains for PDF; markitdown remains for the parse direction.

```dockerfile
# OfficeCLI: DOCX / XLSX / PPTX read+edit+create, single static binary
ARG OFFICECLI_VERSION=1.0.70
ARG OFFICECLI_SHA256=<lookup-from-SHA256SUMS-at-pin-time>
RUN curl -fsSL -o /usr/local/bin/officecli \
      https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}/officecli-linux-x64 && \
    echo "${OFFICECLI_SHA256}  /usr/local/bin/officecli" | sha256sum -c - && \
    chmod +x /usr/local/bin/officecli

# Pandoc + LaTeX engine for md → PDF, plus parse-direction utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
      pandoc texlive-xetex texlive-fonts-recommended \
      poppler-utils python3-pip && \
    rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir \
      markitdown pypdf
```

Rationale per piece:

| Package | Job | Approx size |
|---|---|---|
| `officecli` (pinned) | DOCX / XLSX / PPTX create + edit + validate. Path-based addressing (`/slide[1]/shape[2]`), `--json` output, three layers (L1 read → L2 DOM edit → L3 raw XML), built-in `help` schema, validation, `view html` snapshots. LLM-optimized by design. | ~30 MB |
| `pandoc` + `texlive-xetex` + `texlive-fonts-recommended` | md → PDF (LaTeX engine), md → simple DOCX as fallback for the trivial cases where OfficeCLI is overkill. Required by `pandic-office`, `ai-pdf-builder`. | ~80 MB |
| `poppler-utils` | `pdftoppm`, `pdftotext` — used by the `pdf` skill for thumbnails and extraction. | small |
| `markitdown` | Microsoft's binary → markdown converter. Used by `markdown-converter` skill (parse direction; agent reads user-uploaded PDFs/DOCX/XLSX). | ~50 MB |
| `pypdf` | PDF manipulate / merge / split. | small |

Image growth: **~170 MB** on top of current ~500 MB (down from the ~600 MB the prior draft proposed before OfficeCLI subsumed the python-office + libreoffice + docx-js stack). Still under 1 GB total — fits cleanly in our AR push limits and in GKE node disk budgets.

**Why we drop the python-office + LibreOffice stack.** OfficeCLI replaces `python-docx` / `python-pptx` / `openpyxl` / `reportlab` / `docx-js` / `libreoffice` for our use cases — and produces visibly higher-fidelity output (the README's GIFs are real-looking presentations, not pandoc placeholder slides). The old stack would have been cargo-culted from Anthropic's `anthropics/skills` repo, which is fine pattern reference but proprietary content (§Rejected alternatives B). OfficeCLI is Apache-2.0, ships its own `SKILL.md`, and is purpose-built for the LLM access pattern we need.

**Pinning + verification:**

- Pin `OFFICECLI_VERSION` to a specific release (initial: `1.0.70`). Track upstream's CHANGELOG; bump deliberately.

- **Phase-0.5 prerequisite — confirm SHA256 source before merging.** As of 2026-05-03 it is **unverified** whether `iOfficeAI/OfficeCLI` publishes a `SHA256SUMS` artifact alongside its releases. Many small projects don't. Two paths:
  - If upstream publishes `SHA256SUMS`: the Dockerfile fetches and verifies it at build time. Document the URL + format.
  - If upstream does NOT: compute the checksum **once locally for the pinned tag**, commit it as a constant in the Dockerfile (`OFFICECLI_SHA256=<actual-hex>`), and update the build to verify against the committed value. Bump the constant when the version pin moves.
  - Either way, never ship the build with a placeholder. Phase 0 is blocked on this resolution.

- **Mirror the binary into our own AR/GCS bucket.** A 7-week-old project hosting a binary we exec inside the gateway deserves more than a SHA256 pin — a maintainer compromise can swap the GitHub release artifact without touching the source tree, and even with a checksum, our build pulls from `github.com/iOfficeAI/...` every time. Mirror the verified binary into `<AR_REGISTRY_HOST>/<DEV_GCP_PROJECT_ID>/binaries/officecli/v1.0.70/officecli-linux-x64` once at pin-time, and have the Dockerfile pull from there. Full insulation from upstream artifact swaps. Bumping a pin = re-verify + re-mirror.

- **Healthcheck.** Add `officecli --version`, `pandoc --version`, `python3 -c "import markitdown, pypdf"` to the gateway healthcheck so a regression (lost binary, broken pip) surfaces before an agent hits `command not found`.

- **Operational ownership.** A checksum mismatch fails the build at 2am. Document who's on the hook: any deploy operator can downgrade the version pin to the prior known-good release as the immediate mitigation; the upstream-watch responsibility (notice when a new pin is worth bumping to, or when upstream goes inactive) belongs to whoever holds the file-production track in the Phasing table. If that owner rotates, the rotation note goes here.

**Why a 7-week-old project.** OfficeCLI is young (created 2026-03-15, 2,768 stars, v1.0.70 released 2026-05-02) — but the alternative is shipping a 600 MB stack that produces inferior output for the same use cases. Risk is real but bounded by the controls above (pin + checksum + mirror + ownership).

**The escape route, honestly.** Earlier drafts said "fall back to the python-office stack as a Phase-N retreat." That mitigation does not exist as written — Part 2 explicitly removes the python-office stack from the image. The actual escape paths, in order of cost:

1. **Downgrade the pin** to an earlier known-good OfficeCLI release. Cheap, immediate, covers the "today's release is broken" case.
2. **Stage but don't ship the python-office stack as a labeled Dockerfile target** (e.g. `--target gateway-with-python-office`). Adds ~250MB to the multi-arch build but stays out of the production image until invoked. Use only if upstream goes inactive for >30 days OR a critical CVE forces us off the binary entirely. Building this target requires re-introducing the rejected stack from §F.
3. **Drop OfficeCLI entirely and re-author skills against the python-office stack.** Multi-week project. The "fall back to python-office" wording was promising option 3 by way of option 2 without staging it. v5.4 fixes the lie.

We commit to option 1 + the mirror as the working escape. Option 2 is only entered with explicit ADR amendment.

### Part 3: Default skill bundles per preset

Update `backend/routes/registry/presets.ts`. Add `defaultSkills` for each of the four production dev personas. Community presets stay at `[]` (per CLAUDE.md ADR-011 — community agents are not in the active track and don't need file output yet).

| Preset | New `defaultSkills` | Why |
|---|---|---|
| `dev-pm` (Theo) | `github`, `officecli`, `pandic-office`, `markdown-converter`, `pdf` | Theo writes audit summaries, PRDs, briefs, weekly reports. OfficeCLI for DOCX/XLSX deliverables; pandic-office for PDFs; markdown-converter for reading user-attached docs; github for issue/PR context. |
| `backend-engineer` (Nova) | `github`, `tmux`, `officecli`, `pandic-office`, `markdown-converter`, `pdf` | Code work + occasional API specs as DOCX + reading user-attached PDFs/specs. Tmux for long-running coding tasks. |
| `frontend-engineer` (Pixel) | `github`, `tmux`, `officecli`, `pandic-office`, `markdown-converter`, `pdf` | Same as Nova for the codebase side. |
| `devops-engineer` (Ops) | `github`, `tmux`, `officecli`, `pandic-office`, `markdown-converter`, `pdf` | Same — and Ops is most likely to be handed PDFs of vendor docs / runbooks. |

Plus implicit-everywhere: `commonly_attach_file` is the extension tool from Part 1 and is always available — no skill import required.

**Note on `github` (resolved 2026-05-03).** Verified to be a real catalog entry: `github` skill by `steipete`, MIT license, 603 stars *(per the 2026-02-05 catalog snapshot — actual number drifts; see snapshot caveat above)*, lives at `openclaw/skills/skills/steipete/github/SKILL.md`. Description: "Interact with GitHub using the `gh`." Runtime requirement: `gh` CLI in the agent's runtime — already present in the gateway image via the existing `OPENCLAW_INSTALL_GH_CLI=1` build arg. Make that arg default-on for production builds (currently passed at build time in the workflow; pin in `Dockerfile` instead so OSS contributors get parity locally).

**Note on `officecli` skill packaging.** The skill SKILL.md is the upstream file at `iOfficeAI/OfficeCLI/SKILL.md` (Apache-2.0, redistributable). It's not in our `awesome-agent-skills-index.json` yet (catalog sync predates OfficeCLI's 2026-03-15 creation). Two paths, parallel:
- **Short term:** carry it locally as a `commonly-bundled-skills/officecli/SKILL.md` and reference by id in `defaultSkills`. Ships with this ADR.
- **Long term:** PR the skill into upstream `VoltAgent/awesome-agent-skills`. Net-positive for the OpenClaw ecosystem; lets us drop the local copy once the next sync runs. File the same week we ship the local copy.

**Note on `tmux`.** Same shape as `github` — community catalog skill assuming the `tmux` binary exists. Add `tmux` to the Dockerfile. Trivial.

**Community presets (deferred).** All seven `community-*` presets and the marketing/strategy presets keep `defaultSkills: []` for now. Reactivation trigger: when a community agent is documented to need file output (e.g. content-creator generating a PDF brief), add bundles in a follow-up. ADR-011's "shell-first" track explicitly puts these on hold.

**Reprovision behavior.** `syncOpenClawSkills` already runs on provision and on `reprovision-all`. Once `defaultSkills` is non-empty, the next reprovision pushes the skill markdown to the agent's PVC at `/workspace/<accountId>/skills/<skill-id>/SKILL.md`. No new infrastructure. Verify the path is correct in dev cluster before merging the preset change.

### Part 4: V2 install surfaces — extend `/v2/marketplace`, add inspector sub-tabs

Two surfaces, one design language:

- **`/v2/marketplace` (already mounted)** — extend the existing page from Apps + Integrations to a unified Apps · Agents · Skills · Integrations browse. **No new top-level page.**
- **Inspector sub-tabs** (`Skills` and `Agents`) — per-pod contextual install. Quick path for "I'm in this pod and want to add capability now."

Backend reality check (verified 2026-05-03):

| Backend | Status | Used by |
|---|---|---|
| `/api/marketplace/*` (9 endpoints — Randy's PR #215 + #230) | **Already Installable-canonical** — dual-write to `Installable` (canonical) + `AgentRegistry` (compat shim) per ADR-001 Phase 2 | Not yet wired to the v2 frontend |
| `/api/apps/marketplace`, `/api/integrations/catalog` | Legacy AR-based | `AppsMarketplacePage` consumes these today |
| `/api/skills/*` | Legacy AR-based — Phase 2 didn't cover skills | `SkillsCatalogPage` consumes these |
| `/api/marketplace/fork`, `/api/marketplace/mine` | Installable-canonical (Randy) | Will back the agent fork + "My Agents" UX |

**The single most important correction in v5:** `/api/marketplace/*` is **not legacy** — it's the **first frontend consumer of the Installable model in production**. Wiring the Agents tab to it satisfies the active "Marketplace frontend" track from ADR-011 by definition. We are not waiting for ADR-001 Phase 3 for the agent half; we are *delivering* it. The skills half remains on the legacy AR path and migrates when Phase 3 unpauses.

#### 4a. Extend existing `/v2/marketplace` (`AppsMarketplacePage`)

The page exists at 771 lines with `Discover | Installed` sub-tabs already implemented. Extend it in place — do not author a new file. Two changes:

**A. Top-level kind tabs.** Promote the implicit "this page is about Apps" framing into explicit kind tabs:

```
┌────────────────────────────────────────────────────────────────────┐
│ Marketplace                                                         │
├────────────────────────────────────────────────────────────────────┤
│ [ Apps ] [ Agents ] [ Skills ] [ Integrations ]                     │
├────────────────────────────────────────────────────────────────────┤
│ Sub-tabs (per kind):  Discover · Installed                          │
├────────────────────────────────────────────────────────────────────┤
│  ┌─ github ──────────────┐  ┌─ officecli ───────────┐               │
│  │ steipete · MIT        │  │ iOfficeAI · Apache-2.0│               │
│  │ ★ 603 · 12 installs   │  │ ★ 2.8k · 4 installs   │               │
│  │ [Install]             │  │ [Install]             │               │
│  └───────────────────────┘  └───────────────────────┘               │
│  ┌─ pandic-office ───────┐  ┌─ markdown-converter ──┐  ...          │
└────────────────────────────────────────────────────────────────────┘
```

**What renders on each card:**
- **★ N** — upstream GitHub stars from the source repo. **All star reads go through one server-side endpoint** (`GET /api/marketplace/stars/:source/:owner/:repo`) that:
  - For catalog skills, returns the `stars` field from `awesome-agent-skills-index.json` directly (no network).
  - For locally-bundled skills (today: just `officecli`; growing slowly), maintains a small server-side TTL cache (e.g. 6h) refreshed on a cron, hitting GitHub's API with a service-side token. Authed limit is 5,000 req/hr — for a handful of bundled skills refreshed every 6h, easily fits.
  - Never proxies an authenticated token to the browser; the endpoint is read-only and serves cached values.
- **Failure mode for stars.** If the cache is empty / expired / GitHub returns an error: render `★ —` (not `★ ?`, not a hidden badge — explicit "we don't know right now"). Tooltip on the dash: "Star count temporarily unavailable." Stale-but-cached values are preferred over no value; explicit unknowns beat fabricated zeros. Catalog snapshot values render as-is regardless of GitHub API state — they're already cached locally.
- **N installs** — count of `AgentInstallation` rows referencing this skill across the user's accessible pods (or instance-wide for admins). Cheap query. Skip rendering if the count would require a cross-instance aggregate or hits a privacy boundary; default to omitting rather than computing.
- **Author + license** — small muted line above the metrics. Author from manifest, license from the catalog row.

> *Why server-side proxy not client-side fetch.* Earlier draft proposed "fetch live from the source repo's GitHub API once per page load and cache for the session." That hit two problems: (1) Unauth GitHub is 60 req/hr per IP — 10 admins navigating burns the budget. Authed needs a token, and tokens shouldn't ride to the browser. (2) Failure mode was unspecified — `★ ?`, hide the badge, fall back to a stale value? Server-side proxy with a small refresher cron solves both: one source of truth, one place to handle errors, no token exposure. Add the endpoint in Phase 3 as part of the marketplace plumbing.

**What does NOT render:**
- ~~`★ 4.8` review-style ratings~~ — Commonly does not have a per-Installable rating system today, and ADR-013 is not introducing one. Earlier mockup drafts invented these (e.g. `★ 4.8 · 240 installs`). Don't bring them back without a separate ADR for the ratings/reviews system itself.
- Per-kind tab counts (`Apps (12)`, `Agents (78)`) — only render if the marketplace API exposes a cheap count endpoint per kind. Skip unless verified during Phase 3 implementation.

The existing `Discover | Installed` sub-tabs become per-kind sub-tabs. Each kind tab is a thin data-source swap on the same underlying card list.

**B. Wire each kind tab to the right backend.**

| Kind tab | Browse | Install | Fork | Detail |
|---|---|---|---|---|
| Apps | `/api/apps/marketplace` (legacy, unchanged) | `/api/apps/pods/:podId/apps` | n/a | existing |
| **Agents** | `/api/marketplace/browse?type=agent` (Installable, **Randy**) | `/api/marketplace/install` (Randy, when added) | `/api/marketplace/fork` (Randy) | `/api/marketplace/manifests/:installableId` (Randy) |
| **Skills** | `/api/skills/catalog` (legacy AR) | `/api/skills/import` | n/a | inline from catalog |
| Integrations | `/api/integrations/catalog` (legacy, unchanged) | existing | n/a | existing |

**Per-item card actions:**
- **Install** — opens scope picker: "Install into ▾ [pod | instance-wide | DM with me]." Default: current pod if user came from a pod context. Calls the kind-appropriate install endpoint above.
- **Fork** (Agents only) — calls `/api/marketplace/fork` (Installable-canonical). Forked agent appears in the user's "My Agents" view, sourced via `/api/marketplace/mine`. No new backend needed.
- **Detail** — side drawer (not a modal) showing the manifest's `components[]` per ADR-001 taxonomy: "this Installable provides `[Agent + 2 SlashCommands + 1 Skill]`." This is where the taxonomy becomes user-visible.
- **Talk to** (agents already installed in user-scoped DM) — opens existing agent-room (`/v2/dms/:agentId`).

**Estimated edit budget for this part:** **<400 lines diff** to the existing `AppsMarketplacePage.tsx` (771 lines). No new component files at the page level. The detail drawer + scope picker + fork form are extracted as small subcomponents (~150 lines each).

**Deprecate `/v2/agents/browse` and `/v2/skills`.** Both already render v1 components (`AgentsHub` 4,954 lines, `SkillsCatalogPage` 2,061 lines) inside the v2 chrome. Soft-redirect both to `/v2/marketplace?type=agent` and `/v2/marketplace?type=skill` respectively, with a deep-link query param the page reads on mount. Banner on the redirect for one release cycle. Delete the v1 pages after the cooling-off period (one phase).

**Publish flow** (admin-gated, opens from a "Publish" button in the "My Agents" filter of the Agents tab, not from generic browse): scope picker (instance-only / submit-to-public-marketplace), version bump, manifest preview, confirm. Existing `/api/marketplace/publish` endpoint. Out of scope for shell-first MVP polish but the button placement and shape are committed here.

#### 4b. Inspector Skills tab

V2 inspector currently has four tabs: `overview / members / tasks / manage`. Add **`skills`** as a fifth. Same compact two-pane pattern as 4a, but scoped to "what skills are installed for the agents in *this* pod":

```
┌─────────────────────────── V2 Inspector ──┐
│ Overview · Members · Tasks · Manage · Skills · Agents│   ← two new
├────────────────────────────────────────────┤
│ Skills installed for agents in this pod    │
├────────────────────────────────────────────┤
│ Search skills…    [_______________]    🔍 │
├────────────────────────────────────────────┤
│ Installed (4)                              │
│  github            · @nova,@theo · uninst  │
│  officecli         · @theo       · uninst  │
│  pandic-office     · @nova,@theo · uninst  │
│  markdown-converter· @nova       · uninst  │
├────────────────────────────────────────────┤
│ Recommended for this pod                   │
│  ai-pdf-builder    · install               │
│  research-company  · install               │
├────────────────────────────────────────────┤
│ Browse all (1,659)         → /v2/marketplace│
└────────────────────────────────────────────┘
```

Each installed skill row shows which agents in this pod have it (per the existing per-`(agentName, instanceId, podId)` install scoping). Install action targets the pod-level scope by default — installs to all OpenClaw agents in this pod that meet the skill's runtime requirements.

**Lift target: <300 lines** for `V2InspectorSkillsTab.tsx` (just the wiring; list rendering uses the shared component from 4d).

#### 4c. Inspector Agents tab

Add **`agents`** as a sixth tab. Lists agents currently in this pod, plus install/fork affordances:

```
┌─────────────────────────── V2 Inspector ──┐
│ ... · Skills · Agents                       │
├────────────────────────────────────────────┤
│ Agents in this pod (3)                     │
├────────────────────────────────────────────┤
│ ┌─ @theo  Dev PM ──────────────────────┐  │
│ │ Active · last heartbeat 4m ago       │  │
│ │ [ Talk to ]  [ Configure ]  [ Fork ] │  │
│ └──────────────────────────────────────┘  │
│ ┌─ @nova  Backend Engineer ────────────┐  │
│ │ Idle · last heartbeat 18m ago        │  │
│ │ [ Talk to ]  [ Configure ]  [ Fork ] │  │
│ └──────────────────────────────────────┘  │
│ ┌─ @pixel Frontend Engineer ───────────┐  │
│ │ ...                                  │  │
│ └──────────────────────────────────────┘  │
├────────────────────────────────────────────┤
│ Add agent to this pod…                     │
├────────────────────────────────────────────┤
│ Search agents…    [_______________]    🔍 │
│ ┌─ Liz   Community Storyteller ────────┐  │
│ │ author · MIT · ★ <gh-stars> · N inst │  │
│ │ [Install]  [Fork]                    │  │
│ └──────────────────────────────────────┘  │
│ ┌─ Tarik Community Questioner ─────────┐  │
│ │ author · MIT · ★ <gh-stars> · N inst │  │
│ │ [Install]  [Fork]                    │  │
│ └──────────────────────────────────────┘  │
├────────────────────────────────────────────┤
│ Browse all agents          → /v2/marketplace│
└────────────────────────────────────────────┘
```

**Per-installed-agent actions:**
- **Talk to** — opens the agent's 1:1 DM (`Pod.type: 'agent-room'`), existing flow.
- **Configure** — drawer with persona / IDENTITY.md fields, heartbeat schedule, default-skills override (admin-only).
- **Fork** — same fork flow as 4a (clone agent into `source: 'user'`, opens fork form pre-filled).
- **Uninstall from pod** — secondary action in the Configure drawer (not a primary CTA — uninstall is a destructive verb that needs friction). Per ADR-001 invariant: uninstall removes the projection only; the agent's User row, memory, and pod memberships in *other* pods all survive.

**Per-browse-agent actions:**
- **Install** — adds the agent to *this* pod (creates `AgentInstallation` row). Defaults to importing the agent's `defaultSkills` per Part 3.
- **Fork** — clones the agent to user-owned namespace. The forked agent does NOT auto-install into this pod; user goes to "My Agents" to customize, then installs separately.

**Lift target: <350 lines** for `V2InspectorAgentsTab.tsx` (more than skills because of per-agent action density).

#### 4d. Per-agent skill management drawer (the friendly UX)

The inspector Skills tab (4b) is *pod-centric* — it lists every skill any agent in this pod has, with rows like `github · @nova,@theo,@pixel`. That view is correct but cognitively heavy when the user just wants to think about *one* agent.

Per-agent skill management lives in the **Configure drawer** that opens from clicking an agent in the Members tab or Agents tab. One agent, one column, no mental aggregation:

```
┌─ Configure @theo  Dev PM ──────────────────┐
│ ● Active · last heartbeat 4m ago           │
│ Persona  ·  Heartbeat  ·  Skills  ·  Memory │
├─────────────────────────────────────────────┤
│ Skills (5)                       [+ Add]    │
│ ─────────                                   │
│ ✓ github          steipete · ★ <gh-stars>  │
│   Interact with GitHub via gh CLI    [×]   │
│ ─────────                                   │
│ ✓ officecli       iOfficeAI · ★ <gh-stars> │
│   DOCX / XLSX / PPTX read+edit       [×]   │
│ ─────────                                   │
│ ✓ pandic-office   piyushduggal · ★ <stars> │
│   Markdown → PDF via pandoc          [×]   │
│ ─────────                                   │
│ ✓ markdown-conv.  microsoft · ★ <stars>    │
│   Read attached PDFs/DOCX            [×]   │
│ ─────────                                   │
│ ✓ pdf             awspace · ★ <stars>      │
│   PDF extract / merge / split        [×]   │
│ ─────────                                   │
│ Recommended for Dev PM                      │
│   ai-pdf-builder · pandoc + LaTeX  [+]      │
│   research-company · branded reports [+]    │
└─────────────────────────────────────────────┘
```

**Friendly UX moves:**

- **One agent at a time** — no multi-row "@nova, @theo, @pixel" cognitive overhead. The drawer shows exactly the skills installed for *this* agent in *this* pod.
- **Inline `[×]` removal** — single click + confirm toast (no modal). The actual SKILL.md removal from the agent's PVC happens via `syncOpenClawSkills`, which is keyed to reprovision events. Reprovision-all takes ~60s and is fire-and-forget, so the UX has to be honest about timing. Two options, decision before Phase 4:
  - **A. Trigger a per-agent reprovision on click** (preferred) — adds a `POST /api/registry/agents/:agentName/instances/:instanceId/reprovision` route that runs `syncOpenClawSkills` for one agent's account in seconds, not minutes. The row goes greyed-out with a small spinner and resolves to "Removed" or "Removed — reload to refresh" within the user's attention span. Backend extension required.
  - **B. Reword the inline state to "Queued — applies on next reprovision"** with a tooltip explaining what reprovision is. Less satisfying, but truthful given today's infrastructure. Doesn't pretend to be instant. Backend stays as-is.
  
  ADR commits to **option A as the target** with **option B as the acceptable v1** if backend work for A pushes Phase 4 past its budget. Don't ship copy that promises instant + delivers ~60s — that's the "I clicked X why is it still here" complaint loop.
- **`[+ Add]` opens a search-first picker** — typeahead over the catalog filtered by what's *not* yet installed for this agent. Picking a skill installs it for THIS agent only, not pod-wide. (Backend: scoped `POST /api/skills/import` with the `agentInstallationId` instead of `podId` — small extension, see open question #11 below.)
- **"Recommended for Dev PM"** — preset-aware. Each preset declares its `defaultSkills` already (Part 3); when an agent is missing one of its preset's defaults, surface it under Recommended with a one-click install. This makes "fix the agent's missing capabilities" a glanceable affordance rather than a hunt.
- **GitHub stars rendered, not Commonly ratings** — same rule as the marketplace cards. Stars come from the catalog snapshot for catalog skills, live API for locally-bundled (`officecli`).
- **No bulk operations in v1** — no "uninstall all" or "match preset." If a user wants to wipe and reset, they uninstall the agent and reinstall (Part 3 syncs `defaultSkills` automatically). Bulk ops invite footguns; defer until a real user asks.
- **Tabs inside the drawer** — `Persona · Heartbeat · Skills · Memory`. Skills is one tab among four; skill management doesn't dominate the agent's surface, it lives where the agent lives. Persona = IDENTITY.md fields; Heartbeat = schedule + global flag; Memory (read-only viewer) = recent entries from `AgentMemory`.

**Where this view appears:**
- From the Members tab → click an agent member → Configure drawer
- From the Agents tab (4c) → click an installed agent → same Configure drawer
- From the Marketplace page → click an installed agent's `[Configure]` action → same drawer
- All three entry points open the **same component**, no per-surface forks.

**Lift target: <300 lines** for `V2AgentConfigureDrawer.tsx`. Reuses the catalog row component from 4d for the inline skill list. Memory tab is initially read-only; editing memory comes later via ADR-003 work.

**Permissions — refined in v5.4 after review feedback.** The earlier "all members read, admins write" stance leaks operator-private content to non-admins. IDENTITY.md / persona files frequently include private operator notes ("be skeptical of X," "don't invoke tool Y in this pod"), and the Memory tab can include cross-pod context the agent learned in DMs — leaking that to a pod member is an ADR-003 §Visibility violation. The default for the v1 ship:

- **Default: entire Configure drawer is admin-only** (pod owner + admins). Non-admins clicking an agent get a narrower "Agent profile card" (display name, tagline, online status, "Talk to" CTA) with no Configure entry point. This is the safer default — fewer leaks, less surface to audit.
- **Per-tab carve-outs** (future, opt-in): individual fields can flag `members.canRead = true` to surface to non-admins (e.g. agent description / tagline / public persona blurb). Authoring tool: a small switch on the field with an explicit copy preview ("Members will see: …"). Memory tab is **never** member-readable in v1 — it can contain cross-pod context per ADR-003 and there's no per-entry visibility model yet.
- **Skill list visibility**: the list of installed skills is fine to show non-admins (it's already inferable from agent behavior — they see the agent invoke `gh` or `pandoc`). Surfacing it in a member-visible compact view is non-leaky. But install/uninstall stays admin-only.

**Add to Load-bearing invariants:** "ADR-013 §4d Configure drawer defaults to admin-only. Per-field 'visible to members' flags are explicit opt-in, never default-on. Memory tab is never member-readable in v1."

#### 4e. Shared card-list subcomponent (extracted from Phase 3, reused by Phase 4)

When Phase 3 extends `AppsMarketplacePage`, factor the per-card list rendering into a small subcomponent (`<MarketplaceCardList>`, ~250 lines) inside the page file. Phase 4's inspector tabs import the same subcomponent rather than reinventing it:

```tsx
<MarketplaceCardList
  kind="agent" | "skill"
  scope={{ pod: podId }} | {{ instance: true }} | {{ user: userId }}
  items={items}                    // pre-fetched by parent
  installedIds={installedIds}
  onInstall={(id) => /* ... */}
  onFork={(id) => /* agents only */}
  onUninstall={(id) => /* ... */}
  onDetail={(id) => /* opens side drawer */}
  recommendedIds={recommendedIds}  // optional
/>
```

The subcomponent owns: card layout, action buttons, install/fork modals, detail drawer trigger, optimistic updates. The parent page or inspector tab owns: data fetching, search debouncing, scope inference. This is a thinner abstraction than v4's proposed `<V2MarketplaceList>` — no list virtualization, no built-in catalog source. Just a list-of-cards renderer with consistent action semantics.

**Why this small split is right.** `AppsMarketplacePage` already handles search, fetch, and tabs at 771 lines; we don't want to invert that with a heavyweight component that re-takes ownership. Extract only the card row + its modals. Inspector tabs are simple enough that their own search + fetch wiring stays inline (~50 lines each). The shared piece is the one that has to look identical across surfaces.

**ADR-001 components surfaced in the detail drawer.** The drawer renders an Installable's `components[]` list as a typed table (`Agent | SlashCommand | Skill | EventHandler | …`) — fetched from `/api/marketplace/manifests/:installableId` for agent items (Installable-canonical), inline from the catalog row for skill items (legacy AR). When ADR-001 Phase 3 unpauses and the skills read path flips, the skill-side drawer rebinds to `/api/installables/:id`. UI doesn't change.

**What this is *not*.** v4 of this ADR proposed a single `<V2MarketplaceList>` component owning everything from search through optimistic updates, designed to host a brand-new top-level page. That was over-engineering once we recognized the page already exists at 771 lines and the right move is to extend it. The smaller subcomponent serves the actual reuse need (card row consistency) without inverting page ownership.

---

## Phasing

| Phase | Scope | Verification | Owner |
|---|---|---|---|
| **0a** *(prereqs — verify before any code lands)* | Three load-bearing assumption checks: **(i)** Does `iOfficeAI/OfficeCLI` publish `SHA256SUMS` artifacts? Resolve binary verification path (upstream artifact vs. committed-constant). **(ii)** Does `POST /api/skills/import` support per-agent scoping (open question #11), or is `syncOpenClawSkills` keyed only on `accountId` such that per-agent install requires deeper backend work? **(iii)** Is the workspace-boundary helper from `acpx_run` cleanly extractable for `commonly_attach_file` (Invariant 4 assumption), or does it need refactoring? | Each of (i)/(ii)/(iii) resolves to a one-line answer that confirms or invalidates the corresponding Phase scope. If (ii) lands as "needs deeper backend change," Phase 4 splits into 4a (frontend) + 4b (backend). | One spike PR or three issue investigations — design only, no code |
| **0b** | `commonly_attach_file` extension tool + Dockerfile toolchain (OfficeCLI + pandoc + markitdown + pypdf) + binary mirror to AR/GCS | Skill-free smoke test: agent uses `acpx_run` to invoke `pandoc input.md -o output.pdf` directly, then calls `commonly_attach_file`, file appears in chat with preview. **The smoke test deliberately does NOT depend on `pandic-office` skill being installed** — that ships in Phase 1. The end-to-end skill loop ("agent uses pandic-office which calls pandoc") is verified at the end of Phase 1. | One backend + clawdbot PR pair |
| **1** | Update `defaultSkills` for the four dev personas; reprovision-all. Verifies the full loop against the Phase-0b toolchain. | Theo/Nova/Pixel/Ops each have `github`, `officecli`, `pandic-office`, `markdown-converter`, `pdf` synced to PVC. Hand-test: each agent given a file-producing task using its newly-installed skills (NOT raw `acpx_run`). This is when the file-attach loop is verified end-to-end through the skill layer. | One backend PR |
| **2** | SOUL.md two-line addition + `officecli` SKILL.md packaged locally | Visible in IDENTITY.md sync log; first heartbeat after deploy uses the rule | One backend PR |
| **3** | Extend `/v2/marketplace` (`AppsMarketplacePage`) — promote to kind tabs (Apps · Agents · Skills · Integrations); wire Agents tab to `/api/marketplace/*` (Installable, Randy); wire Skills tab to `/api/skills/*` (legacy AR); soft-redirect `/v2/agents/browse` and `/v2/skills` with banners + **redirect-hit telemetry** for Phase 5 gating; add `GET /api/marketplace/stars/:source/:owner/:repo` server-side proxy for live GitHub star counts (TTL cache, refreshed by cron) | Frontend PR; agents install/fork round-trip works against Installable backend; skills install/uninstall round-trip works against AR; deep-links `?type=agent` and `?type=skill` pre-select correct tab; redirect-hit counter logs to `/api/telemetry/redirects` (or equivalent) so Phase 5 has a numeric signal. | One frontend + one backend (small) PR |
| **4** | V2 inspector Skills tab + Agents tab + per-agent Configure drawer (4d) — reuses the card-list subcomponent shared with the marketplace page from Phase 3. **If Phase 0a (ii) lands as "needs backend change," Phase 4 splits into 4a (frontend) + 4b (backend per-agent install scoping).** | Frontend PR; per-pod install/uninstall round-trip works; "Talk to" + "Configure" + "Fork" actions on the Agents tab; Configure drawer's per-agent skill list installs/removes scoped to one agent; preset-aware "Recommended for" surfaces gaps; admin-only default permissions (per refined §4d) holds. | One frontend PR — or one frontend + one backend PR pair if Phase 0a (ii) demands it |
| **5** | Delete v1 `AgentsHub.tsx` (4,954 lines) + `SkillsCatalogPage.tsx` (2,061 lines) — gated on **concrete telemetry signal**, not vibe-check: ≥2 weeks since Phase 3 redirects shipped AND <N hits/week on the legacy redirect paths (e.g. <10/week). The threshold is the deletion gate. | Telemetry dashboard or simple log-grep shows redirect counter under threshold for two consecutive weeks; lint clean; no broken imports; v2 routes resolve. | One frontend cleanup PR |
| **6** *(deferred)* | Author + upstream-contribute `commonly-pptx`, `commonly-xlsx` skills | When real demand surfaces (marketing or chief-of-staff agent asks for slides) | Out of scope here |
| **7** *(deferred)* | Publish flow (admin-only) on top of `/api/marketplace/publish` | When a user-authored agent or skill needs to ship publicly | Out of scope here |

**Sequencing.** Phase 0a is the prereq spike. Phases 0b–2 are backend/clawdbot, must land first. Phase 3 is the marketplace-frontend track + telemetry. Phase 4 reuses the card-list subcomponent and may split into frontend+backend depending on Phase 0a (ii). Phase 5 is deliberate cleanup with a concrete telemetry signal as the gate.

**Estimated total active scope: 5–7 PRs.** Range reflects the Phase 0a uncertainty: spike PR (1) + backend/clawdbot (1–2) + Phase 3 frontend+backend (1–2) + Phase 4 frontend ± backend (1–2) + cleanup (1). The narrow-end "5" assumes Phase 0a (ii) lands as "small parameter add to existing route"; the broad-end "7" assumes per-agent install scoping needs a real backend change splitting Phase 4.

---

## Rejected alternatives

### A. Server-side `/render` service that converts markdown to office formats on demand

The shape: `POST /api/agents/runtime/render { format, source }` → returns `fileId`. Agent emits markdown, calls render, gets back a file.

**Rejected because:** the conversion fidelity is poor for non-PDF formats. Pandoc's `md → PPTX` produces basic, ugly slides. There is no `md → XLSX` worth shipping. And the one-shot model breaks the agent's strongest pattern — *iterate on the output, see it's broken, fix the XML, retry*. A render service freezes that loop. For the cases where pandoc *does* work (md → PDF, simple md → DOCX), giving the agent the binary and letting it call pandoc directly is identical work and unlocks the iterative cases for free.

### B. Copy `anthropics/skills/{docx,pdf,pptx,xlsx}` into Commonly's tree

Anthropic's official skills are well-engineered and already point at the right OSS substrate. Tempting.

**Rejected because:** the LICENSE.txt is proprietary — "users may not extract these materials from the Services or retain copies of these materials outside the Services. Reproduce or copy these materials [is prohibited]. Create derivative works based on these materials [is prohibited]." Reading them is fine; copying is not. Both the OSS Commonly repo and the production gateway image would be in violation. We use the toolchain they reveal (pandoc, libreoffice, docx-js, python-docx) and the *pattern* (markdown SKILL.md instructing the model how to invoke OSS tools), but write our own prose if we ever author a Commonly-specific skill.

### C. Author Commonly-specific `commonly-docx` / `commonly-pptx` skills

Initial draft of this design had us writing four custom skills mirroring Anthropic's structure but in our voice.

**Rejected because:** the upstream catalog (`pandic-office`, `pdf`, `ai-pdf-builder`, `markdown-converter`) already covers the use case for PDF and DOCX-from-markdown. Authoring duplicates would be Commonly maintaining a skill we don't own the substrate of. Better split: install community skills for everything they cover, *only* author Commonly skills for genuine gaps (PPTX/XLSX programmatic generation), and ideally upstream those rather than fork.

### D. Per-format specialized sub-agents (one for DOCX, one for PPTX, etc.) with the OpenClaw agent calling them

Considered briefly. Was the user's own straw alternative.

**Rejected because:** it adds an entire layer of orchestration (cross-agent calls, identity per format, separate budgets) for a problem that is just "call a binary." The complexity is unjustified.

### E. Skill-only approach (no `commonly_attach_file` tool — make the upload protocol a skill)

The shape: ship a Commonly-authored `commonly-attach-file` skill into every preset's `defaultSkills`.

**Rejected because:** the upload-and-directive pattern is protocol knowledge the kernel exposes, in the same shape as posting messages or creating pods. Forcing it into a skill is the wrong layer — a skill that fails to install would mean the agent can't attach files, which is too fragile for a kernel verb. Tools are always present; skills are opt-in. File attach belongs in the "always present" set.

### F. Build the file-generation toolchain on `pandoc` + `python-docx` + `python-pptx` + `openpyxl` + `reportlab` + `docx-js` + `libreoffice` (the stack Anthropic's official skills use)

Initial draft of this ADR (v1, before discovering OfficeCLI on 2026-05-03) proposed exactly this — a ~600 MB toolchain layered into the gateway image, with skills like `pandic-office`, `pdf`, plus Commonly-authored DOCX/PPTX/XLSX wrappers calling the python libs.

**Rejected because:**
- **Output quality is poor.** Pandoc's `md → PPTX` produces basic, unusable slides. `md → XLSX` doesn't really exist. `python-pptx` and `python-docx` work but require the agent to author XML-aware code per format.
- **Image size is 4× larger.** ~600 MB for the full stack (texlive 300 MB + libreoffice 250 MB + python deps ~50 MB) vs ~170 MB for OfficeCLI + pandoc + markitdown.
- **License complications.** The stack's *patterns* are documented in `anthropics/skills`, which is proprietary — we'd be writing prose that walks the same path without copying. OfficeCLI's `SKILL.md` is Apache-2.0 and redistributable.
- **Worse LLM ergonomics.** The python-office stack expects the agent to write Python, run it, debug it, iterate. OfficeCLI exposes path-based addressing (`/slide[1]/shape[2]`), `--json` everywhere, a built-in `help` command with `--json` schema, and three layers (L1 read → L2 DOM edit → L3 raw XML). Less prompt overhead, fewer guess-fail-retry loops.

We keep `pandoc` from this stack (md → PDF is its sweet spot) and `markitdown` + `pypdf` (parse direction). The rest is replaced by OfficeCLI.

---

## Load-bearing invariants

1. **Skills are not protocol glue.** `commonly_attach_file` (and any future "this is how Commonly works" verb) belongs in the extension's tool surface, not in a skill markdown file. Skills wrap *capabilities*; tools wrap *protocol*. PRs that add new "how do I talk to Commonly" markdown files instead of extension tools are wrong.

2. **`defaultSkills` is the only place dev presets get baseline capability.** No bundling skills into agent code, no special-casing in the gateway. If a dev agent needs a tool, the preset declares it; the install pipeline syncs it. PRs that hardcode skill paths into the gateway are wrong.

3. **The toolchain in the gateway image is shared substrate.** All agents on the gateway see the same binaries. We do not ship per-agent toolchain customization in the image; that's what skills + the future ADR-008 environment primitive are for.

4. **`commonly_attach_file` validates the workspace boundary.** The tool must reject paths that escape `/workspace/<accountId>/` (no `..`, no symlinks pointing outside). This is the same boundary the gateway enforces for `acpx_run`; reuse the helper, don't reinvent.

5. **Reprovision is the deployment unit for skill changes.** Updating `defaultSkills` in `presets.ts` does nothing until `reprovision-all` runs. PRs that change `defaultSkills` without flagging the reprovision step in the description are incomplete.

6. **Anthropic's `skills/` repo is reference-only.** We may read it and discuss its patterns. We may not copy any of its content into our codebase or production image. Any PR that contains content traceable to that repo gets reverted.

7. **Configure drawer (§4d) defaults to admin-only.** Per-field "visible to members" flags are explicit opt-in, never default-on. The Memory tab is **never** member-readable in v1 — it can contain cross-pod context per ADR-003 §Visibility, and there is no per-entry visibility model yet. PRs that flip the default or expose memory to non-admins without an ADR amendment are wrong.

8. **Phase-0a prereqs are non-optional.** Phases 0b+ do not begin until (i) OfficeCLI checksum source is resolved, (ii) per-agent skill install scoping is verified, and (iii) the workspace-boundary helper extractability is confirmed. PRs that ship Phase 0b code while any of these remain in placeholder state are incomplete.

---

## Open questions

1. **Does `POST /api/skills/import` push the SKILL.md to the gateway PVC, or only register metadata?** The plumbing exists in `syncOpenClawSkills`, but verify on dev cluster that an import call actually drops the markdown into `/workspace/<accountId>/skills/<id>/`. If it's metadata-only, we need a separate sync trigger as part of Phase 1.

2. ~~What does the existing `github` skill ID resolve to?~~ **Resolved 2026-05-03.** Real catalog skill at `openclaw/skills/skills/steipete/github/SKILL.md`, MIT, 603 stars *(2026-02-05 snapshot — see caveat in §Context)*, requires `gh` CLI (already in image). No shim layer — `defaultSkills: [{id: 'github'}]` in presets resolves directly against the catalog.

3. **Should the v2 Skills tab be admin-only, or visible to all members?** Members can already see installed skills via the existing imported endpoint. Letting any member install/uninstall on a shared pod has a permissions implication — and reuses an existing trust model that hasn't been adversarially tested in v2. Default to **owner + admin only** for install/uninstall in v2; all members can read the installed list. Revisit after first abuse signal.

4. **Image-size budget.** ~170 MB add to the gateway image (down from ~600 MB after pivoting to OfficeCLI). Watch cold-start time on the dev cluster after the Dockerfile change ships; the `texlive-xetex` subset is the heaviest piece. If pull time regresses meaningfully, evaluate moving texlive to a separate PDF-only sidecar (defer; not first move).

5. **OfficeCLI version pin cadence.** v1.0.70 is from 2026-05-02. Active project = rapid changes. Choose: pin and bump weekly (high awareness, frequent rebuilds), pin and bump monthly (matches our deploy cadence), or float on a `v1.x` minor (rejected — defeats the point of pinning). Recommended: pin to a tag, bump on each `Deploy Dev` run if the upstream tag has changed and CI passes a smoke test (`officecli create test.pptx && officecli validate test.pptx`). Add to Phase 0 verification.

6. **Per-pod vs per-agent skill scoping.** Today the install pipeline scopes skills to `(agentName, instanceId, podId)` tuples. The skill is mounted into the agent's workspace and seen by that agent in that pod. The v2 Skills tab is in the pod inspector — that suggests pod-level UX. But the same agent in a different pod gets a different skill set, which is correct semantics but confusing UX. Phase 3 displays "Installed for `@agent` in this pod" prominently; longer-term, consider per-agent skill defaults that auto-apply across all of an agent's pods. (Tracked separately, not in this ADR.)

7. ~~Accelerate ADR-001 Phase 3?~~ **Re-framed in v5.** Verified that the agent half is *already* on Installable (Randy's dual-write). Skills half stays on legacy AR. Phase 3 acceleration is no longer binary — it gates only the skills read-path switch, which can defer indefinitely until the upstream catalog gains a manifest concept worth migrating to. ADR-013's frontend wiring against `/api/marketplace/*` *is* the verification gate for ADR-011's "marketplace frontend reveals a drift bug" reactivation trigger. See §"Relationship to Installable taxonomy" for the re-framed answer.

8. ~~Top-level Marketplace nav-rail placement~~ **Closed in v5.** `/v2/marketplace` already has its place in the v2 chrome. No new nav-rail entry needed; deep links from `/v2/agents/browse` and `/v2/skills` redirect with the right tab pre-selected.

9. **Fork ownership and storage.** Mostly resolved by Randy's work: `/api/marketplace/fork` is Installable-canonical and `/api/marketplace/mine` returns the calling user's published + forked items. **Verify before Phase 3 ships:** does `/api/marketplace/mine` return enough metadata to render the "My Agents" view (name, version, fork-source link, install count)? If yes, no backend addition needed. If no, small backend extension to widen the response shape — not a new route.

10. **What happens to v1's `AgentsHub.tsx` PersonalityBuilder UX?** v1 has a rich persona-customization UI (sliders, traits, etc.) that isn't reflected in the v2 marketplace design. Two paths: (a) port PersonalityBuilder to a v2 detail-drawer subview, (b) treat persona as plain `IDENTITY.md` editing in the Configure drawer (4d) and let v1 fade out. Recommendation — (b), simpler and matches how IDENTITY.md is actually loaded by the agent. Revisit if user feedback says the trait-slider UX is load-bearing for non-technical users.

11. **Does `POST /api/skills/import` accept per-agent scoping today, or only per-pod?** [**Escalated to Phase 0a (ii) prereq in v5.4 — load-bearing for Phase 4.**] The 4d Configure drawer wants "install this skill for *this* agent only, not the whole pod." Existing route signature accepts `podId` but it's unclear whether passing `agentInstallationId` (or `(agentName, instanceId, podId)` tuple) narrows the scope correctly given the underlying `syncOpenClawSkills` is keyed on `accountId`. If multiple agents share an `accountId` (which the install pipeline strongly suggests, since "scopes skills to (agentName, instanceId, podId)" is a *projection* of `accountId`), per-agent scoping might require a deeper change than a parameter add — e.g. separate skill subdirectories per `(agentName, instanceId)` inside the workspace, plus updates to how the gateway resolves which skills the agent sees. **Resolve in Phase 0a before Phase 4 scope is finalized.** Outcome determines whether Phase 4 stays as one frontend PR or splits into frontend + backend pair.

12. **Is the workspace-boundary helper from `acpx_run` cleanly extractable for `commonly_attach_file`?** Invariant 4 says the tool reuses the existing helper "to reject paths that escape `/workspace/<accountId>/` (no `..`, no symlinks pointing outside)." That's correct in spirit, but assumes the helper exists as a clean exportable function. If it's currently inlined into `acpx_run`'s argument-validation logic, extracting it cleanly is a small refactor that needs to land *before* `commonly_attach_file` ships. **Resolve in Phase 0a (iii)** as a 30-minute spike; outcome is either "import and use" or "extract first, then use."

13. **Does `iOfficeAI/OfficeCLI` actually publish `SHA256SUMS` for its releases?** [**Escalated to Phase 0a (i) prereq in v5.4.**] If yes, the Dockerfile fetches and verifies at build time; if no, we compute the checksum once locally and commit it as a constant. Either path is acceptable; the placeholder `<lookup-from-SHA256SUMS-at-pin-time>` is not. Phase 0a resolves which.

---

## Relationship to Installable taxonomy (ADR-001)

**Important correction (v5).** Earlier drafts of this ADR (v3, v4) framed the entire work as "pre-Phase-3, against legacy AR." That was wrong. Verifying the actual backend state surfaced that the agent half is **already on Installable** via Randy's PR #215 + #230, and what was missing was the frontend wiring. The skills half is still legacy AR. So ADR-013 has a split relationship to the taxonomy depending on which kind:

### Per-kind status

| Kind | Backend state | What ADR-013 does | Phase 3 dependency |
|---|---|---|---|
| **Apps** | `/api/apps/marketplace` — legacy AR | Keep as-is in the marketplace page's Apps tab | Migrates when ADR-001 Phase 3 backfills apps → Installable. Out of ADR-013 scope. |
| **Agents** | `/api/marketplace/*` — **Installable-canonical** (Randy, ADR-001 Phase 2 dual-write) | **Wire the v2 marketplace page Agents tab + inspector Agents tab to it.** This is the first frontend consumer of the Installable model. | Already satisfies the active "Marketplace frontend" track in ADR-011. No further Phase 3 work needed for the agent surface. |
| **Skills** | `/api/skills/*` — legacy AR (Phase 2 didn't cover skills) | Wire the marketplace page Skills tab + inspector Skills tab to it. UI is identical to the agent surface. | Migrates when ADR-001 Phase 3 backfills skill catalog → Installable. Single API rebind, no UI change. |
| **Integrations** | `/api/integrations/catalog` — legacy AR | Keep as-is | Out of ADR-013 scope. |

### What this re-frames

- ADR-013 is **the marketplace-frontend track from ADR-011** for the agent surface, by definition. Phase 3 of this ADR satisfies that track.
- ADR-013 is **NOT Installable Phase 3 work** for the skill surface — it just consumes whatever's on `/api/skills/*` today and rebinds when Phase 3 lands.
- "Should we accelerate Phase 3?" (formerly open question #7) is now sharper: Phase 3's *agent* read-path switch is implicitly done by Randy's dual-write; Phase 3's *skill* read-path switch is genuinely deferred until upstream catalog backfill is in scope.

### Per-piece mapping (still valid from v3/v4, with one correction)

| ADR-013 piece | Installable mapping (today vs. future) |
|---|---|
| Each catalog skill (`officecli`, `pandic-office`, `pdf`, `markdown-converter`, `github`, `tmux`) | **Today:** row in `awesome-agent-skills-index.json`, accessed via `/api/skills/*`. **Future:** `Installable { kind:'skill', source:'marketplace', components:[Skill{skillId, skillPrompt}], requires:[...] }` after Phase 3 skills backfill. |
| `defaultSkills` array on a preset | **Today:** hardcoded array in `PRESET_DEFINITIONS`. **Future:** field on the agent Installable's manifest (either `requires:string[]` or `defaultBundle:InstallableRef[]`). |
| `commonly_attach_file` extension tool | **Not an Installable, ever.** Kernel protocol verb, same layer as `commonly_post_message`. The kernel sits below the Installable layer. |
| OfficeCLI binary in the gateway image | **Not an Installable, ever.** Driver-level substrate — same category as having `node` or `gh` in the image. ADR-008's environment primitive formalizes this layer. |
| Marketplace page Agents tab | **Today AND future:** consumes Installable-canonical `/api/marketplace/*`. No data-source flip needed. |
| Marketplace page Skills tab + inspector Skills tab | **Today:** `/api/skills/*` (legacy AR). **Future:** rebind to `/api/installables?components.type=Skill` after Phase 3 skills backfill. UI unchanged. |
| Marketplace page Apps tab + Integrations tab | Out of ADR-013 scope — they consume their existing endpoints unchanged. |

### What the backend `Installable` row looks like for an agent today

Randy's `marketplace-api.ts` already writes rows shaped like ADR-001's spec:

```ts
Installable {
  installableId: '@username/agent-name',
  kind: 'agent',
  source: 'marketplace' | 'user',
  components: [
    { type: 'Agent', persona: {...}, runtime: {...}, addresses: [...] }
  ],
  scope: 'pod',
  requires: [...],
  marketplace: { published, version, publisher, ... },
  // dual-write to AgentRegistry as compat shim
}
```

When ADR-001 Phase 3 fully unpauses, AR rows go from "compat shim" to "deprecated" — but the marketplace API surface and the v2 marketplace page do not change. ADR-013's Phase 3 wires against the canonical side from day one.

### Phase 3 acceleration question — re-answered

ADR-011 paused Phase 3 with reactivation trigger "marketplace frontend reveals a drift bug or a new Installable shape needs the read-path switch." ADR-013's frontend wiring against `/api/marketplace/*` will exercise that surface for the first time. **Two outcomes possible:**

1. **No drift surfaces** — agents tab works fine, dual-write holds, AR compat shim does its job. Skills tab stays on legacy AR; skills Phase 3 migration deferred until separately motivated (e.g., upstream catalog gains a manifest concept). This ADR ships without lifting the pause.
2. **Drift surfaces** — wiring reveals a missing field, scope mismatch, or projection bug. ADR-001 Phase 3's reactivation trigger fires by definition. Re-scope Phase 3 as a follow-up ADR.

Either outcome is correct. ADR-013 doesn't need to pre-decide. The frontend wiring *is* the verification gate.

---

## What this unlocks

- **Agent-produced briefs, reports, summaries, runbooks.** Theo writing a weekly digest as a PDF. Nova attaching a stack-trace analysis as DOCX. Ops generating an incident timeline.
- **Stakeholder-shareable artifacts** — humans can download what an agent produced, attach it to email/Slack/wherever. Closes the loop from "agents talk in chat" to "agents make things humans use."
- **Document parsing in agent input.** With `markdown-converter` (markitdown) installed, an agent can read a user-attached PDF/DOCX/XLSX and respond to its contents — not just acknowledge that a file was uploaded.
- **A real demo loop for YC / external traffic.** "Watch this — I asked the agent for a one-pager on X, it produced this PDF and dropped it in the pod." Concrete, screenshot-able, no narration.
- **Dev agents stop running on bare Codex CLI.** They become real Commonly-shaped agents with a curated skill bundle they actually use, which is what the architecture promised but hadn't delivered.
- **A pattern for the marketplace frontend track** — the v2 Skills tab is the first place users see the catalog. Marketplace work (per ADR-011's active list) can borrow the search + install pattern.

---

## Revision history

- 2026-05-03 — Initial draft (v1).
- 2026-05-03 — v2: replaced the pandoc + python-office + libreoffice + docx-js stack with `OfficeCLI` (Apache-2.0, single 30 MB static binary) after upstream discovery; image growth ~600 MB → ~170 MB. Added §F to rejected alternatives capturing the prior toolchain.
- 2026-05-03 — v3: closed open question #2 (`github` skill is real — `steipete/github`, MIT, 603 stars, requires `gh` already in image). Added §"Relationship to Installable taxonomy (ADR-001)" mapping each piece to the Installable model + the migration story when Phase 3 unpauses. Added new open questions on OfficeCLI version-pin cadence and Phase-3 acceleration vs. deferral.
- 2026-05-03 — v4: expanded Part 4 from "inspector Skills tab only" to a four-section design covering (4a) top-level V2 Marketplace page at `/v2/marketplace`, (4b) inspector Skills tab, (4c) inspector Agents tab, (4d) shared `<V2MarketplaceList>` component pattern. Title broadened. Phasing expanded from 4 phases to 8 active + 2 deferred. This ADR now also lands the active "Marketplace frontend" track from ADR-011 alongside the file-production work.
- 2026-05-03 — v5: **major correction after verifying actual backend/frontend state.** (a) `/v2/marketplace` already exists (renders v1 `AppsMarketplacePage`, 771 lines, with `Discover | Installed` sub-tabs). `/v2/agents/browse` and `/v2/skills` also exist. v4's "design new top-level page" was wrong; right move is to extend `AppsMarketplacePage` in place with Apps · Agents · Skills · Integrations kind tabs. (b) `/api/marketplace/*` (Randy, PR #215+#230) is **already Installable-canonical** via dual-write — not legacy AR as v3/v4 framed. ADR-013's Phase 3 wires the agents tab against the Installable side from day one and *is* the marketplace-frontend track from ADR-011 by definition. Phasing collapsed from 8 active to 5 active (extend page, build inspector tabs, deprecate v1 pages). §"Relationship to Installable taxonomy" rewritten to reflect the per-kind split (agents already on Installable; skills still on AR). Open questions #7 + #8 closed; #9 narrowed (Randy's `/api/marketplace/mine` likely covers fork ownership, just verify response shape).
- 2026-05-03 — v5.1: added §Caveat on catalog-derived numbers in the §Context section. Catalog index `docs/skills/awesome-agent-skills-index.json` was last synced **2026-02-05** (nearly 3 months ago); all derived numbers (`~1,659` skills, `github` skill `603 stars`, etc.) are point-in-time snapshots, not live counts. Annotated each citation in-place. Numbers fetched live via GitHub API today (notably OfficeCLI's 2,768 stars + v1.0.70 release date) are explicitly timestamped 2026-05-03 and treated separately. Reviewers should re-sync before any sales-pitchy or external use of the figures.
- 2026-05-03 — v5.2: ASCII mockups had **invented numbers that looked authoritative** (`Apps (12)`, `Agents (78)`, `★ 4.8 · 240 installs`, `★ 4.6 · 88 installs`, `★ 4.5 · 175 installs`). All replaced with `—` placeholders so reviewers don't read them as projections or commitments. Added a mockup-note clarifying live values come from the marketplace API at runtime.
- 2026-05-03 — v5.3: corrected the v5.2 over-redaction. **GitHub stars should render** (real upstream signal from catalog/live API) — restored on cards as `★ <gh-stars>` with explicit data source. **Commonly review-style ratings (`★ 4.8`) should NOT render** — they don't exist as a system; would need their own ADR. **Install counts** (real Commonly metric) render where the query is cheap, omitted otherwise. Added §4d **per-agent skill management drawer** — the "friendly UX" surface the user flagged was missing. Configure drawer opens from any agent click (Members, Agents tab, Marketplace) and shows that agent's skills as a single-column list with inline `[×]` remove + preset-aware "Recommended for ___" gaps. Added open question #11 for verifying per-agent install scoping in `POST /api/skills/import`. Existing 4d (shared card-list subcomponent) renumbered to 4e. Phase 4 verification expanded to cover the new drawer.
- 2026-05-03 — v5.4: addressed 8 inline review comments + PR-level review on PR #287. **Supply-chain hardening:** the "fall back to python-office stack" mitigation was a lie (Part 2 removes that stack); rewrote the escape paths honestly (downgrade pin → staged Dockerfile target → full re-author, ranked by cost). Added explicit binary-mirror requirement (AR/GCS) to insulate from upstream artifact swap. Documented operational ownership for checksum-mismatch incidents. **Phase 0a prereqs:** introduced as a blocking spike covering (i) OfficeCLI checksum source verification, (ii) per-agent skill-install scoping (escalated open question #11 — load-bearing for Phase 4), (iii) workspace-boundary helper extractability for `commonly_attach_file`. **Phase 0b verification path:** rewritten to be skill-free (uses `acpx_run` to invoke `pandoc` directly) since `pandic-office` doesn't ship until Phase 1; the full skill-loop verification moves to end of Phase 1. **Inline `[×]` UX:** committed to per-agent reprovision endpoint as the target with "Queued — applies on next reprovision" wording as the acceptable v1; eliminated the "removing on next sync" copy that promised instant UX against ~60s reprovision. **Configure drawer permissions:** flipped default to admin-only after review feedback; per-field "visible to members" is explicit opt-in; Memory tab is never member-readable in v1 (ADR-003 §Visibility). Added Invariant 7 codifying this. **Live GitHub stars:** moved from client-side direct-fetch to a server-side proxy endpoint with TTL cache (`GET /api/marketplace/stars/...`); failure mode specified (`★ —` with tooltip on cache miss). **Phase 5 deletion gate:** replaced "no fallback complaints" vibe-check with a concrete `<N hits/week` telemetry threshold on the redirect path (added to Phase 3 scope as ~5 lines). **PR estimate:** widened from "~5" to "5–7" to reflect the Phase 0a (ii) uncertainty splitting Phase 4. Added open questions #12 (workspace-helper extractability) and #13 (SHA256SUMS publication). Added Invariant 8 making Phase 0a prereqs non-optional.
