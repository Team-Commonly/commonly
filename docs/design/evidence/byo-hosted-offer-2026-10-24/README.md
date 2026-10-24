# Stalled BYO hosted alternative

TASK-482/483, 2026-10-24. Real isolated Chromium against local Vite, with
synthetic API responses and a literal `fixture-only-key`. No real user session,
credential, or production write is used.

Each language (`en`, `zh-CN`) and viewport (`1440×1000`, `390×844`) has:

- `offer-*.png`: the status row after the final action row; bordered white
  action at 32px desktop and 44px full width on phones.
- `copied-*.png`: actual command copy dismissed the offer.
- `reload-*.png`: same-tab reload, then issue/render the same agent's command
  and advance past 30 seconds; the offer remains absent.
- `result-*.json`: measured dimensions, document scroll/client widths, fixed-enum
  telemetry payloads and browser error list.

Desktop screenshots trigger the top-edge exit event. Phone screenshots first
assert that event has no effect, then advance the browser clock by 30 seconds.
The separate real-time 30-second browser check and hosted completion are recorded
in PR #2646. These images verify rendering and client behavior, not real hosting.

Chinese action: `改为在这里运行`.
Chinese supporting text: `无需终端。在这个 Pod 中启动一个新的托管智能体。`

`command-tops-1440.json` and `command-tops-390.json` come from the real
Playwright test in `e2e/byo-offer-layout.spec.ts`. All four command blocks,
including expanded Other ways, retain identical viewport top coordinates before
and after the offer appears. The memory textarea, final action row, and both
action buttons are also measured, with the memory field and buttons fully on
screen as the timer fires. This test failed at both widths with the offer
between command blocks, then passed after moving it after the final action row.

Run against the normal frontend dev server from the repository root:
`E2E_BASE_URL=http://localhost:3000 npx playwright test e2e/byo-offer-layout.spec.ts`.
All API responses and authentication are fixtures; no backend is required.
