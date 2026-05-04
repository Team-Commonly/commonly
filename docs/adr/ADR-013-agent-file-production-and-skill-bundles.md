# ADR-013: Agent file production — extension tool, dev skill bundles, and v2 install UI

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
| Skill catalog (1,659 community-authored skills) | Synced from `VoltAgent/awesome-agent-skills` | `external/awesome-openclaw-skills/`, `docs/skills/awesome-agent-skills-index.json` |
| Skill install API | Shipped | `backend/routes/skills.ts` — `GET /catalog`, `POST /import`, `GET /requirements`, `GET/DELETE /pods/:podId/imported`, ratings |
| Skill sync to gateway PVC | Shipped | `syncOpenClawSkills` in `agentProvisionerServiceK8s.ts`; called from provision + reprovision + `/api/skills/import` |
| `defaultSkills` in preset definitions | Shipped, mostly unused | `backend/routes/registry/presets.ts` |
| File upload endpoints | Shipped (ADR-002) | User: `POST /api/uploads`. Agent runtime: `POST /api/agents/runtime/pods/:podId/uploads`. Returns `{fileName, _id, kind, size, originalName}` |
| File pill rendering with click-to-preview | Shipped (PR #278) | `[[upload:fn\|on\|sz\|kind\|fileId]]` directive; inspector preview for PDF/CSV/MD/Office/images |
| V1 skills UI | Shipped, bloated | `frontend/src/components/skills/SkillsCatalogPage.tsx` (2,061 lines), `frontend/src/components/agents/AgentsHub.tsx` (4,954 lines) |
| V2 inspector tabs | Shipped | overview / members / tasks / manage. No skills tab. No agent install/fork UI in v2 yet. |

### Office-relevant skills already in the catalog

Filtering the 1,659-skill catalog for Linux-runnable file generation:

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
- Verify SHA256 from upstream's `SHA256SUMS` artifact — fail the build if the binary changed under us.
- Add `officecli --version`, `pandoc --version`, `python3 -c "import markitdown, pypdf"` to the gateway healthcheck so a regression (lost binary, broken pip) surfaces before an agent hits `command not found`.

**Why a 7-week-old project.** OfficeCLI is young (created 2026-03-15, 2,768 stars, v1.0.70 released 2026-05-02) — but the alternative is shipping a 600 MB stack that produces inferior output for the same use cases. Risk is real but bounded: the binary is pinned + checksummed; if upstream goes inactive or breaks something, we have an easy escape (downgrade pin, or fall back to the python-office stack as a Phase-N retreat). For now, the quality + size + license combination dominates.

### Part 3: Default skill bundles per preset

Update `backend/routes/registry/presets.ts`. Add `defaultSkills` for each of the four production dev personas. Community presets stay at `[]` (per CLAUDE.md ADR-011 — community agents are not in the active track and don't need file output yet).

| Preset | New `defaultSkills` | Why |
|---|---|---|
| `dev-pm` (Theo) | `github`, `officecli`, `pandic-office`, `markdown-converter`, `pdf` | Theo writes audit summaries, PRDs, briefs, weekly reports. OfficeCLI for DOCX/XLSX deliverables; pandic-office for PDFs; markdown-converter for reading user-attached docs; github for issue/PR context. |
| `backend-engineer` (Nova) | `github`, `tmux`, `officecli`, `pandic-office`, `markdown-converter`, `pdf` | Code work + occasional API specs as DOCX + reading user-attached PDFs/specs. Tmux for long-running coding tasks. |
| `frontend-engineer` (Pixel) | `github`, `tmux`, `officecli`, `pandic-office`, `markdown-converter`, `pdf` | Same as Nova for the codebase side. |
| `devops-engineer` (Ops) | `github`, `tmux`, `officecli`, `pandic-office`, `markdown-converter`, `pdf` | Same — and Ops is most likely to be handed PDFs of vendor docs / runbooks. |

Plus implicit-everywhere: `commonly_attach_file` is the extension tool from Part 1 and is always available — no skill import required.

**Note on `github` (resolved 2026-05-03).** Verified to be a real catalog entry: `github` skill by `steipete`, MIT license, 603 stars, lives at `openclaw/skills/skills/steipete/github/SKILL.md`. Description: "Interact with GitHub using the `gh`." Runtime requirement: `gh` CLI in the agent's runtime — already present in the gateway image via the existing `OPENCLAW_INSTALL_GH_CLI=1` build arg. Make that arg default-on for production builds (currently passed at build time in the workflow; pin in `Dockerfile` instead so OSS contributors get parity locally).

**Note on `officecli` skill packaging.** The skill SKILL.md is the upstream file at `iOfficeAI/OfficeCLI/SKILL.md` (Apache-2.0, redistributable). It's not in our `awesome-agent-skills-index.json` yet (catalog sync predates OfficeCLI's 2026-03-15 creation). Two paths, parallel:
- **Short term:** carry it locally as a `commonly-bundled-skills/officecli/SKILL.md` and reference by id in `defaultSkills`. Ships with this ADR.
- **Long term:** PR the skill into upstream `VoltAgent/awesome-agent-skills`. Net-positive for the OpenClaw ecosystem; lets us drop the local copy once the next sync runs. File the same week we ship the local copy.

**Note on `tmux`.** Same shape as `github` — community catalog skill assuming the `tmux` binary exists. Add `tmux` to the Dockerfile. Trivial.

**Community presets (deferred).** All seven `community-*` presets and the marketing/strategy presets keep `defaultSkills: []` for now. Reactivation trigger: when a community agent is documented to need file output (e.g. content-creator generating a PDF brief), add bundles in a follow-up. ADR-011's "shell-first" track explicitly puts these on hold.

**Reprovision behavior.** `syncOpenClawSkills` already runs on provision and on `reprovision-all`. Once `defaultSkills` is non-empty, the next reprovision pushes the skill markdown to the agent's PVC at `/workspace/<accountId>/skills/<skill-id>/SKILL.md`. No new infrastructure. Verify the path is correct in dev cluster before merging the preset change.

### Part 4: V2 UI — Skills tab + Agent install/fork

V2 inspector currently has four tabs: `overview / members / tasks / manage`. Add a fifth: **`skills`**. Show only when the pod has at least one OpenClaw agent member or the viewer is an admin.

```
┌─────────────────────────── V2 Inspector ──┐
│ Overview · Members · Tasks · Manage · Skills│   ← new tab
├────────────────────────────────────────────┤
│ Search skills…    [_______________]    🔍 │
├────────────────────────────────────────────┤
│ Installed (4)                              │
│  github            · uninstall             │
│  pandic-office     · uninstall             │
│  pdf               · uninstall             │
│  markdown-converter · uninstall            │
├────────────────────────────────────────────┤
│ Recommended for this pod                   │
│  ai-pdf-builder    · install               │
│  research-company  · install               │
│  ...                                       │
├────────────────────────────────────────────┤
│ Browse all (1,659)                  → open │
└────────────────────────────────────────────┘
```

Lift target: **<400 lines** for the entire `V2InspectorSkillsTab.tsx` component. The v1 `SkillsCatalogPage.tsx` weighs 2,061 lines because it tries to be a full marketplace with filters, ratings, requirements modals, and four detail layouts. V2 keeps four affordances:

1. **Search** (debounced, hits `GET /api/skills/catalog?q=`)
2. **Installed list** with one-click uninstall (existing `DELETE /api/skills/pods/:podId/imported`)
3. **Recommended row** — hard-coded list of 4–6 IDs we know are good, hand-curated, no dynamic ranking yet
4. **Browse all** — opens the v1 catalog page in a new tab as the escape hatch. Don't reinvent the marketplace inside the inspector.

Skill detail (description, scripts list, runtime requirements) opens as an inline expandable row, not a modal. One screen, no navigation.

**Agent install/fork.** Already partly exists in v1 `AgentsHub.tsx` (4,954 lines) and is on the active "agent install + first-DM flow" track per ADR-011. Out of scope for this ADR's UI work — `ADR-013` lands the skills tab; the agent install/fork affordance is its own track.

---

## Phasing

| Phase | Scope | Verification | Owner |
|---|---|---|---|
| **0** | This ADR + `commonly_attach_file` extension tool + Dockerfile toolchain | Single agent (Nova) given a hand-test task: "produce a one-page PDF summary of `docs/COMMONLY_SCOPE.md`, attach it." End-to-end: agent runs `pandoc`, calls `commonly_attach_file`, file appears in chat with preview. | One backend + clawdbot PR pair |
| **1** | Update `defaultSkills` for the four dev personas; reprovision-all | Nova/Theo/Pixel/Ops each have `pandic-office`, `pdf`, `markdown-converter`, `github` synced to PVC. Hand-test by giving each a file-producing task. | One backend PR |
| **2** | SOUL.md two-line addition | Visible in IDENTITY.md sync log; first heartbeat after deploy uses the rule | One backend PR |
| **3** | V2 inspector Skills tab | Frontend PR; manual test on dev cluster. Ratings/requirements deferred. | One frontend PR |
| **4** *(deferred)* | Author + upstream-contribute `commonly-pptx`, `commonly-xlsx` skills | When real demand surfaces (a marketing or chief-of-staff agent asks for slides) | Out of scope here |

Phases 0–3 are sequenced on dependency, not parallel. Phase 0 is a hard prereq for Phase 1 (skills assume the toolchain is present). Phase 3 can land independently of 1–2 but should follow them so first-load shows the dev bundle.

Estimated total: ~3–4 PRs across backend + clawdbot + frontend. Nothing requires new schema, new API surface, or migrations.

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

---

## Open questions

1. **Does `POST /api/skills/import` push the SKILL.md to the gateway PVC, or only register metadata?** The plumbing exists in `syncOpenClawSkills`, but verify on dev cluster that an import call actually drops the markdown into `/workspace/<accountId>/skills/<id>/`. If it's metadata-only, we need a separate sync trigger as part of Phase 1.

2. ~~What does the existing `github` skill ID resolve to?~~ **Resolved 2026-05-03.** Real catalog skill at `openclaw/skills/skills/steipete/github/SKILL.md`, MIT, 603 stars, requires `gh` CLI (already in image). No shim layer — `defaultSkills: [{id: 'github'}]` in presets resolves directly against the catalog.

3. **Should the v2 Skills tab be admin-only, or visible to all members?** Members can already see installed skills via the existing imported endpoint. Letting any member install/uninstall on a shared pod has a permissions implication — and reuses an existing trust model that hasn't been adversarially tested in v2. Default to **owner + admin only** for install/uninstall in v2; all members can read the installed list. Revisit after first abuse signal.

4. **Image-size budget.** ~170 MB add to the gateway image (down from ~600 MB after pivoting to OfficeCLI). Watch cold-start time on the dev cluster after the Dockerfile change ships; the `texlive-xetex` subset is the heaviest piece. If pull time regresses meaningfully, evaluate moving texlive to a separate PDF-only sidecar (defer; not first move).

5. **OfficeCLI version pin cadence.** v1.0.70 is from 2026-05-02. Active project = rapid changes. Choose: pin and bump weekly (high awareness, frequent rebuilds), pin and bump monthly (matches our deploy cadence), or float on a `v1.x` minor (rejected — defeats the point of pinning). Recommended: pin to a tag, bump on each `Deploy Dev` run if the upstream tag has changed and CI passes a smoke test (`officecli create test.pptx && officecli validate test.pptx`). Add to Phase 0 verification.

6. **Per-pod vs per-agent skill scoping.** Today the install pipeline scopes skills to `(agentName, instanceId, podId)` tuples. The skill is mounted into the agent's workspace and seen by that agent in that pod. The v2 Skills tab is in the pod inspector — that suggests pod-level UX. But the same agent in a different pod gets a different skill set, which is correct semantics but confusing UX. Phase 3 displays "Installed for `@agent` in this pod" prominently; longer-term, consider per-agent skill defaults that auto-apply across all of an agent's pods. (Tracked separately, not in this ADR.)

7. **Should we accelerate ADR-001 Phase 3 read-path switch to align with this work, or defer per ADR-011's pause?** ADR-011 paused Phase 3 until "marketplace frontend reveals a drift bug or a new Installable shape needs the read-path switch." This ADR's v2 Skills tab arguably *is* the marketplace frontend's first surface. Two options: (a) ship ADR-013 against the legacy `/api/skills/*` path and migrate later, or (b) flip Phase 3 now and ship ADR-013 directly against `/api/installables?type=skill`. (a) lets us ship sooner; (b) avoids a near-term migration. Default to (a) unless the Installable refactor track has spare capacity. See §"Relationship to Installable taxonomy" for detail.

---

## Relationship to Installable taxonomy (ADR-001)

This ADR uses the legacy `/api/skills/*` and `PRESET_DEFINITIONS.defaultSkills` paths today. It is **conceptually aligned** with ADR-001's Installable model and **structurally pre-Phase-3** — i.e., we ship through the older read path because Phase 3 is paused per ADR-011. None of the work here becomes throwaway when Phase 3 unpauses; the data source flips, the wire shape doesn't.

### Conceptual mapping (where each piece would live under Installable Phase 3)

ADR-001 already defines `Skill` as a first-class `Component` type — exactly the right home for what we're shipping:

| ADR-013 piece | Installable mapping (Phase 3) | Migrates by |
|---|---|---|
| Each catalog skill (`officecli`, `pandic-office`, `pdf`, `markdown-converter`, `github`, `tmux`) | `Installable { kind: 'skill', source: 'marketplace', scope: 'pod', components: [Skill{skillId}], requires: [...] }` | One-time backfill from `awesome-agent-skills-index.json` to the `Installable` collection (already on ADR-001 Phase 3's plan). |
| `defaultSkills` array on a preset | The agent Installable's manifest declares its skill dependencies — either as `requires: string[]` capability strings or as a `defaultBundle: InstallableRef[]` field | Schema migration on the preset → agent-Installable conversion. |
| `commonly_attach_file` extension tool | **Not an Installable.** Kernel protocol verb, same layer as `commonly_post_message` | No migration. Lives in the OpenClaw `commonly` extension. The kernel sits below the Installable layer. |
| OfficeCLI binary in the gateway image | **Not an Installable.** Driver-level substrate — same category as having `node` or `gh` in the image | ADR-008's environment primitive eventually formalizes "what tools live in my agent's runtime"; that's a separate layer. |
| V2 inspector Skills tab | UI reads `/api/skills/*` today; the same component binds to `/api/installables?components.type=Skill` after the read-path switch | Data-source flip on the same UI. No structural rewrite. |

So the **conceptual connection is exact**. Skills, marketplace, install scope, identity continuity — ADR-001 already names every piece. This ADR is filling in skill *content* under that model.

### Where we're structurally bypassing it (and why that's OK)

ADR-001 Phase 3 (read-path switch from `AgentRegistry`/`App` to `Installable`) is paused per ADR-011 with a stated reactivation trigger: "marketplace frontend reveals a drift bug or a new Installable shape needs the read-path switch." This ADR's work doesn't trigger that — none of what we ship requires the new read path to function:

- Catalog comes from `awesome-agent-skills-index.json` (file-on-disk index)
- `defaultSkills` arrays come from `PRESET_DEFINITIONS` in code
- Per-pod imported skills come from the existing AR-side import table
- Skill sync to PVC runs through `syncOpenClawSkills` regardless of which table the source list comes from

We write through the legacy surface today. That's not new debt; it's the read path that exists.

### Migration story when Phase 3 unpauses

In order, idempotent, no rewrite of ADR-013 work:

1. **Backfill catalog rows into `Installable`.** Each entry in `awesome-agent-skills-index.json` becomes one `Installable { kind:'skill', source:'marketplace', components:[Skill{skillId, skillPrompt: <SKILL.md content>}] }`. Already part of ADR-001 Phase 3's spec.
2. **Convert `PRESET_DEFINITIONS` agents into agent Installables.** `defaultSkills` becomes a manifest field on the agent Installable (either `requires` or `defaultBundle`). Each install of an agent fans out to install rows for the agent + each declared skill.
3. **`/api/skills/*` becomes a thin compat shim** over `/api/installables?type=skill`, returning the same shape the v2 Skills tab expects. Frontend doesn't change.
4. **`syncOpenClawSkills` is driven by `InstallableInstallation` projections** rather than the legacy import table. Same PVC layout, same SKILL.md sync mechanism, different source row.
5. **`commonly_attach_file` is unchanged.** Not migrated. Stays in the kernel extension.

The flagged risk: if upstream `awesome-agent-skills` adds a manifest concept (multi-component bundles, `requires` declarations, scope hints) before our migration, the catalog → Installable backfill becomes more involved than a 1:1 row map. Worth pinging the catalog at write time, not at rewrite time, so we catch shape changes early.

### Pivot point worth naming

When the marketplace frontend track (active per ADR-011) ships, the v2 Skills tab is its first surface — already a marketplace browser, just scoped to skills. That's the **natural moment to flip from `/api/skills/*` to `/api/installables?type=skill`**. ADR-013's UI is the spec; the data switch is a follow-up that doesn't change the inspector code. Whether to accelerate Phase 3 to align with this work (vs. deferring) is open question #7.

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
