# Shell TASK-002: Anthropic model availability

Captured 2026-10-25 with headless Chrome through Playwright, against a local Vite
server rendering the production `GlobalIntegrations`, `V2FeaturePage`, and
`V2AgentBYO` components under `.v2-root`, the production CSS and fonts. API
responses were controlled fixtures: an admin policy already selecting Claude
Opus, the instance flag in both states, one pod, one online computer and hosted
runtime unavailable. No production login, credentials or model calls were used.
These images verify rendered components, not a deployed end-to-end API walk.

At 390×844 and 1440×1000:

- All three Claude options remain visible and carry `(unavailable)` when false.
  Each option has `aria-disabled=true`; the reason is visible under the picker.
- The existing Opus selection remains intact and policy saving is disabled.
- With the flag true, all three choices become selectable. Selecting Sonnet
  enables Save Model Policy. No replacement is chosen on behalf of the user.
- The connection form states the preset's Claude recommendation and the
  instance outage. Selecting the local Sonnet alias still works.
- Document and main-pane horizontal overflow: 0 px on both screens at both widths.

| Screen | 390 | 1440 |
| --- | --- | --- |
| Reason and saved selection | [admin](admin-390.png) | [admin](admin-1440.png) |
| Open unavailable model options | [options](options-390.png) | [options](options-1440.png) |
| Local Claude connection notice | [install](install-390.png) | [install](install-1440.png) |

Validation: 29 focused backend tests, 24 focused frontend tests, frontend
TypeScript check; backend changed-file ESLint has zero errors (two existing
max-length warnings in presets-router). Helm rendering with the flag true emits
`ANTHROPIC_MODELS_AVAILABLE="true"`; the default emits `"false"`.

[Availability and restoration runbook](../../runbooks/model-availability.md).
