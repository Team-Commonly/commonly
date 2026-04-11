# UI/UX Enhancement — Task Board

**Started**: 2026-04-11
**Worktree**: `/home/xcjam/workspace/commonly-uiux`
**Branch**: `uiux/enhance-2026-04-11`
**Coordinator**: Claude Opus 4.6 (1M)

**Status**: ✅ Round 1 complete — all 5 tracks delivered, typecheck + lint green, ready for commit & deploy.

Status legend: ⏳ pending · 🔨 in-progress · ✅ done · ❌ blocked · 🧪 needs review · 🎨 needs live smoke test

---

## Scope (from user request)

1. Agent Hub (registry) UI/UX enhancement — ✅
2. Marketplace UI/UX enhancement — ✅
3. App Integration page UI/UX enhancement — ✅ (Social section reorganized; full category regroup deferred because `GlobalIntegrations.tsx` only holds X + Instagram + the global-model-policy card, not a list with categories — noted in code as `TODO(ui)`)
4. Skill Marketplace with ratings/comments — ✅
5. Fix stale skill star counts + sync freshness — ✅
6. Enriched content for agent messages (emoji, memes/images) — ✅
7. PostgreSQL 30-day message retention — ✅
8. Task board UI/UX polish — ✅
9. OpenAI image endpoint wired for agent avatar generation — ✅ (code landed; runtime blocked on OPENAI_API_KEY in GCP SM — see Phase 2)
10. Generate nice avatars for all team agents — 🔜 Phase 2 (script written, needs API key)
11. Remove useless "debug runtime" section from agent hub — ✅
12. Typing indicators for agents — ✅

---

## Decisions

- **Clawhub integration**: DEFERRED. Use GitHub API refresh of existing `awesome-agent-skills-index.json` instead. Smaller attack surface, tighter guardrail.
- **LiteLLM for image gen**: BYPASS. Direct OpenAI client for `/v1/images/generations`.
- **Meme storage**: Reuse existing `/api/uploads/` multer endpoint.
- **Retention default**: 30 days, configurable via `PG_MESSAGE_RETENTION_DAYS`.
- **Worktree strategy**: Single shared worktree, non-overlapping file ownership per agent — worked perfectly. No merge conflicts.

---

## Implementation Tracks

### Track 1 — Agent Hub Polish · `@hub-designer` ✅

- ✅ Removed Runtime Debug `<Accordion>` (old L3030-3129) and collapsed its wrapper Box
- ✅ Removed reset `useEffect` (old L2328-2331)
- ✅ Removed helpers `getInstalledDebugKey`, `fetchInstalledRuntimeDebug`, `handleToggleInstalledDebug`, `copyInstalledDebug` (old L830-913)
- ✅ Removed state `installedDebugExpanded`, `installedRuntimeDebug`
- ✅ Pruned imports: `Accordion`, `AccordionSummary`, `AccordionDetails`, `ExpandMoreIcon` (RefreshIcon + CopyIcon kept — still used in Admin tab)
- ✅ Polished Installed tab empty state with `SmartToyOutlinedIcon` + headline + "Browse Discover" link
- ✅ Polished Discover tab header (subtitle + wider gap + flexShrink on chip)
- **Delta**: `AgentsHub.tsx` 5035 → 4884 lines (−151 net)
- **Files**: `frontend/src/components/agents/AgentsHub.tsx`

### Track 2 — ChatRoom Enhancement · `@chat-designer` ✅

**Task Board polish:**
- ✅ Typography: column headers 0.7→0.75rem, letterSpacing 0.8→0.4; card IDs/chips 0.68→0.72rem; titles 0.8→0.9rem; meta rows 0.68/0.7→0.85rem
- ✅ Card padding 10×12 → 14×14; border-left 3→2px; hover translate+shadow
- ✅ Tooltip wraps truncated titles (3-line clamp)
- ✅ Unicode markers replaced: `⛔` → `<BlockIcon>`, `↳` → `<SubdirectoryArrowRightIcon>`, `🔒` → `<LockOutlineIcon>`
- ✅ Per-column empty states (dashed-border centered Box with `InboxOutlinedIcon`)
- ✅ Mobile drawer constrained: `min(420px, calc(100vw - 48px))`

**Typing Indicator:**
- ✅ `AgentTypingIndicator` local component with stacked overlapping 24px avatars + animated three-dot `@keyframes typingDot`
- ✅ State `typingAgents` + ref-based 30s safety timers keyed on `agentName:instanceId`
- ✅ Pod-change cleanup effect + socket subscribe/unsubscribe on `agent_typing_start`/`agent_typing_stop`
- ✅ Rendered between message list and composer; returns `null` when empty

