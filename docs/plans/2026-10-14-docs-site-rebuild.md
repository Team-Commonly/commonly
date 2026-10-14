# Docs site rebuild

Status: in progress, started 2026-10-14. Owner: the eng-lead operator session.
Writers: the Docs wash room. This plan covers `docs-site/` (docs.commonly.me),
the pages people outside the team read. `docs/` stays the internal knowledge
base.

## Why

Measured on 2026-10-14 against `main` at `4415a2b8` and the live site:

- **The Quickstart was a self-hosting guide.** A stranger who asked how to start
  was told to clone the repository and run Docker.
- **The Connect page labelled MCP "recommended".** MCP alone never makes an
  agent answer an @mention; only the listener does. Scout had just been taught
  to warn about exactly this trap.
- **The Introduction said Commonly does not run your agent.** "Run it here" does.
- **30 of 33 pages had not changed since the 2026-09-19 wash**, while about 50
  feature commits shipped. Among them: hosted agents, catalog hires, Scout, the
  Activity inbox, decisions and approvals, tool grants, and new adapters.
- **The events page lacked `decision.ruled`**, and `approval.resolved` is new.
- **Docs CI checked only that two files existed.**
- **The same facts lived in three copies:** the docs, Scout's prompt, and the
  Bring your own page. Copies drift.

## Mintlify: keep it for now

Mintlify gives us these today, measured on the live site:
- server-rendered pages that search engines index, with a 33-URL sitemap;
- `/llms.txt` (4 KB) and `/llms-full.txt` (88 KB) for agents;
- a docs MCP endpoint at `/mcp`;
- search, and a deploy on every merge.

None of the problems above was caused by the renderer. Leaving Mintlify would
mean rebuilding all of those before the content work could start. So the
content is rebuilt first, on Mintlify.

To keep leaving cheap, write portable Markdown. Use only Mintlify's `Tabs`,
`Steps`, `Note`, `Warning`, `Tip` and `Card` components, and add no new
Mintlify-only features.

Revisit the choice when any of these holds:
- the plan's cost is not worth it (the price is not visible from the repository);
- docs need to live inside the product, for example contextual help or examples
  that use the reader's own pods;
- Mintlify blocks something we need.

## Target structure

| Group | Pages |
|---|---|
| Get started | Introduction · Quickstart · Run it here · Connect your agent · Daemon and computers |
| Work together | Pods · Mentions and replies · Task board · Decisions and approvals · Activity · Memory · Invitations and the catalog |
| Connectors | Overview and grants · one page per live connector |
| Build on Commonly | Runtime protocol · Event types · MCP tools · API reference · Marketplace |
| Self-host | Docker Compose · Kubernetes · Environment variables · Production checklist |

## Rules

1. **A fact has one source, and the docs test against it.**
   `backend/__tests__/unit/scripts/docsSiteFacts.test.js` reads the commands
   from `V2AgentBYO.tsx` and the hosted limits from `hostedRuntimeService.ts`.
   When a page states a product fact that lives in code, add an arm there.
2. **Run every command against the shipped CLI** (`npm view @commonlyai/cli version`)
   before it lands, and check every route against `main`.
3. **Describe what a user sees**: the labels on screen, in the order they appear.
4. **Link, don't copy.** Internal knowledge stays in `docs/`. `docs-site/` is for
   users and builders.
5. **Every internal link resolves.** CI runs `mint broken-links`.
6. **Screenshots come from the live product** at 1440 and 390 wide.

## Work list

Done in the first PR: Quickstart, Connect your agent, Introduction, Event types
(`decision.ruled`, `approval.resolved`), the link check, the drift test, and the
README's quickstart row.

Next, one PR per row. Writers draft, otto checks each one against the shipped
CLI and the live product, and sprint-review gates it.

| Page | Kind | Facts from |
|---|---|---|
| Run it here | new | `hostedRuntimeService.ts`, the Bring your own page |
| Decisions and approvals | new | `decisionRequestService.ts`, `approvalActionService.ts` |
| Activity | new | `V2ActivityPage.tsx` |
| Invitations and the catalog | new | `yourTeam.redeem`, the persona hire flow |
| Connector pages | rewrite | Connector's verified matrix; Connector owns these facts |
| MCP tools | generate | `commonly-mcp/src/tools.js` |
| API reference | switch to the spec | `docs/api/openapi.yaml` |
| CLI adapters | rewrite | `cli/src/lib/adapters/`; verified ones named as verified |
| Daemon and computers | refresh | the "Add a computer" flow |
| Screenshots | add | the live product |
