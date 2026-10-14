# Hosted-MCP catalogue sweep, 2026-10-13

*This is evidence for the next catalogue rulings. It sits next to `hosted-mcp-connection-scope.md`, the plan, and `integration-readiness-matrix.md`, the live state. No vendor account or consent was used. Every verdict below comes from public metadata and vendor documentation, measured by two independent passes.*

## Method

- **Measured.** For each app the sweep looked for an official hosted MCP server. Community and third-party servers don't count. It then measured three things without an account:
  1. an unauthenticated MCP `initialize`, recording the 401 and its `WWW-Authenticate` header;
  2. the protected-resource metadata;
  3. the authorization-server metadata: registration endpoint (DCR), CIMD support, revocation, scopes and grant types.
- **The bar** (plan §3, Wren): the credential can't write, meaning a read-only scope separate from write, and registration is self-serve through DCR or CIMD.
- **Second pass.** Every "fit" or "conditional" from the first pass went to a second agent that hadn't seen the first pass's reasoning. Its job was to refute the classification: re-measure from scratch, read the vendor docs, and look for gates such as allowlists, review, plan limits and admin enablement. The final verdict is the second pass's wherever one ran.
- **Next batch.** The three vendors from the 2026-10-09 order (Canva, Miro, ClickUp) went through the same refuting pass on 2026-10-14.

## Headline

- **Seven fits survived the refuting pass:** Basecamp, Buildkite (`/mcp/readonly`), Close, Grafana, Honeycomb, Hugging Face and Otter.ai. Basecamp, Grafana, Honeycomb and Hugging Face support CIMD and need no stored registration. Buildkite, Close and Otter need DCR client storage.
- **7 of 14 first-pass fits were overturned** (Cloudflare, Neon, PostHog, Trello, Typeform, Jam and Readwise). Canva, Miro and ClickUp from the 10-09 order all dropped from "fit" to "conditional". See AX audit entry 80.
- **Most popular apps don't clear the bar.** They offer only a catch-all scope (Notion, Stripe, Intercom, Asana, HubSpot, Salesforce, Klaviyo, Webflow, Wix, Mixpanel), or admit only allowlisted clients (Figma, Vercel, Square, Dropbox, Plane, Egnyte, and Canva's hosted endpoint).

## Why first-pass fits fell

A read scope in metadata is not a credential that can't write. These are the measured reasons, cited in the table:
- **The token behind the scope can still write:** Neon's MCP-layer `read` sits over an upstream token that can.
- **The read scope reaches tools with side effects:** PostHog's `:read` scopes reach a tool proxy that runs third-party tools; Honeycomb's read token's `run_query` creates query objects (pin-exclusion question); Canva's `export-design` creates hosted files.
- **The vendor requires every scope to connect:** Typeform.
- **"DCR" isn't self-serve:** Zendesk's registration endpoint returns one hard-coded shared public client id to every caller.
- **Read-only is a separate resource, not a scope:** Lucid.
- **Gates absent from metadata:** Canva's waitlist and review for `mcp.canva.com` (the self-serve path is a pre-registered client on a different endpoint), plus a usage policy against shared agents running on another user's token; ClickUp's redirect-URI allowlist and review form, documented through 2026-07-27 and gone from the 2026-10-07 rewrite, so ambiguous today; Slack's Marketplace listing requirement; Miro's Enterprise admin allowlist.

## Next batch, after the refuting pass

| App | Final | What decides it |
|---|---|---|
| Canva | conditional, **parked** | Re-check: `mcp.canva.com` admits only waitlist-reviewed clients; the self-serve path is a Developer Portal client on another endpoint; the usage policy restricts shared agents (see above). |
| Miro | conditional, viable | Re-check: viable. DCR is live and revoke exists at `/oidc/revoke`; an Enterprise admin allowlist is possible; refresh reliability is in doubt (see above). |
| ClickUp | conditional | Re-check: no refresh grant, no revoke endpoint, token lifetime unmeasured; a redirect allowlist with review was documented until 2026-07-27 (see above). |

