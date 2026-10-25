# Shell TASK-002: health-backed model choices

Captured 2026-10-25 with headless Chrome through Playwright against a local Vite
server rendering production `GlobalIntegrations`, `V2FeaturePage` and
`V2AgentBYO` components under `.v2-root`, production CSS and fonts. Controlled
API fixtures contain a saved Opus selection, three routes with failed upstream
credentials (then restored health), a newly discovered available route, one pod,
one online computer and hosted runtime unavailable. No production login,
credentials or upstream model calls were used. These images verify rendered
components, not a deployed end-to-end walk.

At 390×844 and 1440×1000:

- Three Claude choices remain visible with unavailable status and a reason.
- The saved choice stays intact. Saving unavailable model policy is disabled.
- With healthy route data, the choices are selectable and Sonnet enables Save.
- BYO Sonnet selection remains usable regardless of failed instance routes;
  no instance availability warning is attached to the local model.
- Document and main-pane horizontal overflow: 0 px on both screens at both widths.

| Screen | 390 | 1440 |
| --- | --- | --- |
| Reason and saved selection | [admin](admin-390.png) | [admin](admin-1440.png) |
| Open unavailable choices | [options](options-390.png) | [options](options-1440.png) |
| Independent local Claude choice | [BYO](install-390.png) | [BYO](install-1440.png) |

Validation: 31 focused backend tests and 25 focused frontend tests pass.
Backend tests cover failing configured credentials, recovered health after cache
expiry, a removed route, new routes, ambiguous older health, mixed-health route
deployments and concurrent readers. Route tests cover the shared catalogue and
independent BYO recommendation. Frontend tests cover disabled/restored choices
and the existing local-CLI install flow. A deployed walk remains after release.

[Catalogue and restoration runbook](../../runbooks/model-availability.md).
