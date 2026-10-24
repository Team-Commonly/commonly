# Stalled BYO hosted bar

TASK-482/483, 2026-10-24. Real isolated Chromium with synthetic API responses
and the literal `fixture-only-key`. No real user session, credential, or
production write is used.

Lily's 16:28Z ruling supersedes the earlier in-flow placement: the offer is a
sticky bottom bar with an ink action, a top border and no shadow. Its 96px desktop
or 128px phone height is reserved from the first render; a negative top margin
means inserting the bar adds no flow height. The initial content pane padding
includes that same height, so full scroll reveals the final control above it.

Each language (`en`, `zh-CN`) and viewport (`1440×1000`, `390×844`) has:

- `offer-*.png`: the bar visible immediately at the initial scroll position.
- `full-scroll-*.png`: the last existing control remains above the bar.
- `copied-*.png`: command copy dismissed the offer.
- `reload-*.png`: same-tab reload, reissue/render the same agent's command,
  advance past 30 seconds; the offer remains absent.
- `result-*.json`: bar/button dimensions, scroll/client widths, fixed event
  names and browser errors. Phone captures advance the browser clock; desktop
  captures use top-edge exit intent.

`command-tops-*.json` and `sticky-clearance-*.json` come from
`e2e/byo-offer-layout.spec.ts`. At 1440×1000 and 390×844, all four commands,
the memory textarea, final CTA row and both final buttons retain identical tops
when the bar appears. Memory and the final buttons are fully on screen while
the timer fires. The bar stays in view at the top and bottom of the pane; at
full scroll the last button clears its top edge. Reserved height equals measured
bar height both before key issuance and after the bar appears.

Run against the normal frontend dev server from the repository root:
`E2E_BASE_URL=http://localhost:3000 npx playwright test e2e/byo-offer-layout.spec.ts`.
All API responses and authentication are fixtures; no backend is required.

Chinese action: `改为在这里运行`.
Chinese supporting text: `无需终端。在这个 Pod 中启动一个新的托管智能体。`

### Provision error at 390 px

`provision-error-en-390.png` shows the intercepted 503 response with a two-line error. The sticky bar uses a minimum height and grows for error text; it has no nested scroller. The Chromium spec reproduced clipping before the CSS fix and passes after it, including the existing stationary controls, viewport and full-scroll clearance assertions.