## All measured apps

| App | Endpoint | Registration | Read-only scope | Refresh | First pass → final | Why |
|---|---|---|---|---|---|---|
| Basecamp | `https://mcp.basecamp.com/mcp` | CIMD+DCR | yes | yes | fit → **fit** | Meets the bar: a separate read scope (read vs full) with a documented read-only consent choice, and DCR plus CIMD. |
| Buildkite | `https://mcp.buildkite.com/mcp/readonly` | DCR | yes | yes | fit → **fit** | Use the `/mcp/readonly` endpoint: read scopes separate from write; the read token still exposes `read_secrets_details` and `read_job_env`, which must never be pinned. |
| Close | `https://mcp.close.com/mcp` | DCR | yes | yes | fit → **fit** | Meets the bar. The PRM advertises a separate read scope, and the vendor doc defines it: "mcp.read — read-only access", "mcp.write_safe — can read and write data", "mcp.w… |
| Grafana (Grafana Cloud) | `https://mcp.grafana.com/mcp` | CIMD+DCR | yes | yes | fit → **fit** | The consent page has separate Read, Query and Write boxes. |
| Honeycomb | `https://mcp.honeycomb.io/mcp` | CIMD+DCR | yes | yes | fit → **fit** | The docs say "Read: Required for all Honeycomb MCP operations" and "Write: Required for tools that create or update Honeycomb resources" (Boards, Triggers, SLOs, recipie… |
| Hugging Face | `https://huggingface.co/mcp` | CIMD+DCR | yes | yes | fit → **fit** | read-mcp and read-repos are separate from contribute-repos, jobs and inference-api. |
| Otter.ai | `https://mcp.otter.ai/mcp` | DCR | yes | yes | fit → **fit** | Read-only by construction: the PRM and AS advertise only ["profile:read","conversations:read"] and no write scope exists, so any credential can't write. |
| Amplitude | `https://mcp.amplitude.com/mcp` | DCR | yes | yes | conditional → **conditional** | A separate read scope exists ("all:read" vs "all:write"), along with DCR, refresh and a revocation endpoint. |
| Apollo | `https://mcp.apollo.io/mcp` | DCR | yes | yes | conditional → **conditional** | Granular read scopes exist alongside write scopes (contact_read/contact_write, opportunity_read/opportunity_write, custom_objects_read/custom_objects_write, and others),… |
| Canva | `https://mcp.canva.com/mcp` | waitlist (CIMD) / Dev Portal client | yes | yes | fit → **conditional** | Re-check: `mcp.canva.com` admits only waitlist-reviewed clients; the self-serve path is a Developer Portal client on another endpoint; the usage policy restricts shared agents (see above). |
| ClickUp | `https://mcp.clickup.com/mcp.` | DCR | yes | no | fit → **conditional** | Re-check: no refresh grant, no revoke endpoint, token lifetime unmeasured; a redirect allowlist with review was documented until 2026-07-27 (see above). |
| Cloudflare (API MCP) | `https://mcp.cloudflare.com/mcp` | CIMD+DCR | yes | yes | fit → **conditional** | Re-check: the requested scopes only preselect the consent page; the user can submit 'Full access', so a read request doesn't bound the credential. Since #2125, our callback refuses grants wider than the request, which makes this connectable as read only when the user ticks read. |
| Dropbox | `https://mcp.dropbox.com/mcp` | DCR (gated) | yes | yes | conditional → **conditional** | Separate read scopes exist, but self-serve DCR is allowlisted to five named clients, so Commonly would need a pre-registered App Console app (account plus secret). |
| Front | `https://mcp.frontapp.com/mcp` | none/pre-registered | advertised | yes | conditional → **conditional** | Docs define `read`/`write`/`send`, but live metadata advertises only `feature:mcp`; no DCR or CIMD, so it needs a pre-registered confidential client. |
| GitHub | `https://api.githubcopilot.com/mcp/readonly` | none/pre-registered | no | yes | conditional → **conditional** | docs/host-integration.md:127 says "Dynamic Client Registration is NOT supported by Remote GitHub MCP Server at this time", and the authorization server has no registrati… |
| Gorgias | `https://mcp.gorgias.com/mcp` | DCR | yes | yes | conditional → **conditional** | Granular `:read`/`:write` scopes, open DCR and refresh are advertised; whether a read-only grant reaches the MCP is undocumented. |
| Jam | `https://mcp.jam.dev/mcp` | DCR | yes | yes | fit → **conditional** | Re-check: `mcp:read`/`mcp:write` reproduce, but the write surface includes irreversible `deleteJam`/`deleteFolder`, and how strictly a read token is limited is undocumented. |
| Miro | `https://mcp.miro.com/` | DCR | yes | yes | fit → **conditional** | Re-check: viable. DCR is live and revoke exists at `/oidc/revoke`; an Enterprise admin allowlist is possible; refresh reliability is in doubt (see above). |
| monday.com | `https://mcp.monday.com/mcp` | CIMD+DCR | no | yes | conditional → **conditional** | A read scope (boards:read) is documented only on the path where we register our own Developer Center app with a client ID and secret. |
| PlanetScale | `https://mcp.pscale.dev/mcp/planetscale` | DCR | yes | yes | conditional → **conditional** | Read-only vs full is chosen on the consent screen (resource metadata advertises no scopes); DCR yes, no CIMD; whether a read consent's token can't write is unmeasured. |
| PostHog | `https://mcp.posthog.com/mcp` | CIMD+DCR | yes | yes | fit → **conditional** | Re-check: `:read` scopes reach a tool proxy that runs third-party tools able to change data, plus routes that write product intents. |
| Sentry | `https://mcp.sentry.dev/mcp` | CIMD+DCR | no | yes | conditional → **conditional** | Re-check: the hosted consent form preselects write skills (issue triage, project management); `org:read` is the only read scope, and seer analysis isn't read-only. |
| Trello | `https://mcp.trello.com/v1` | CIMD+DCR | yes | yes | fit → **conditional** | Re-check: same Atlassian AS tenant as the shipped Atlassian entry, so the same client-domain allowlist question applies; it needs its own CIMD document but no separate registration. |
| Zoom | `https://mcp.zoom.us/mcp/zoom/streamable` | none/pre-registered | yes | yes | conditional → **conditional** | Separate granular read scopes exist (e.g. |
| Asana | `https://mcp.asana.com/v2/mcp` | none/pre-registered | no | yes | no | A single catch-all 'default' scope, plus a mandatory pre-registered client with no DCR or CIMD. |
| Box | `https://mcp.box.com` | none/pre-registered | no | yes | no | There is no self-serve registration: each customer's Box admin must mint client credentials in the Admin Console, so one Commonly client cannot serve every tenant. |
| Cal.com | `https://mcp.cal.com/mcp` | DCR | no | yes | conditional → **no** | Re-check: the server ignores the client's `scope` and always requests its fixed default set, which includes about 7 write scopes. |
| Coda (now Superhuman Docs) | `https://coda.io/apis/mcp` | DCR | no | no | no | OAuth tokens are always mcp:all (read and write). |
| Context7 | `https://mcp.context7.com/mcp/oauth` | CIMD+DCR | no | yes | no | The scopes only identify the user (profile, email); |
| Discord | `https://mcp.discord.com/mcp` | none/pre-registered | yes | yes | no | No documented official MCP server for Discord was found; |
| Egnyte | `https://mcp-server.egnyte.com/mcp` | DCR (gated) | no | yes | no | No read-only scope, and each customer's admin must allowlist the client. |
| Evernote | `https://mcp.evernote.com/mcp` | DCR | yes | yes | no | Fails on the paid-only gate. |
| Figma | `https://mcp.figma.com/mcp` | DCR (gated) | no | yes | no | Single catch-all scope: "mcp:connect" (PRM and AS). |
| GitLab | `https://gitlab.com/api/v4/mcp` | DCR | no | yes | no | There is one catch-all 'mcp' scope. |
| HubSpot | `https://mcp.hubspot.com/` | none/pre-registered | no | yes | no | No read-only scope and no self-serve registration. |
| Intercom | `https://mcp.intercom.com/mcp` | DCR | no | yes | no | Only catch-all scopes are advertised: ["mcp","operator"]. |
| Klaviyo | `https://mcp.klaviyo.com/mcp` | CIMD+DCR | no | yes | no | No OAuth scopes advertised; read-only is a URL parameter that filters tools, not a limit on the credential. |
| Lucid | `https://mcp.lucid.app/mcp/readonly` | CIMD+DCR | no | yes | conditional → **no** | Re-check: no read scope exists; read-only is a separate resource (`/mcp/readonly`), and whether the token is audience-bound to it is unmeasured. |
| Microsoft 365 / Outlook (Work IQ) | `https://workiq.svc.cloud.microsoft/mcp` | none/pre-registered | no | no | no | Single catch-all delegated scope. |
| Mixpanel | `https://mcp.mixpanel.com/mcp` | DCR | no | yes | no | Scopes are named per resource with no read/write split; |
| Neon | `https://mcp.neon.tech/mcp` | DCR | yes | yes | fit → **no** | Re-check: the MCP-layer `read` scope sits over an upstream token that can still write, so the credential isn't read-only. |
| Netlify | `https://netlify-mcp.netlify.app/mcp` | DCR | advertised | yes | no | 'read' and 'write' are advertised (netlify/functions/mcp-server/oauth-config.ts:14-19 in netlify/netlify-mcp @237fe772), but nothing enforces them. |
| Notion | `https://mcp.notion.com/mcp` | CIMD+DCR | no | yes | no | Registration is fully self-serve (DCR and CIMD), but the only scope is 'default', so a credential cannot be limited to reading. |
| PayPal | `https://mcp.paypal.com/mcp` | none/pre-registered | no | yes | no | No scopes are advertised (scopes_supported is null in the PRM and the AS), and the vendor doc mentions no read-only option. |
| Pipedrive | `https://mcp.pipedrive.ai/mcp` | DCR | no | yes | no | No read-only scope covers the core CRM objects. |
| Plaid | `https://api.dashboard.plaid.com/mcp/` | none/pre-registered | no | docs say refresh … | no | Not MCP-spec OAuth: the 401 has no WWW-Authenticate header, and no PRM exists (404 at /.well-known/oauth-protected-resource/mcp, /mcp/, and root). |
| Plane | `https://mcp.plane.so/http/mcp` | DCR (gated) | advertised | yes | no | Plane Cloud's hosted OAuth accepts only allowlisted client redirects, and it requests read and write together. |
| Readwise | `https://mcp2.readwise.io/mcp` | DCR | advertised | yes | conditional → **no** | Re-check: the MCP's real gate is `openid` (a token without it gets 401 on every call, per a maintainer-confirmed report), which counts as a catch-all. |
| Render | `https://mcp.render.com/mcp` | none/pre-registered | no | yes | no | There is no registration endpoint and no CIMD, so a client would need a pre-registered client. |
| Salesforce | `https://api.salesforce.com/platform/mcp/v1/platform/sobject…` | none/pre-registered | no | yes | no | Single scope: the read-only server (sobject-reads) and the full server (sobject-all) advertise the identical ["mcp_api","refresh_token"]. |
| Shopify | `https://setup.shopify.com/mcp` | CIMD | advertised | yes | no | Two problems. First, the core objects have no read-only scope: products, customers, orders and inventory appear only as write_* (write_products, write_customers, write_o… |
| Slack | `https://mcp.slack.com/mcp` | none/pre-registered | yes | yes | conditional → **no** | Re-check: unlisted apps are barred from MCP; Marketplace listing is discretionary, needs 10 active workspaces, and gets an enhanced review of every read scope. That amounts to an allowlist. |
| Smartsheet | `https://mcp.smartsheet.com` | none/pre-registered | yes | advertised | no | A read scope exists, but there is no self-serve registration. |
| Square | `https://mcp.squareup.com/mcp` | DCR (gated) | no | yes | no | Clients are allowlisted, and no scopes are advertised. |
| Stripe | `https://mcp.stripe.com` | DCR | no | yes | no | A single catch-all scope, ["mcp"], fails the bar. |
| Supabase | `https://mcp.supabase.com/mcp` | DCR | the read scopes e… | yes | no | The docs say: "Grant write access to all of the available scopes. |
| Teamwork.com | `https://mcp.ai.teamwork.com` | DCR | no | no | no | No read-only scope and no refresh grant. |
| Typeform | `https://api.typeform.com/mcp` | CIMD+DCR | yes | yes | fit → **no** | Re-check: Typeform's own docs require granting all scopes to connect to the MCP, so the read/write split isn't usable. |
| Vercel | `https://mcp.vercel.com` | DCR (gated) | no | yes | no | The resource metadata advertises only "openid" (the authorization server lists openid, email, profile, offline_access), so there is no read/write split. |
| Webflow | `https://mcp.webflow.com/mcp` | DCR | no | yes | no | No scopes are advertised at all: scopes_supported is absent from both the PRM and the AS metadata. |
| Wix | `https://mcp.wix.com/mcp` | DCR | no | yes | no | The PRM advertises only ["offline_access"] and the AS has no scopes_supported, so there is no read scope. |
| Wrike | `https://mcp.wrike.com/v2` | none/pre-registered | no | yes | no | The only scope is read-write, and a pre-registered, admin-created OAuth app is required. |
| Loom | `none` | none/pre-registered | n/a standalone. v… | n/a | unreachable | There is no official standalone Loom MCP server. |
| Zendesk | `https://<subdomain>.zendesk.com/api/mcp` | DCR | yes | yes | conditional → **unreachable** | Re-check: the registration endpoint returns one hard-coded shared public client id to every caller, so registration isn't self-serve, and the grants fail with the static client. |

## Runtime adapters (same day)

The next adapter after OpenCode was measured from the installed binaries in a scratch directory: `--help`, plus Qwen and Gemini runs against a loopback stub. No logins and no model turns.

- **Qwen Code 0.25.1** (fit rank 1): headless `-o stream-json` (JSONL in the Claude-Agent-SDK shape), per-spawn `--mcp-config`, `--bare`, and an OpenAI-compatible provider that can point at our provider proxy. Public seats need HOME isolation, because it reads `~/.qwen/.env` and `~/.env`. Its built-in subagents can run on the operator's other credentials, so they must be excluded.
- **Gemini CLI 0.64.0:** headless `-p … -o stream-json`. Folder trust is on by default and pulls in workspace config. There's no per-run MCP flag, only `settings.json`.
- **GitHub Copilot CLI 1.0.97:** headless `-p --output-format json` and `--additional-mcp-config`. It's proprietary, and whether its terms allow serving public third-party seats is unmeasured. Telemetry is on by default.
- **Goose 1.54.0:** `goose run --output-format stream-json`, with per-spawn extensions as flags. The default mode auto-approves every tool, and the developer builtin (shell plus edit) is enabled.
- **Crush 0.98.1:** `run` has no JSON output, and a project `crushrc` or `crush.json` `$(…)` executes at load. Unsafe for public seats.
- **Cursor CLI** and **Amp:** prompts and threads go to the vendor's servers on the supported path.

## Not measured

- Any authenticated behaviour: whether a read-only token reaches `tools/list`, actual granted scopes, `expires_in`, and revoke effectiveness. Those come from a capture taken with an owner's consent.
- Whether a DCR registration accepts a non-loopback `https://api.commonly.me/...` redirect at each vendor. Testing that would create a client, so it wasn't done.