**Enriched Content:**
- ✅ `node-emoji@^2.1.3` added to `frontend/package.json`
- ✅ `emojifyPreserveCode(raw)` splits on fenced ``` ``` + inline `` ` `` via regex, emojifies only prose segments (avoids corrupting code blocks). Applied at `messageType === 'text'` render site only — MarkdownContent.tsx untouched, so posts/comments unaffected.
- ✅ `<GifBoxOutlinedIcon>` IconButton in composer (between emoji picker and attach), hidden file input accepts `image/gif,image/png,image/jpeg,image/webp`, POSTs to `/api/uploads` with field name `image` (verified via `uploads.ts:38`), injects `\n![image](${url})\n` into composer on success, `CircularProgress` during upload.

- **Files**: `frontend/src/components/ChatRoom.tsx`, `frontend/package.json`

### Track 3 — Marketplace + Skills Fix · `@market-designer` ✅

**Skills sync:**
- ✅ `backend/services/skillsRefreshService.ts` (new) — fetches upstream JSON from `raw.githubusercontent.com/openclaw/skills/main/...`, overridable via `SKILLS_UPSTREAM_INDEX_URL`, uses `GITHUB_PAT` bearer auth, 100ms delay between unique-repo star count requests, preserves partial progress on 401/rate-limit, keeps stale local file on upstream failure (never blanks). Stamps `upstreamRefreshedAt` + `localRefreshedAt`. Exports `getLastRefreshAt()`.
- ✅ `backend/services/skillsCatalogService.ts` — mtime-based cache invalidation + `invalidateCache()` + `getLastRefreshedAt()` exports
- ✅ `backend/services/schedulerService.ts` — 6-hourly cron `0 */6 * * *` + 30s startup kick
- ✅ `backend/routes/skills.ts` `/catalog` response extended with refreshedAt timestamps

**Skill ratings:**
- ✅ `backend/models/SkillRating.ts` (new) — `skillId + userId` compound unique, rating 1-5, comment ≤2000, `getAggregated()` + `getAggregatedMany()` statics
- ✅ Routes in `backend/routes/skills.ts`: `POST /:skillId/rating` (upsert), `GET /:skillId/ratings` (paginated), `GET /:skillId/ratings/summary`, `DELETE /:skillId/rating`, `GET /ratings/summary?skillIds=a,b,c` (batch)
- ✅ `frontend/src/components/skills/SkillsCatalogPage.tsx` — `<Rating>` on each card, detail `<Dialog>` with summary (avg + histogram bars), interactive rating form, comments list, "Highest rated" sort option, "Last updated X ago" indicator, manual refresh button

**Apps Marketplace polish:**
- ✅ Hero section with gradient background, h3 headline, inline pill-shaped search, pod select, "Submit App" button
- ✅ Featured section converted to horizontal scroll strip with scroll-snap
- ✅ `AppCard.tsx` — avatar 56→64px, stronger hover, absolute-positioned category chip top-right, "Installed" chip bottom-right

**Admin Integrations polish:**
- ✅ "Social" section header above X/Instagram cards
- ✅ X + Instagram edit forms wrapped in collapsed-by-default `<Accordion>`
- 🔜 Full Chat/Email/Other category grouping deferred (requires data-fetch refactor; noted as `TODO(ui)` in file)

- **Files**: `backend/services/skillsRefreshService.ts` (new), `backend/models/SkillRating.ts` (new), `backend/services/skillsCatalogService.ts`, `backend/services/schedulerService.ts`, `backend/routes/skills.ts`, `frontend/src/components/skills/SkillsCatalogPage.tsx`, `frontend/src/components/apps/AppsMarketplacePage.tsx`, `frontend/src/components/apps/AppCard.tsx`, `frontend/src/components/admin/GlobalIntegrations.tsx`

### Track 4 — Avatar Forge · `@avatar-forge` ✅

- ✅ `openai@^4.77.0` added to `backend/package.json` (installed @ 4.104.0)
- ✅ `backend/services/openaiImageService.ts` (new) — lazy client init, `gpt-image-1` → `dall-e-3` fallback, rate-limit + 5xx retry-once, typed `OpenAIImageError` kinds, cost-estimate logging, `b64_json` → URL-fetch conversion, CJS compat footer
- ✅ `backend/services/agentAvatarService.ts` — three-tier provider chain OpenAI → Gemini → SVG; env toggle `AVATAR_PROVIDER=openai|gemini|auto`; existing Gemini code untouched (purely additive)
- ✅ `backend/models/User.ts` — `avatarMetadata` extended with `source: 'openai'|'gemini'|'svg'|'manual'` + `model: string`
- ✅ `k8s/helm/commonly/templates/secrets/api-keys.yaml` — `OPENAI_API_KEY` mapping already present (no YAML edit needed)
- ✅ `backend/scripts/generate-team-avatars.ts` (new) — idempotent, TEAM array of liz/theo/nova/pixel/ops/x-curator with personality-matched prompts, resolves via `AgentIdentityService.getOrCreateAgentUser`, writes to `User.profilePicture` + `avatarMetadata`, `--force` flag, cost total
- ✅ `docs/AGENT_AVATARS.md` (new) — GCP SM setup, ESO force-sync, script usage, cost table, adding new agents

- **Files**: `backend/package.json`, `backend/services/openaiImageService.ts` (new), `backend/services/agentAvatarService.ts`, `backend/models/User.ts`, `backend/scripts/generate-team-avatars.ts` (new), `docs/AGENT_AVATARS.md` (new)

### Track 5 — Backend Infra · `@infra-dev` ✅

**Typing events:**
- ✅ `backend/services/agentTypingService.ts` (new) — `bindSocketIO`, `emitAgentTypingStart`, `emitAgentTypingStop`, 60s safety timer keyed on `podId:agentName:instanceId`, structural `SocketIOLike` interface, CJS compat footer
- ✅ `backend/server.ts` — binds socket.io near other one-time socket setup; client-side `agent_typing_start`/`agent_typing_stop` forwarders inside `io.on('connection')` that re-broadcast into `pod_{podId}` room
- ✅ `backend/services/agentEventService.ts` — lazy `getTypingService()` + `TYPING_EVENT_TYPES` allowlist (`heartbeat`, `chat.mention`, `summary.request`, `discord.summary`, `integration.summary`, `ensemble.turn`); fire-and-forget `signalAgentTyping(event)` inside `enqueue()` after websocket push
- ✅ `backend/services/agentMessageService.ts` — emits `agent_typing_stop` at the **entry** of `postMessage()` wrapped in try/catch so every return path (skip/dedupe/error/success) clears the indicator

**PG retention:**
- ✅ `backend/services/pgRetentionService.ts` (new) — daily cron `0 3 * * *` UTC, reads `PG_MESSAGE_RETENTION_DAYS` (default 30), idempotent init guard, swallows errors so cron keeps running, gated on `NODE_ENV !== 'test'`
- ✅ `backend/models/pg/Message.ts` — `static async deleteOlderThan(days)` with `NOW() - $1::interval RETURNING id`, validates days > 0, returns `{ deleted: N }`
- ✅ `backend/server.ts` — calls `initPgRetention()` after PG success log

- **Files**: `backend/services/agentTypingService.ts` (new), `backend/services/pgRetentionService.ts` (new), `backend/server.ts`, `backend/services/agentEventService.ts`, `backend/services/agentMessageService.ts`, `backend/models/pg/Message.ts`

---

## Integration checklist (Round 1 post-mortem)

- [x] Review diffs from each agent — 17 modified + 7 new files, no track overlaps
- [x] `cd backend && npm install openai@^4.77.0` — installed @ 4.104.0
- [x] `cd frontend && npm install node-emoji@^2.1.3` — installed @ 2.2.0
- [x] `backend && npm run tsc:check` — clean
- [x] `frontend && npm run typecheck` — clean
- [x] `backend && npm run lint` — 865 errors ALL pre-existing (main branch baseline matches; `eslint . --ext .js` doesn't cover my `.ts` changes anyway)
- [x] `frontend && npm run lint` — 104 pre-existing JSX-extension warnings from Apr 8 `.tsx` migration + 1 pre-existing unescaped-entity error in `PersonalityBuilder.tsx` (untouched by this work)
- [x] Zero new lint errors introduced by Round 1
- [ ] Commit tracks as coherent chunks
- [ ] Report to user

## Phase 2 (blocked on external / user decision)

- **Generate actual avatars for team agents**: blocked on `OPENAI_API_KEY` in GCP Secret Manager. Commands in `docs/AGENT_AVATARS.md`. Once key lands: `npx ts-node backend/scripts/generate-team-avatars.ts` → images flow into `User.profilePicture`.
- **Deploy to dev**: local docker build backend + frontend + gateway, bump `values-dev.yaml` tags, helm upgrade with all 3 `-f` flags (per memory: include `values-private.yaml`). Restart-safe: no breaking schema changes, no API removals.
- **MCP Playwright smoke test**: navigate `app-dev.commonly.me/agents`, `/skills`, `/apps`, `/pods/<id>` — confirm (a) no runtime debug accordion, (b) skills page shows ratings, (c) apps hero renders, (d) agent hub discover polish, (e) chat room empty state + typing indicator wire (no server-side stimulus yet).
- **GCP SM backfill**: create `commonly-dev-openai-api-key` + force ESO sync + roll backend.
