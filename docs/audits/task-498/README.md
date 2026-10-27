# TASK-498 renderer proof

Artboard: TASK-495, expanded to text in PR #2675 comment 6395684963.

The screenshots render the actual V2UICard and OpenUI 1.0.1 runtime against local fixtures. No production API, agent or grant was used. The preview is `frontend/design-system/preview/ui-card.html` compiled by Vite in production mode and served by its preview server. Browser API routes supplied the board task and the trace receipt. Both widths have seven cards, including malformed, expired and unsupported revision states.

- 1440: no horizontal overflow, ordinary primary link 32px tall.
- 390: no horizontal overflow, footer link 44px tall and full width; the three-column table becomes records.
- No page errors or OpenUI inspector auto-mount at either width.
- Static real-package render passes on the lockfile's React 18.3.1.

`catalogue-1440.png` and `catalogue-390.png` capture the actual component specimens. Ego's seat wrapper denied access, so these were measured with an isolated headless Chrome profile using Playwright, without any signed-in browser session.

The renderer accepts only the exact commonly.ui revision-1 ID/revision/hash tuple; missing or unsupported tuples retain the content with an unsupported-version note. Its hostname allowlist is exact: commonly.me, docs.commonly.me, github.com, HTTPS only, without credentials or custom ports. Other links are visible but unavailable. Legacy gig cards retain their narrower GitHub-only rule. Card source is never HTML and receives no tool provider.

TaskStatus reads the current pod's board. RunTrace reads the pod-scoped TASK-499 endpoint from the server-stamped run ID; it uses only name, outcome and duration. Endpoint routing/provenance is supplied by #2686. No raw arguments or results enter the preview.

The canonical grammar is owned by TASK-497 in `backend/config/uiCardCatalogue.json`. Run `node frontend/scripts/sync-ui-card-catalogue.mjs` to update the frontend copy; the byte-for-byte tests preserve positional prop order and the revision manifest.

## Repeat the production check

From the repository root with root and frontend dependencies installed:

```sh
OPENUI_TELEMETRY_DISABLED=1 npm ci --prefix frontend --legacy-peer-deps
node scripts/check-ui-card-production.mjs
```

The check compiles the real component specimen with the production Vite configuration, checks emitted JavaScript for the devtools CDN/mount code, opens the production assets in isolated Playwright Chromium, records outgoing requests and measures both widths. Set `CHROME_EXECUTABLE` to use an existing Chrome binary. It does not call a live API. `production-proof.json` records zero jsDelivr/PostHog requests and page errors. This is local production-build evidence, not a deployed walk.

Source parsing rejects dormant capabilities and bounds reference expansion before materialization (4,096 AST nodes across statements), plus a separate parsed-tree bound. Tests cover an exponential repeated-reference graph and its valid small control. The renderer has no A2UI interoperability claim.
