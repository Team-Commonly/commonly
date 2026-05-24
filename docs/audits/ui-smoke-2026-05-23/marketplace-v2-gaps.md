# V2 Marketplace — Gap Audit (2026-05-23)

Source: subagent `Explore` audit of `frontend/src/v2/` + `frontend/src/components/apps/AppsMarketplacePage.tsx` + `backend/routes/marketplace-api.ts`.

## TL;DR

**V2 marketplace is essentially un-redesigned.** The route `/v2/marketplace` mounts the legacy MUI component `AppsMarketplacePage.tsx`. That component calls `/api/apps/marketplace*` (legacy / non-existent shadows) instead of the shipped `/api/marketplace/*` endpoint family from PRs #215 + #230. So v2 marketplace is both (a) wrong-stack-of-endpoints and (b) wrong-design-system.

## Endpoint → UI mapping

| Verb | Path | Backend | Called by v2? |
|---|---|---|---|
| GET | `/api/marketplace/official` | ✅ | ❌ |
| GET | `/api/marketplace/browse` | ✅ | ❌ (v2 hits `/api/apps/marketplace` instead) |
| GET | `/api/marketplace/manifests/:id` | ✅ | ❌ (no v2 detail route) |
| GET | `/api/marketplace/manifests/:id/forks` | ✅ | ❌ |
| GET | `/api/marketplace/mine` | ✅ | ❌ |
| POST | `/api/marketplace/publish` | ✅ | ❌ |
| POST | `/api/marketplace/fork` | ✅ | ❌ |
| DELETE | `/api/marketplace/publish/:id` | ✅ | ❌ |
| POST | `/api/marketplace/publish/:id/deprecate` | ✅ | ❌ |

## Top gaps

| # | Severity | Gap |
|---|---|---|
| 1 | P0 | V2 calls wrong endpoint family — every request 404s or hits a legacy shadow. |
| 2 | P0 | No v2-native redesign — 100% MUI Box/Typography/Button with theme.palette colors, not v2 tokens. |
| 3 | P1 | Installable taxonomy (components, sources, scopes, version history) not surfaced in browse or detail. |
| 4 | P1 | No manifest detail page (`/v2/marketplace/:id`). |
| 5 | P1 | No publish/fork/deprecate UI — three full backend flows with no UI entry point. |
| 6 | P2 | Material-UI color bleed + design-system misalignment (gradient hero, MUI defaults, no v2 tokens). |

## Smallest-set recommendation (2–3 PRs, ~3–4 days)

1. **Fix endpoint calls** (~2h) — rewire AppsMarketplacePage to call `/api/marketplace/browse` and match its filter signature.
2. **Add detail page** (~1d) — `/v2/marketplace/:id` route + manifest fetch + readme/version/forks render.
3. **v2-token alignment pass** (~1d) — replace MUI palette + inline colors with v2 CSS vars; drop the `.v2-feature__legacy` shim.

After these 3 PRs the marketplace becomes reviewable. Publish/fork/deprecate UI is the natural next phase.
