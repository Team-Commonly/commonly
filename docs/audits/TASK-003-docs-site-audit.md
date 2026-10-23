# TASK-003 — docs-site full wash audit

**Owner:** Folio  
**Measured:** 2026-10-23  
**Base:** `origin/main` @ `fc63afed`  
**Scope:** the 34 `.mdx` pages currently under `docs-site/`. This PR adds the
audit only; it does not edit a page or `docs-site/docs.json`.

## What this audit answers

Each page has one disposition and one destination in the target spine:

- **keep** — the page belongs in the spine; re-walk any claims called out in
  the findings before the page is treated as consumer-verified;
- **rewrite** — the subject is current, but the page needs a new short,
  source-backed pass;
- **merge** — the page is a duplicate or thin split; fold it into the named
  survivor and remove its separate nav destination in the page PR;
- **delete** — the public page describes an unshipped or retired surface. Keep
  the issue or historical record elsewhere when it is still useful.

“Unwalked” means this audit found no current consumer walk record for the
claim. It is not a claim that the feature is false. The next page PR must run
its commands against the registry CLI (`npm view @commonlyai/cli version`) and
check its routes and UI labels against `main` before calling them verified.

## Target spine

| Spine | Purpose |
|---|---|
| **Get started** | Introduction, Quickstart, Run it here, Connect your agent, Daemon and computers |
| **Work together** | Pods, Agents, Mentions and replies, Task board, Decisions and approvals, Activity, Memory, Invitations and catalog |
| **Connectors** | Connector overview and grants, then one page per live connector |
| **Build on Commonly** | Runtime protocol, Event types, MCP tools, API reference, Marketplace |
| **Self-host** | Docker Compose, Kubernetes, Environment variables, Production checklist |

## Tally

| disposition | pages |
|---|---:|
| keep | 12 |
| rewrite | 18 |
| merge | 3 |
| delete | 1 |
| **total** | **34** |

## Page-by-page audit

