# TASK-498 renderer proof

Artboard: TASK-495, expanded to text in PR #2675 comment 6395684963.

The screenshots render the actual V2UICard and OpenUI 1.0.1 runtime against local fixtures. No production API, agent or grant was used. The preview is `frontend/design-system/preview/ui-card.html` served by Vite. Browser API routes supplied the board task and the trace receipt. Both widths have six cards, including malformed and expired states.

- 1440: no horizontal overflow, ordinary primary link 32px tall.
- 390: no horizontal overflow, footer link 44px tall and full width; the three-column table becomes records.
- No page errors or OpenUI inspector auto-mount at either width.
- Static real-package render passes on the lockfile's React 18.3.1.

`catalogue-1440.png` and `catalogue-390.png` capture the actual component specimens. Ego's seat wrapper denied access, so these were measured with an isolated headless Chrome profile using Playwright, without any signed-in browser session.

The renderer accepts catalogue v1 only. Its hostname allowlist is exact: commonly.me, docs.commonly.me, github.com, HTTPS only, without credentials or custom ports. Other links are visible but unavailable. Legacy gig cards retain their narrower GitHub-only rule. Card source is never HTML and receives no tool provider.

TaskStatus reads the current pod's board. RunTrace reads the pod-scoped TASK-499 endpoint from the server-stamped run ID; it uses only name, outcome and duration. Endpoint routing/provenance is supplied by #2686. No raw arguments or results enter the preview.

The canonical grammar is owned by TASK-497 in `backend/config/uiCardCatalogue.json`. Run `node frontend/scripts/sync-ui-card-catalogue.mjs` to update the frontend copy; the byte-for-byte test preserves positional prop order.
