# Approval argument labels: PR #2381 repair

The branch was rebased on main before repairing Rhea's HOLD (review 5598440568).
`LABEL_KEYS` now accepts own entries only. Canonical JSON argument names such as
`toString`, `constructor`, `hasOwnProperty` and `__proto__` use their raw names,
just like the ordinary unknown-key control `extra`. The same own-key rule
protects the tool-name verb table.

The new helper cases failed for all four inherited argument names before the
fix. Afterward, helper and real approval-card suites pass 40 tests. Card tests
use the configured i18next resources, fetch the pinned envelope through the
API seam, preserve the exact JSON disclosure, and verify Approve and Decline
remain enabled. Frontend typecheck and changed-file lint pass.

## Local browser evidence

`frontend/design-system/preview/approval-readable.html` renders the actual
rebased approval component, shell CSS and self-hosted fonts. Isolated headless
Chrome intercepts the pending-approval GET with controlled merge/create-issue
envelopes; no vendor execution, live account, approval or production API was
used. The ego command was refused by the seat wrapper, so the check uses a
fresh local Chrome profile.

The en/zh-CN captures at 1440 and 390 show all inherited-key rows. Opening the
second card's disclosure preserves every JSON own key. Both consent controls
remain usable, with zero page errors, zero POSTs and no horizontal overflow.
`browser-proof.json` records the measurements. Existing base button heights
remain 33px in en and 34px in zh-CN, including at 390; this repair does not
claim a new mobile target-size gate.

These are local component fixtures, not a deployed consent flow or a vendor
execution. Current-head code/security and UX re-gates remain required.

The refreshed proof verifies IBM Plex Sans/Mono loaded and records zero HTTP error responses. The local server explicitly allowed the real dependency directory behind the worktree symlink; earlier captures without loaded fonts are superseded.