| Current page | Verdict | New spine destination | Outdated claims, unwalked features, duplicates, or slop |
|---|---|---|---|
| `docs-site/agents/adapters.mdx` | **rewrite** | Build on Commonly → CLI adapters | The adapter table is hand-maintained and calls pi/stub “shipped” without a public BYO walk. The attach examples are manual-path commands, not daemon adoption. Rebuild from `cli/src/lib/adapters/` and label Claude/Codex as the currently walked public paths. |
| `docs-site/agents/authentication.mdx` | **merge** | Build on Commonly → API reference → Authentication | Duplicates `api-reference/authentication.mdx` on token types, issuance, storage, revocation, and daemon credentials. Keep one canonical auth page and fold the useful runtime-token setup into it; the route examples still need a source walk. |
| `docs-site/agents/connect.mdx` | **rewrite** | Get started → Connect your agent | The listener-first correction is right, but the page mixes four walks: listener, daemon, MCP, and raw HTTP. Cursor configuration, manual attach, Windows status, and the exact adapter fallback are not all walked. Split the short harness walks and link to Runtime protocol for HTTP. |
| `docs-site/agents/daemon.mdx` | **rewrite** | Get started → Daemon and computers | The web-app adoption sequence is the right shape, but service install, restart, logs, supported hosts, and the lifecycle table need a current CLI/OS walk. It repeats the daemon path in Quickstart and Connect. |
| `docs-site/agents/events.mdx` | **keep** | Build on Commonly → Event types | The event vocabulary includes the newer decision and approval events and the delivery nonce. Keep the reference, but mark payload examples and acknowledgement behavior as requiring a consumer walk; route and envelope detail overlaps the Runtime protocol page. |
| `docs-site/agents/memory.mdx` | **keep** | Work together → Memory | The typed sections, full/patch sync, provenance, and dedupe story are coherent and current-looking. The full/patch replacement semantics, cycles append path, and response shapes are not recorded as walked here. |
| `docs-site/agents/overview.mdx` | **merge** | Get started → Connect your agent; Build on Commonly → Runtime protocol | Its three connection cards and event-loop summary duplicate Connect and Runtime protocol. Fold the orientation copy into Connect and leave endpoint detail in the protocol/API pages. |
| `docs-site/agents/runtime-protocol.mdx` | **rewrite** | Build on Commonly → Runtime protocol | The route list is hand-copied and incomplete relative to `backend/routes/agentsRuntime.ts`; headers, backoff, files/posts, claims, and thread comments need spec-backed examples. It duplicates the event list and several API-reference pages. |
| `docs-site/agents/tools.mdx` | **rewrite** | Build on Commonly → MCP tools | The table is stale by construction: `commonly-mcp/src/tools.js` now exposes claim/release, artifacts, PR, and other tools not listed here. Generate the inventory from the package and keep configuration in Connect. |
| `docs-site/api-reference/agents.mdx` | **rewrite** | Build on Commonly → API reference → Agents | Useful route coverage, but the hand-written registry and lifecycle surface must be reconciled with the OpenAPI file and current auth middleware. The runtime-protocol link is also a second copy of the contract. |
| `docs-site/api-reference/authentication.mdx` | **keep** | Build on Commonly → API reference → Authentication | Make this the auth survivor after merging `agents/authentication.mdx`. The JWT/runtime/daemon boundary is the right information architecture; verify the exact credential headers and error statuses from the spec. |
| `docs-site/api-reference/events.mdx` | **keep** | Build on Commonly → API reference → Events | Keep as the route-focused companion to the conceptual Event Types page. Verify the ack body, delivery ID requirement, and event-type list against the OpenAPI contract instead of copying the protocol page. |
| `docs-site/api-reference/introduction.mdx` | **keep** | Build on Commonly → API reference | The repository OpenAPI pointer is the right answer while no hosted `/api/docs` reference is published. Keep the base-URL and credential overview short; do not add the dead `/api/docs` claim back. |
| `docs-site/api-reference/messages.mdx` | **rewrite** | Build on Commonly → API reference → Messages | Route, claim-lease, thread, and message-body examples need an OpenAPI/source walk. The page currently duplicates runtime messages and implies a complete surface while omitting newer message operations. |
| `docs-site/api-reference/pods.mdx` | **rewrite** | Build on Commonly → API reference → Pods | The installation/context boundary is useful, but the route list and “full schemas” claim need spec validation. Membership, self-install, files, and posts are spread across this page, Runtime protocol, and the pod concept page. |
| `docs-site/api-reference/tasks.mdx` | **rewrite** | Build on Commonly → API reference → Tasks | The lifecycle is plausible but the agent-token write boundary, query parameters, bodies, lease renewal, and update route are not walked here. Align the page with `backend/routes/tasksApi.ts` and the MCP task tools. |
| `docs-site/concepts/agents.mdx` | **keep** | Work together → Agents | A concise identity/install/memory/adapter model with no obvious stale product claim. Add a link to the missing “Mentions and replies” page in the next content pass; walk the runtime-choice table before treating it as exhaustive. |
| `docs-site/concepts/connectors.mdx` | **rewrite** | Connectors → Overview and grants | The connector/credential/grant distinction is valuable, but the grants section duplicates `concepts/grants.mdx`, while catalog installation is described as “depends on the connector” rather than walked. Make this the short overview and link to the grant and connector pages. |
| `docs-site/concepts/grants.mdx` | **keep** | Connectors → Grants | The lifecycle, attenuation, audience, lineage, and revoke story is the strongest current connector page. Re-run the auth split and live route walk before shipping a new connector batch; keep the implementation-specific claims tied to ADR-001/026. |
| `docs-site/concepts/pods.mdx` | **keep** | Work together → Pods | The room model, pod types, installation boundary, tasks, and files are concise and current-looking. The spine still lacks dedicated Mentions and replies, Decisions and approvals, and Activity pages; do not stuff those surfaces into this page. |
| `docs-site/concepts/task-board.mdx` | **rewrite** | Work together → Task board | The status model is useful, but the “bash” block is pseudo-code that cannot run, and the task API duplicates API Reference → Tasks. Replace it with a short UI/MCP walk and link to the generated API page; retain the current `(sourceRef, title)` idempotency rule. |
| `docs-site/deployment/docker.mdx` | **rewrite** | Self-host → Docker Compose | The local/public boundary is good, but `install.sh`, the health check, Mongo/Postgres fallback, update path, and data-loss warning need a fresh command walk. Keep this as the supported local path and move production detail to Kubernetes/checklist. |
| `docs-site/deployment/environment-variables.mdx` | **rewrite** | Self-host → Environment variables | This is a hand-maintained subset of `.env.example` and deployment templates. Reconcile provider, Discord/Telegram, retired Slack, daemon, and database variables with the current source; distinguish local-only fallbacks from production requirements. |
| `docs-site/deployment/kubernetes.mdx` | **rewrite** | Self-host → Kubernetes | Helm paths and values files need a chart walk. The page claims a generic GKE/EKS/AKS path while the chart still contains legacy agent templates and environment-specific values; verify the supported public deployment shape before preserving the commands. |
| `docs-site/deployment/production-checklist.mdx` | **merge** | Self-host → Production checklist inside the deployment guide | Eleven bare `<Check>` lines are slop without command, owner, or evidence and repeat Docker/Kubernetes/environment guidance. Fold the checks into one source-backed preflight section or make each check link to its owning guide. |
| `docs-site/integrations/discord.mdx` | **rewrite** | Connectors → Discord | The page teaches environment variables and a Pod Settings path, while the current product is connector-oriented and stores integration secrets through the connector flow. Walk the current UI, command registration, permissions, summary cadence, and webhook verification before keeping the page. |
| `docs-site/integrations/github.mdx` | **rewrite** | Connectors → GitHub | The PAT/global-admin setup predates the GitHub App and grant flow now described by the connector UI and grants page. Rewalk installation, grant audience, tools, and issue routes; do not imply task-board coupling. |
| `docs-site/integrations/linear.mdx` | **keep** | Connectors → Linear | This is the only connector page with a recent explicit read-only walk, grant/revoke flow, and untrusted-content boundary. Preserve the no-write-tools and qualifying-pod constraints; recheck UI labels only if the connector surface changes. |
| `docs-site/integrations/webhooks.mdx` | **delete** | No public spine; retain GitHub issue #69 as the product backlog | It explicitly documents a “planned” `/api/webhooks/:podId/ingest` endpoint and says the API is in development. That is not a shipped connector page and should not remain in the public docs navigation. |
| `docs-site/introduction.mdx` | **rewrite** | Get started → Introduction | The product framing is now correct, but the Connectors card points at the GitHub page instead of the connector overview, and “Run it here” has no destination page. Align the cards with the new spine and keep the daemon/listener distinction short. |
| `docs-site/marketplace/manifest.mdx` | **keep** | Build on Commonly → Marketplace → Manifest | The payload and validation rules are a useful contract-shaped page. Verify the component union and limits against the marketplace route/schema tests before calling the example current; keep API operations on Publishing. |
| `docs-site/marketplace/overview.mdx` | **keep** | Build on Commonly → Marketplace | The catalog, kinds, scope, and publish/fork links form a clean overview. The install-from-shell paragraph is not a walk and should remain high-level until a real CLI/app install path is documented. |
| `docs-site/marketplace/publishing.mdx` | **rewrite** | Build on Commonly → Marketplace → Publishing | Publish, fork, mine, unpublish, and deprecate routes are hand-copied and need an OpenAPI/source walk, including wildcard installable IDs and authorization. Keep the manifest page as the payload reference. |
| `docs-site/quickstart.mdx` | **keep** | Get started → Quickstart | The current page starts on commonly.me, presents Run it here/BYO/On my computer, and passes the source-locked quickstart facts test. UX Lead should walk all three tabs and the @mention result; future edits must keep the listener-before-MCP warning and hosted limits in sync with their sources. |

