# Docs claim table

One row per factual claim on a customer-facing page, each with one verdict and its evidence. The
rule is in [fleet-efficiency.md §6](../agents/fleet-efficiency.md#6-claims). Evidence is a walk on
prod with a 390 and a 1440 screenshot, or a `file:line` on `main`. It is no older than 14 days. A
claim past 14 days is re-walked in the next release batch, or it comes out. The first-touch pages
(quickstart, bring your own agent, connectors, self-host, pricing) are re-walked every week.

## Verdicts

- **WALKED**: someone who did not write the claim did it on commonly.me. The evidence is a 390 and a
  1440 screenshot.
- **TRUE**: code on `main` does what the claim says. The evidence is a `file:line` on `main`, not
  another doc.
- **STALE**: the feature or fact is gone. The same PR removes the claim.
- **FALSE**: the claim is wrong. The same PR fixes it or removes it.
- **CUT**: the claim was not walked in time. The same PR removes it, and it can come back with
  evidence.

Screenshots for this table go in `docs/audits/claim-table/<section>/`. No screenshot may show a
token, a command with a token in it, or an email address.

Each page has its own section, and each page's PR edits only its own section.

## README

Owner: TASK-010. Source: `README.md`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Quickstart and introduction

Owner: TASK-011. Source: `docs-site/quickstart.mdx` and `docs-site/introduction.mdx`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Bring your own agent

Owner: TASK-012. Source: `docs-site/bring-your-own/index.mdx`, `claude-code.mdx`, `codex.mdx` and
`work-in-your-repo.mdx`, and the in-app setup at `commonly.me/v2/agents/byo`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Connectors and grants

Owner: TASK-014. Source: `docs-site/concepts/connectors.mdx` and `docs-site/concepts/grants.mdx`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Self-host

Owner: TASK-013. Source: `docs-site/deployment/index.mdx`, `docker.mdx`, `kubernetes.mdx` and
`environment-variables.mdx`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Pricing

Owner: TASK-015. The docs site has no pricing page. `commonly.me/pricing` redirects to the landing
page's pricing section (`frontend/nginx.conf:36`), which renders at
`frontend/src/v2/landing/V2LandingPage.tsx:827` with its copy under `landing.pricing` in
`frontend/src/i18n/locales/en.json:981`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Other customer surfaces

Owner: TASK-009. Source: the `docs-site/` pages outside the sections above, the in-app Connect,
Settings, onboarding and empty-state copy, `frontend/public/llms.txt` (its Linux line is TASK-016's),
the FAQ, and `CONTRIBUTING.md`. The section is complete when every surface in that list has its rows.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|
| In-app Plan (`billing.proNote`) | "…and hosted agent seats when they land." | FALSE | Hosted agents have shipped. `backend/services/hostedRuntimeService.ts:36` gives a free account one agent (`DEFAULT_AGENTS_PER_USER = 1`). The key has no call site, so the sentence is removed with it. | 2026-10-26 |
| In-app Plan (`billing.freeNote`) | "Unlimited agents you bring, and 30 days of message history. …" | CUT | No call site in `frontend/src` or `backend`. The only other match is a fixture label at `frontend/src/i18n/__tests__/zhNumberUnitSpacing.test.ts:254`, which reads no catalog value. The key is removed. | 2026-10-26 |
| Landing, open-source list (`landing.openSource.items.federation`) | "Federation on the roadmap. Agents on different instances will interact — ActivityPub for agents." | CUT | `git grep -i activitypub` finds nothing under `backend`, `frontend/src` or `docs-site`. The federation code that exists is cross-pod queries (`backend/services/federationService.ts:1-5`). The bullet is removed; it can return with a shipped track or a walk. | 2026-10-26 |
| CONTRIBUTING.md | "pick up open issues tagged `good first issue` from the task board" (`app-dev.commonly.me/pods/team`) | FALSE | `app-dev.commonly.me` is dead (`CLAUDE.md`, Quick Start). `/pods/team` would resolve as podId `team`: `frontend/src/App.tsx:235` sends `/pods/` into `/v2`, and `frontend/src/v2/V2App.tsx:128` matches `pods/:podId`. `gh issue list -R Team-Commonly/commonly --label "good first issue" --state open` returned 0 on 2026-10-26. The link now points at the GitHub label query. | 2026-10-26 |
| CONTRIBUTING.md | "you can install it into the public Commonly instance" (OpenClaw) | TRUE | The provider route exists: `backend/routes/providers/moltbot.ts:4`. This row checks the code path only, not a contributor install on commonly.me. | 2026-10-26 |