## Cross-cutting findings

### Outdated or risky claims to remove in the rewrite batches

- `/integrations/github` is used as the Introduction’s generic Connectors
  destination even though the spine has a connector overview.
- GitHub’s PAT/global-integration setup is not the same product path as the
  current GitHub App, connector, grant, and tool-broker flow.
- Discord’s environment-variable and Pod Settings instructions need to be
  reconciled with the current connector UI and secret storage.
- The Webhooks page is a roadmap note, not a usable integration. Its endpoint
  is not a shipped public contract.
- The public adapter story is narrower than the internal CLI adapter list.
  The Connect/Quickstart source test allows Claude and Codex; pi and stub need
  an explicit public walk before they are advertised as user paths.
- The API pages must continue pointing to `docs/api/openapi.yaml`; this audit
  found no reason to resurrect `/api/docs` as the API reference.

### Unwalked features

No page in this audit is a substitute for the required walk. The next batch
needs recorded walks for: Run it here; the three Quickstart choices; the
daemon’s macOS/Linux install, adoption, restart, and logs; each public CLI
adapter; MCP configuration per host; task claim/renew/complete; connector
install/grant/revoke; GitHub App access; Discord permissions and summaries;
marketplace publish/fork/deprecate; and the self-host Docker/Helm paths.

The audit also found no current walk record for every API example. API pages
should be checked against `docs/api/openapi.yaml` and the route source rather
than inferred from a neighboring page. The current registry value from
`npm view @commonlyai/cli version` is `0.1.122`; command verification belongs
in each writer PR and should record the exact consumer used.

### Duplicate and slop clusters

- `agents/overview`, `agents/connect`, and `quickstart` repeat the connection
  model; `agents/overview` should merge into Connect.
- `agents/authentication` and `api-reference/authentication` repeat credential
  issuance and scope; the API Reference page should survive.
- `agents/events`, `agents/runtime-protocol`, and `api-reference/events` each
  carry part of the event contract; keep the conceptual page and one route
  reference, with the protocol page owning the loop rather than three copies.
- `agents/tools` and Connect both explain MCP setup; generate the tool list and
  keep client setup in Connect.
- `concepts/connectors` and `concepts/grants` repeat grant semantics; make the
  former an overview and the latter the lifecycle reference.
- `concepts/task-board` and `api-reference/tasks` repeat task operations; make
  one a UI/MCP guide and the other a spec-backed route reference.
- `production-checklist` is a list of checks without evidence or links and
  should not remain a standalone page in its current form.

### Missing pages in the target spine

The current 34-page tree has no public page for **Run it here**, **Mentions and
replies**, **Decisions and approvals**, **Activity**, or **Invitations and the
catalog**. It also has no dedicated page for every live connector currently
seeded or exposed by the product. These are new-page tasks, not reasons to
stuff more material into the existing Pods, Introduction, or Connect pages.

## Handoff

This PR deliberately changes only this audit document. Page rewrites, merges,
deletes, screenshots, and `docs-site/docs.json` changes belong in later,
one-surface PRs after the relevant walk and gate.
