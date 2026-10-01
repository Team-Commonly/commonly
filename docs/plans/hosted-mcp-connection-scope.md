# Hosted MCP connections — scope (TASK-172)

**Status:** scope, 2026-09-27. **Ruling:** Sam, 2026-09-27, relayed by connector-ops in the Connectors v2 pod (74820): "Start now, Linear first." The `hosted-mcp` type starts now and Linear is its first catalogue entry. The build no longer waits for Slack, GitHub and Telegram to go green, because per-person GitHub is the same §10 layer. This answers the decision card (74797). **Scope:** Wren (this note). **Gate:** Vera. **Build:** Kai, after the gate. Code is read at `main` `49d48614`, where no hosted-MCP code exists.

**Amended 2026-10-01** with three catalogue rulings for Sam's personal-agent wave (connector-ops 76040, Wren 76042–76044): what a pre-registered client is (§2, §4), the credential every entry needs (§3, §5), and the entries after Linear (§10, step 8). One correction to 76044 rides here: Google's `drive.file` can write, so it is no read path for Drive or Docs (§10, step 8). Code the amendment cites is read at `main` `59221efb`. Two corrections from reading it against the code followed the same day (Vera 76113): the client record arrives in two steps (§2), and an instance without a pre-registered client's id or secret answers `not_configured` from the entry's readiness (§4). The code they cite is read at `main` `f708ae7f`.

**In short, a hosted MCP server is a second tool source for the grants plan's §10, not a new connector.** It adds one new `Integration.type`, `hosted-mcp`, a per-person Connection (§10.1). Its tools come from a catalogue entry this repo pins, not from the hand-written map in `toolBrokerService.ts`. A member connects their own account through the vendor's authorization server. The broker holds the credential, a room grant scopes it, the vendor runs the tools, and the trail records who acted. Grants work as they do today: tiers, attenuation, budget, expiry, the confirmation floor, approval and the trail. What is new is who wrote the tool list, and most of this note is about that.

In this note, `§10.x` means that section of [tools-catalogue-room-grants.md](tools-catalogue-room-grants.md), "the grants plan", and "the entry" means one catalogue entry (§3).

**Scope boundary:**

- **This replaces [linear-connector-scope.md](linear-connector-scope.md) (TASK-144) as the way Linear is built.** That note specified an OAuth app in `actor=app` mode, with hand-written broker tools over Linear's API and an inbound webhook, so a decision card could be answered from Linear (its §5, readiness column C6). This type does not deliver C6: a hosted server only answers calls we make, so nothing comes back to us from Linear. If Sam wants C6 from Linear later, that note's §5 is still the design, and it would land as its own inbound path beside this row.
- **This is not the ADR-027 projection.** [ADR-027](../adr/ADR-027-pm-tool-projection-contract.md) (Proposed) names Linear the second provider for projecting a pod's task board both ways. This type syncs no work items: an agent reads Linear with one member's delegated credential, inside a grant.
- **This extends §10 without restating it.** §10 is held for Sam's read. 74820 starts its layer with this type: the per-person record, OAuth intake, the credential fence and removal. §10.6's three questions are still Sam's; §11 says which one this type makes live.

## 1. What kind of row this is

The grants plan's two questions from §10.0, in order:

1. **What does the row do?** An agent acts at an outside service through it, so it is a **Connection**: it lives on the Tools page, and pieces 1–5 apply. It is never a channel, because a hosted MCP server answers calls and carries no pod's messages.
2. **Whose account does the provider see?** The member's. `hosted-mcp` ships in **member mode only**: one row per person per entry, owned by `createdBy`, and that person is its only granter.

Vendors do offer an app identity on these same servers. Linear's bearer path lets a client "interact with the MCP server as an app user", and GitHub's server takes installation tokens to "operate as the application itself" (`docs/policies-and-governance.md` in GitHub's MCP server repository). An app mode is therefore possible later. It would be an App row (§10.2 path 2) with its own type, as `github-app` is, not a mode flag on this one. §10.0 makes `type` the only fact that tells an App row from a per-person row, so one type holding both would leave question 2 without an answer.

## 2. The record

```ts
{ type: 'hosted-mcp',
  scope: 'user', createdBy: <the person>, status: 'pending' | 'connected' | 'disconnected' | 'error',
  config: {
    entryId: 'linear',              // which catalogue entry (§3); fixed at the first connect
    intake: 'oauth',                // the only intake for this type
    providerSubject,                // the provider's stable id for the account, when the AS gives one (§4)
    grantedScope: 'read openid',    // the token response's `scope`, what the person consented to
    clientId,                       // the client that minted the pair: a pre-registered id, the CIMD document's URL or a DCR registration (§4)
    revokePage,                     // the entry's `revoke.page`, copied at each connect; read once the entry is gone (§3)
    expiresAt, credentialRef, refreshTokenRef, refreshGeneration, credentialHint, // §10.1, unchanged
    pendingAuth } }                 // state, browser nonce, PKCE verifier, expiry; present only mid-connect (§4)
```

The row has no `podId`, no `owner`/`repo` and no `providerRole`. A hosted entry is not repo-shaped: the account's reach is what the provider enforces, and the entry's tools decide which parts of it an agent can touch. `grantedScope` is what a later write tool will check to tell a row that needs re-consent from one that does not (§5).

**One row per `(createdBy, config.entryId)`.** This is a partial unique index over `hosted-mcp` rows. A second Connect by the same person on the same entry reuses the row: the new pair replaces the old one through the §10.3 fence, and it never creates a second row. If one person held two rows for one vendor, the page could not say which one a grant uses, and the two would go through removal separately. A person with two accounts at one vendor gets one at a time in v1. `providerSubject` is recorded from the first connect, so widening the key later is an index change and not a migration.

**A reconnect as a different account revokes the row's grants.** A grant is made against the reach of the account connected at the time. When a reconnect's `providerSubject` differs from the stored one, `revokeConnectionGrants` runs before the new pair is written. It also runs when the two cannot be compared because the AS gave no subject. The TASK-148 guard (`toolBrokerService.ts:488–512`) cannot catch this, because the row and its `createdAt` survive the reconnect.

**The row records which client minted its pair** (76042). The callback writes `config.clientId` with each pair, whatever the client's kind. It is a snapshot to compare against, never the client a call uses, which is always resolved from the entry and the instance (§4). A refresh token is bound to the client it was issued to (RFC 6749 §6), and RFC 7009 §2.1 has the AS refuse a revocation from any other client. So a row whose `clientId` is not the client its entry uses now is sent to reconnect before any call (§9), and its removal sends nothing. A host move changes a `cimd` client's id, so it does the same; rotating a pre-registered client's secret keeps its id and moves no row. Every row connected before this key existed was minted by Linear's CIMD document, since Linear is the only entry so far, so the key arrives in two steps (Vera 76113). The build that writes it refuses only a recorded client that differs, and does not refuse a connected row with none. Old code still mints rows without the key until that build's rollout has finished, and refusing them would send a fresh connection to reconnect. After the rollout, the backfill writes that document's URL to every row that holds a pair without the key. The refusal of a connected row without the key ships with the second entry, not before.

**Only the callback writes a connected row.** The generic `POST /api/integrations` refuses `type: 'hosted-mcp'` by name, as it refuses `github-app` at `routes/integrations.ts:380`. So `createdBy` is always the person who consented, never a field from a request body. Every `config` key this note adds joins `SERVER_OWNED_CONFIG_KEYS` (`utils/serverOwnedConfigKeys.ts:24`). `credentialRef`, `refreshTokenRef` and `pendingAuth` also join `INTEGRATION_SECRET_CONFIG_KEYS` (`models/integrationPublicConfig.ts:23`).

The two references are two new kinds in `connectorSecretKinds.ts` (`:65`), both with provider `hosted-mcp`: an access token at `config.credentialRef` and a refresh token at `config.refreshTokenRef`. That module is the one place a kind is added, and a ref path it does not name is a secret the orphan sweep deletes.

## 3. The catalogue entry, and why upstream cannot write it

Entries live in this repo, one module per vendor, and change only by PR. An entry holds:

- `id`, `title`;
- `resource`: the MCP server URL, which is also the RFC 8707 resource;
- `issuer`: the authorization server its protected-resource metadata names, checked at intake;
- `client`: `pre-registered`, `cimd` or `dcr` (§4). A `pre-registered` entry names only the kind: its client's id and secret are instance config, never entry data (§4);
- `scopes`: requested at authorization;
- `revoke`: a `page`, where a person revokes by hand, and also an `endpoint` when the AS's metadata advertises an RFC 7009 revocation endpoint (§9);
- `tools`: each with the name and description an agent sees, the upstream name, a class (`read` or `write`), `irreversible`, a pinned `inputSchema`, and the upstream annotations as seen when the tool was pinned.

Entry ids are checked at load against both the hosted catalogue and the builtin tool Installable ids. They are map keys in the catalogue projection; reusing `github` would replace the GitHub App's metadata and readiness gate. `assertHostedMcpEntries` accepts the reserved-id set from `toolInstallables.ts`, which owns both maps and avoids an import cycle. The named tests prove both the collision refusal and the empty-set control.

**`revoke` names its kind because the URL cannot.** Both are https URLs, and only the `endpoint` key decides whether removal calls the vendor (§9). A page that answered that call with 200 would read as a revoke that never happened. A 200 proves no more at a real endpoint, which answers 200 "if the token has been revoked successfully or if the client submitted an invalid token" (RFC 7009 §2.2). Every entry names a page, an entry with an endpoint included, because a removal that cannot revoke at the vendor hands the person that page (§9). So the entry load refuses an entry with no page, a key other than those two, or a URL that is not https, and step 7 (§10) shows the revoke took by something other than its status.

**An entry can leave the catalogue, so removal does not depend on it.** A PR that drops or renames an entry cannot see whether any instance still holds a row naming it, so nothing here relies on entries staying. Each time the callback connects a row, it copies the entry's `revoke.page` to the row's `config.revokePage` (§2). That key is server-owned like the rest, because a PATCH that rewrote it would send the person somewhere else to revoke. Once the entry is gone, the connect routes answer `unknown_entry`, the mint refuses the row `broker_unavailable` (`resolveBrokerFor`, `services/installable/toolInstallables.ts:137`), the broker's credential read refuses it (`services/hostedMcpCredentialService.ts:223`), and removal finishes with the copy (§9). The endpoint is not copied. A token is sent only to an endpoint a current entry names, because the endpoint may be why a PR dropped the entry.

**The entry is the only source for everything an agent sees and everything a grant is checked against.** Upstream can take a tool away or refuse a call. It cannot add a tool, loosen a schema, rename a tool, reword a description or reclassify a tool. The MCP spec (2026-07-28, tools) says "clients MUST consider tool annotations to be untrusted unless they come from trusted servers", and a vendor's server is not one we run. A tool description is also prompt text that reaches every seat holding a grant. An edit made upstream would change every seat's prompt with no review; pinned here, the same change is a PR a gate reads.

**Read permission does not bound egress.** A read tool can make the provider fetch a caller-chosen URL, then return the result into the agent's context. OAuth scope bounds what the credential can change; annotations describe the vendor's claim, and neither constrains where a read result goes. The pinned schema is also not an argument validator: the broker forwards arguments, and narrowing a property in the pin only makes the live schema drift. So v1 excludes a whole tool whenever its input lets the caller choose a provider-side fetch target. Linear's `extract_images` accepts free markdown, and `get_attachment` can fetch an external URL named by an attachment when `format` is `content`; both are out. `get_diff` and `get_diff_threads` accept review and GitHub PR URLs as exact keys into Linear, not as URLs to fetch, so they remain.

**Each entry tool becomes a `ToolDefinition`** (`toolBrokerService.ts:16–26`) with:

- `connectionType: 'hosted-mcp'` and the new `entryId`;
- `requiredWriteMode` from the entry's class, and `irreversible` from the entry;
- the pinned `inputSchema`;
- a `call` that forwards to the vendor's `tools/call` under the upstream name.

`getToolDefinitions()` (`:429`) returns the hand-written map plus every entry's definitions. Names are namespaced by entry (`linear.<tool>`), so no two entries collide with each other or with the GitHub tools. Required mode still "comes only from this server-side definition map" (`:700`). The native projection's filter (`grantBrokerProjectionService.ts:180`) reads the definition's `requiredWriteMode`, so it reads the entry's class with no change to that line.

**Drift is a named refusal, not a silent change.** The broker compares each pinned tool with the upstream `tools/list`, taken with the row's own credential. The spec says the list "MAY vary by the authorization presented on the request", so a list taken with any other credential proves nothing about this row. The comparison is cached per row with a TTL, which the build measures (minutes, not per call). For each pinned tool:

| upstream | result for that tool |
|---|---|
| missing | `tool_unavailable` |
| `inputSchema` differs from the pin | `tool_drift` until a PR re-pins it: the owner approves canonical args under the pinned schema, and a changed schema can change what those args mean |
| annotations moved toward write since the pin: a claim it recorded (`readOnlyHint: true`, `destructiveHint: false`) is no longer made, or a tool pinned with `readOnlyHint: true` now also says `destructiveHint: true` | `tool_drift`: the hint grants nothing, but a vendor withdrawing it is a reason to stop |
| present and unchanged | offered and callable |

Upstream tools that are not in the entry are never offered and never callable, and that is not an error. A drift refusal names the tool and the entry, so whoever reads the trail knows the re-pin is ours to do. `listToolsForGrant` (`:557–590`) is extended to leave out tools refused for either reason, so an agent is not offered what will be refused.

**A claim the pin recorded must still be made, and silence withdraws it.** The spec defaults an absent `readOnlyHint` to `false` and an absent `destructiveHint` to `true` (schema 2026-07-28, `ToolAnnotations`), the unsafe value both times. A vendor that stops saying `readOnlyHint: true` or `destructiveHint: false` has withdrawn the claim. A live `destructiveHint: true` also contradicts a recorded `readOnlyHint: true`; the entry load refuses that pair (#2014), and drift does not admit later what the entry refuses. Otherwise a newly spelled default changes nothing, so a pin that recorded neither claim does not drift when the vendor starts saying `destructiveHint: true` (75445, 75449, 75454). Each arm reads the annotations the pin recorded, not its class, and where a withdrawn claim and the contradiction coincide, the refusal names the claim (75457). A `read` pin is not asked to record `destructiveHint: false`: the spec makes that field meaningful only when `readOnlyHint` is `false`, and GitHub's server sets it on none of its 60 read tools (`github/github-mcp-server` at `85598ba`). A vendor that sends `true` there has still said something, and that is what the entry refuses.

**A tool pinned `read` carries the vendor's own `readOnlyHint: true`.** The spec's default for an absent `readOnlyHint` is `false` (schema 2026-07-28, `ToolAnnotations`), so a tool whose vendor says nothing is one the vendor has not called read-only. A pin without the hint would also leave the drift row above dead for that tool, because a pin that never held the hint cannot see it withdrawn (Vera 75423–75424). The entry load refuses such a pin, as it refuses a `read` pin whose annotations say `readOnlyHint: false` or `destructiveHint: true` (#2014). The hint still grants nothing; its absence refuses. **A vendor that sends no `readOnlyHint` gets no entry, not a write-only one** (75440). The class records what a tool does, so a read tool is never pinned `write` to get past a missing hint, and §5's answer on attribution cannot arrive that way.

**Every entry's credential must be unable to write** (76043). A read never parks (§5). With a credential that can write, a tool pinned `read` is kept from writing only by the vendor's word, its annotations, and those can be wrong: Linear's `extract_images` declares `openWorldHint: false` and fetches the URLs in markdown its caller writes (Vera 76034). A scope the vendor enforces holds whatever the pin says, as Linear's `read` does (§4). So an entry requests only scopes its vendor's docs say cannot write. A vendor that offers none gets no entry until it does: Notion, Sentry and Stripe, on the survey of 2026-10-01 (76040). Any other fence, a vendor's read-only path included, is a new mechanism and a gate item.

**The Linear entry is pinned at build** from a `tools/list` taken on a consenting test account, with read tools only, each re-described by us. The measurement contains 38 tools; the entry pins 36 and leaves out the two caller-chosen fetch paths above. The earlier unauthenticated research named no Linear tools. Linear's MCP docs never mention annotations, so whether its read tools carry the hint is known only from the authenticated list (§11).

## 4. Credentials and intake

**The order is a pre-registered client where the vendor requires one, then a Client ID Metadata Document (CIMD), then Dynamic Client Registration only as a fallback.** The MCP authorization spec (2026-07-28) says DCR "is deprecated and retained for backwards compatibility with authorization servers that do not support Client ID Metadata Documents". Every authorization request and token request carries RFC 8707 `resource`, set to the entry's `resource`. The spec says it "MUST be included in both authorization requests and token requests" and "MUST identify the MCP server".

**Linear uses CIMD.** Its authorization server metadata (fetched 2026-09-27 from `https://mcp.linear.app/.well-known/oauth-authorization-server`) advertises:

- `client_id_metadata_document_supported: true`;
- `code_challenge_methods_supported: ["S256"]`;
- `token_endpoint_auth_methods_supported` including `none`;
- `authorization_response_iss_parameter_supported: true`;
- `revocation_endpoint: https://mcp.linear.app/token`.

Its protected-resource metadata names `https://mcp.linear.app/mcp` as the resource, served by that AS, with scopes `read` and `write`.

With CIMD, our `client_id` is an HTTPS URL on the instance's own API host. That document names the client, its one redirect URI and `token_endpoint_auth_method: none`, and its own `client_id` is its URL. There is **one document per instance per entry**. Each AS therefore sees its own client id with exactly one redirect URI, and the callback path identifies the entry. That is the redirect-per-AS defence against mix-up.

The document has a rate limiter, as every route does (`backend/__tests__/unit/routes/routeRateLimitGuard.test.js`), and a deliberately loose one. The AS fetches it for every member of the instance from a few addresses of its own. A bound sized for one browser would refuse the vendor, and every connect on the instance would fail at once (Vera 75265).

Nothing is registered and no client secret is stored anywhere. A self-hosted instance connects with no setup at the vendor, which a pre-registered client cannot offer, since every instance would register its own app with every vendor. It is a public client: PKCE `S256` on every flow.

**Whether Linear's AS accepts our CIMD end to end is a build measurement.** The research behind this note made unauthenticated GETs of discovery documents only. If it refuses, the fallback is DCR (advertised at `/register`), with one registration per instance per entry and never one per person; its storage is specified then.

**Linear v1 requests `read openid` and nothing else.** Linear's docs say that with only `read`, "the underlying token can’t reach write APIs". So v1's credential cannot write, whatever a grant says, and the §5 rule guards the entry's next version rather than being the only fence. Linear also serves a `/mcp/readonly` path that "only ever exposes read tools". That narrows the list, which the entry already does, not the token, so v1 uses the scope. `openid` is advertised in the AS's `scopes_supported`, and v1 requests it only for `providerSubject`, which §2's account-change rule needs. Whether the AS issues an ID token is measured at build. v1 does not request `email`: the page names a row by its Commonly owner, and a room has no need to see a vendor email.

**GitHub is the case CIMD cannot serve.** `github.com/login/oauth` advertises neither DCR nor CIMD, so a GitHub entry uses a pre-registered client: the GitHub App's own, through the user authorization of §10.2 path 1. GitHub's server accepts "GitHub Apps that sign in (are authorized by) a user" (the same `docs/policies-and-governance.md` as §1). That is how per-person GitHub is the same §10 layer (74820).

**A pre-registered client is instance config, never entry data** (76042). Its id and secret are held by the instance, through ESO on the hosted one, and neither appears in an entry or a repo file. The secret appears on no row either. A row keeps only a snapshot of the id that minted its pair (§2), and instance config stays the id's source: every exchange, refresh and revocation reads the id from there, never from a row. The id already arrives that way, as the entry's own `<ENTRY>_CLIENT_ID` (`resolvedClientId`, `services/hostedMcpIntakeService.ts:145`), and the secret arrives the same way. An instance that lacks either does not offer the entry. The entry's readiness answers `not_configured`, as GitHub's does without its App's credentials (`services/installable/toolInstallables.ts:74–76`), so the catalogue projection lists it as unavailable and the page offers no Connect (Vera 76113). A `cimd` entry still has nothing to set, so its readiness stays constant. The instance also treats the entry as one the catalogue no longer has (§3): its rows are refused, and their removal finishes with the row's copied page (§9). The start route's `client_not_configured` stays as the backstop. It is a confidential client: it authenticates with its secret at the token and revocation endpoints, by a method the AS's metadata lists, and it still sends PKCE `S256`. The entry's callback is registered with the vendor as a redirect URI. Google is the first such vendor. Its setup page for its MCP servers says to create a "Web application" client and copy its "Client ID and Client Secret" (developers.google.com/workspace/guides/configure-mcp-servers, updated 2026-09-18). `accounts.google.com`'s metadata lists no registration endpoint and no CIMD support, and names `client_secret_post` and `client_secret_basic` as its token endpoint's auth methods (fetched 2026-10-01).

**The flow** is the §10.2 route family, one per entry, in the shape of Slack's connect flow (`routes/installables.ts:174`). `POST /api/integrations/connect/hosted-mcp/:entryId/start` takes `auth` and is rate-limited like Slack's. It upserts the caller's row for the entry at `status: 'pending'` if none exists, and writes `config.pendingAuth`: a single-use state bound to the caller and the entry, a second nonce for the browser, the PKCE verifier and a short expiry. It answers with the `authorizeUrl` and sets the browser nonce as an `httpOnly`, `sameSite: 'lax'`, `secure` cookie whose path is the callback's. The page then sends the browser to the vendor. A row that is already connected keeps working while this happens, the way Slack's `pendingBind` works.

The page's call to start passes `withCredentials: true`, as Slack's does (`frontend/src/v2/components/V2ConnectorsPage.tsx:588`). The API is on another origin from the app, so without it the browser drops the cookie and every callback refuses. A backend test sets the cookie itself and cannot see this. The page's test asserts the flag, as the Slack arms do (`frontend/src/v2/__tests__/V2ConnectorsPage.test.tsx`), and step 7's walk on the deployed build shows that a real browser keeps the cookie.

`GET …/:entryId/callback` is a browser redirect with no bearer token, so it checks two secrets, as Slack's does (`routes/installables.ts:283–301`). The state names the flow, and the cookie proves that the browser finishing it is the one that started it. The state alone binds nothing. It travels in a URL that the starter holds and can hand to someone else, and if that person approved, their tokens would land on the starter's row (Vera 75250). A callback with no cookie refuses `invalid_state` before it looks up the row. A cookie that does not match the row's nonce, compared in constant time, refuses `browser_mismatch` without consuming `pendingAuth`, so a wrong browser cannot burn a real flow. The callback is rate-limited by address, as Slack's is (`:383`). Unlike Slack's, a throttled callback still redirects to the page, with `rate_limited`. Its caller is a browser mid-navigation, and every outcome of the callback lands where Connect can be offered again, not on raw JSON (Vera 75269). It refuses a state it did not issue, a used state and an expired state. It refuses an `iss` that is not the entry's `issuer`, per RFC 9207, since Linear advertises it. It exchanges the code at the entry's token endpoint with `code_verifier` and `resource`, then writes the pair through the §10.3 fence and clears `pendingAuth`. A pending row is never grantable, because the mint requires `connected`. Once its expiry passes it holds nothing secret, and the next start overwrites it.

**`credentialFor(connection)`** (§10.3, not on `main` yet) is the only place the access token is decrypted. It refreshes behind the fence, and `call` sends the token as a bearer to the vendor's Streamable HTTP endpoint and nowhere else. Every refresh is treated as rotating, whatever the vendor does, which is the case the fence exists for. The spec says clients "MUST NOT assume refresh tokens will be issued"; an AS that issues none gives a row whose `expiresAt` is the access token's, and when that passes the row goes to `error` with "reconnect". Linear's MCP token lifetimes are not in its metadata and are measured at build. No agent environment, tool result or trail row ever holds the token.

## 5. When a hosted write is the member's own act

In member mode, whatever an agent writes appears at the vendor as the member. [linear-connector-scope.md](linear-connector-scope.md) §2 refused Linear's `actor=user` because it "attributes an agent's words to a human". This type narrows that refusal rather than reversing it. **A read is delegated access. A write counts as the member's own act only when all four of these hold:**

- **(a) Every non-read call parks.**
  - The mint refuses `writeMode: 'write'` on a `hosted-mcp` row, with `write_requires_confirm`.
  - Attenuation cannot raise a mode (`roomGrantService.ts:346–348`, `grant_not_attenuated`), so every grant descended from one on this row is `read` or `write-with-confirm`.
  - Under `read`, a non-read tool is refused `write_mode_not_allowed` (`:417–418`).
  - Under `write-with-confirm`, every non-read call parks for approval (`toolBrokerService.ts:717–718`). A `write` grant would run non-read, non-irreversible calls without parking, so the mint refusal is what makes the rule hold.
- **(b) Only the owner approves.** `approvalActionService.ts:493` refuses anyone but the pending call's `ownerUserId`, and `:502` refuses a bot. For this type, `ownerUserId` is the Connection's `createdBy`, carried as it is today (`toolBrokerService.ts:519`, `:742`).
- **(c) The owner sees what they approve.** `V2ApprovalCard.tsx` fetches the pending call's canonical args for the owner only (`:99`, "Approval buttons must not allow an owner to approve blind") and renders them (`:203`).
- **(d) What runs is what was approved.** `executeApprovedToolCall` refuses `args_digest_mismatch` (409) when the args no longer match the approved digest (`toolBrokerService.ts:842–843`).

Under these four, the member has read and approved each written call, one at a time. Reads carry no words of the agent's, so they need none of the four. v1's Linear entry has no write tool, and its credential has no `write` scope. A write tool added later also needs re-consent with `write`, and `grantedScope` is how the page tells which rows need it. That alone does not meet §3's bar: the same token would serve every read in the entry, and a read never parks. So the first entry with a write tool also needs a mechanism that keeps a credential able to write away from every call that has not parked. That mechanism is a gate item, specified with that tool, not here.

## 6. Which surface may offer a hosted write tool

This answers Vera 74793/74794, in Kai's wording (74826). Three surfaces can call a hosted tool:

- the grants-MCP endpoint a seat's runtime loads (`POST /api/mcp/grants/:grantId`, `routes/mcpGrants.ts:94`);
- the native-runtime projection (`grantBrokerProjectionService.ts:258`);
- a direct call.

All three end in `toolBrokerService.callTool` (`:685`). **For every call an agent makes, the park is one function, so it is the enforcement, and no surface routes around it.** The native projection offers only read tools, `getToolDefinitions().filter((definition) => definition.requiredWriteMode === 'read')` (`:180`). That is an **offering filter, not the enforcement**: a write reaching `callTool` from there would hit the same park. This corrects the TASK-172 ruling's part 3, which called `:180` enforcement.

One path reaches the vendor without passing the park, and it is the approval itself (Vera, 74860). `definition.call` has two call sites: `:799` inside `callTool`, past the park, and `:861` inside `executeApprovedToolCall` (`:833`), which runs only from `approvalActionService.ts:595` once the owner approves. That path never re-parks, by design, so its gate is (b) and (d), not (a). The owner check lives in its caller (`approvalActionService.ts:493`, `:502`). The digest check at `:842–843` is inside it, but compares the args against whatever `expectedArgsDigest` the caller passes; today both come from the approved row (`approvalActionService.ts:671–672`). Nor does the function bind to an approval: `approvalId` is only written to the trail rows (`:868`, `:879`), never checked against a parked call, and the row it reads is the grant, by `grantId` (`:845`; Vera, 74864). **A second caller of `executeApprovedToolCall` inherits no park, no owner check and no approval binding. It must check the owner itself and take the args and the digest from the owner-approved record.**

So:

- **the grants-MCP surface is the only surface that may offer a hosted write tool, and every non-read call parks there for the owner**;
- the native projection offers none, through the existing filter reading the entry's class;
- a direct call is the same function.

`tools/list` already follows the grant (`listToolsForGrant`, used by the endpoint's ListTools handler since TASK-146), so a `read` grant lists no write tool on any surface.

**A seat that cannot be confined is offered no hosted tool, reads included** (Kai, 74877). A hosted grant reaches a seat through the same grants endpoint as every grant, so it inherits TASK-063's refusal unchanged, and that refusal drops the whole entry, not a tool class. The server withholds the entry at the projection (`routes/agentBinding.ts:115`), the daemon withholds it again (`withholdGrantBroker`, `cli/src/lib/grant-broker-guard.js:230`), and the pi client refuses the broker's path (`cli/src/lib/adapters/pi-mcp-client.mjs:39`, `:68–74`). The two halves reach pi by opposite rules. The daemon admits only the adapters that confine, claude and codex (`grant-broker-guard.js:179–180`), while the server refuses only the adapters it lists as confining on no host, today pi (`CONFINEMENTLESS_ADAPTERS`, `backend/services/grantBrokerConfinement.ts:65`, `:124`). Both refuse a pi seat `grant_broker_unconfined`, reason `adapter_cannot_confine`, so it gets no Linear tool at all.

That is intended, and there is no read-only arm. A read never parks (§5). On a seat nothing confines, the park still stops each write for the owner, but a read's result goes wherever the seat can send it, and confinement is the only bound on that. An arm that admitted reads to such a seat would admit exactly the calls the refusal exists for. The refusal is a named state (§9): the grant read returns it, with the fix in its detail, which is to move the seat to claude or codex (`routes/grants.ts:239`). No page on `main` reads that field yet, so the grant's page must show it before step 7's walk (§10).

The refusal must also hold where the tool runs, not only where the entry is offered. The grants endpoint evaluates the server's predicate (`grantBrokerRefusal`) for the calling seat, on `tools/list` and before `callTool` on `tools/call`, and trails a refused call `refused`, not spent. That was ruled on TASK-111 (2026-09-23) and is TASK-175, built before the mint admits the type (§10, step 4). Because the server's rule lists what it refuses, an adapter added to the CLI later would be refused by the daemon and admitted at the endpoint until the server lists it too, so TASK-175 also pins the two lists together with a test.

**What each arm can witness.** v1's Linear entry has no write tool, so these arms run on a test entry that has one, against a stub MCP server. They witness the mechanism, not Linear.

- **The park, through the grants endpoint.**
  - A `write-with-confirm` grant on a hosted row: calling the write tool with `tools/call` parks it, and the stub sees no call.
  - When the owner approves, the stub sees exactly one call, with the canonical args.
  - Approval by another member is a 403, and by a bot is a 403.
  - Args changed after approval give a 409.
- **The filter, through the projection.** For a grant that names the write tool, the projection offers no write tool at all.
- **The mint.**
  - `write` on a hosted row is refused `write_requires_confirm`.
  - Attenuating `write-with-confirm` to `write` is refused `grant_not_attenuated`.
- **A `read` grant.** The write tool is absent from `tools/list`, and calling it anyway is refused `write_mode_not_allowed`.
- **A seat that cannot confine.** A pi seat in the grant's audience is refused, never parked: the projection and the daemon withhold the entry with `grant_broker_unconfined`, reason `adapter_cannot_confine`, and the grant read names it. A read tool's `tools/list` and `tools/call` reaching the endpoint anyway are refused with the same code, and the stub sees no call.

## 7. What changes in the mint, the broker and the catalogue

**`installationId` is the row's `_id`.** On a hosted grant, `connectionId` = `installationId` = the row's `_id`. The row has neither installationId slot: top-level `installationId` (`models/Integration.ts:184`, unique and sparse) and `config.installationId` (`:213`) both stay unset. That rests on who writes to the row: its only writers are its own connect routes (start and callback, §4), which write neither slot; the generic route refuses the type; and `config.installationId` is already server-owned. The mint's `connection.installationId || connection.config?.installationId` (`routes/grants.ts:309`) would come out empty and be refused `invalid_installation` (`:313–314`), so the mint sets it to the `_id` for this type. An `_id` is never reused, so the TASK-148 class, a grant matching a re-created row by an external id, cannot arise.

**The mint** (`routes/grants.ts:298`):

- It accepts `hosted-mcp` beside `github-app` at the type check (`:310`). For this type it also requires `connected`, no `revokedAt`, a `credentialRef`, and an entry the catalogue still has.
- It refuses `write` (§5).
- `resolveBrokerFor` (`:352`) takes the row, not its type. For this type it returns that entry's tools, so `invalid_tools` (`:353–360`) refuses a tool from another entry.
- The granter check (`connectionOwnerId`, `:265–267`) is unchanged, because `createdBy` is the person.
- TASK-147 lands with removal, in step 6 (§10), and the first catalogue entry does not ship without it. This is the second grantable type, so every path that can remove the row must call `revokeConnectionGrants` before the row moves, witnessed per path. `DELETE /api/integrations/:id` already does (`routes/integrations.ts:797`). Pod deletion (`controllers/podController.ts:730`, `deleteMany({ podId })`) and the reconciler's and admin Installable routes' updates, which match on the top-level `installationId`, cannot reach a row that has no `podId` and no installationId slot. The witness for those paths is that a hosted row and its grants come through untouched. Pod deletion never calls a vendor. If a writer ever gives a grantable row a `podId`, the fix is to keep that row out of the sweep, not to route the sweep through removal. The row belongs to its owner, not to the pod, and `DELETE /api/integrations/:id` removes it. §2's account change is the one new path, and it revokes.
  - The legacy Discord delete (`routes/discord.ts:241`) looks its row up by `installationId` and `type: 'discord'`, so the same witness covers it.
  - Pod deletion's case also needs the row to stay without a `podId`. `PATCH /api/integrations/:id` can set one on a user-scoped row, and it refuses a hosted row only because that row holds no `config.linkedUserId` (`routes/integrations.ts:672`). A witness pins that refusal.
  - Deleting a member's Commonly account (`DELETE /api/admin/users/:userId`, `routes/admin/users.ts:267`, behind both admin pages' Delete) moves no row. It deletes the person and nothing else, because `User` has no delete hook. The broker's owner check (below) stops the grants, but the row stays active, so the orphan sweep would keep a live refresh token for a person Commonly no longer has, and nothing would revoke it at the provider. The route therefore refuses `409` while the person owns a hosted row. Its body lists each row's `_id` and entry, which is what `DELETE /api/integrations/:id` takes; that route admits an admin (`canDeleteIntegration`, `routes/integrations.ts:171`) and runs §9's removal. Removal stays one path with one retry, not a second copy inside account deletion.
  - A ban (`PATCH /api/admin/users/:userId/ban`, `:233`) moves no row either, and it is the likelier way a member leaves (Vera 75492). From then on `auth` refuses the person (`middleware/auth.ts:74`), so they cannot revoke anything themselves. Neither path to the broker passes `auth`, though: `routes/mcpGrants.ts:50` runs `agentRuntimeAuth`, and the native runtime calls it in process (Vera 75494). So the ban reaches the person's grants only through the broker's owner check, which refuses them for as long as the ban lasts; lifting the ban restores them with no reconnect. The ban route stays unguarded, because a ban may be urgent and it can be lifted. The material stays for the same reason; an admin who wants the credential gone removes the row.
  - The mint may admit the type before any of this lands. No hosted row can exist while `HOSTED_MCP_ENTRIES` is empty, so no hosted grant can either.

**The broker** (`resolveConnection`, `toolBrokerService.ts:455`):

- For this type it finds the row by `findById` only (Kai 74792), never through the `installationId` lookup at `:461`.
- It checks the type, `status`, `revokedAt`, that the entry exists and that a `credentialRef` is present.
- It checks that the definition's `entryId` equals the row's, the same `connection_mismatch` class it applies to type today (`:476–486`).
- It keeps the TASK-148 `createdAt` guard (`:488–512`) unchanged.
- For a hosted row, it refuses when the row's owner is no longer a usable account (TASK-181). It reads the owner through `sessionAccountService` (`loadSessionAccount`, `sessionRefusal`), the one definition the session verifiers share, and renders the answer as `connection_owner_banned`, `connection_owner_missing` or `connection_owner_bot` (403, beside `connection_superseded`). Separate codes tell an admin which remedy applies: lift the ban, or remove the row so its owner can be replaced (Vera 75498). `listToolsForGrant`, `callTool` and `executeApprovedToolCall` all resolve through it, so one check covers the offer, the call, and a call approved after the ban. It reads live state at call time, so nothing is written when the ban is set and a lifted ban needs no reconnect. Both call paths' existing catch writes the refusal to `tool_calls` as `refused`, with the code as `reason` (`safeReason`, §9). A refused list writes no row, because a list is not a call; the seat gets the code as a JSON-RPC error (`routes/mcpGrants.ts:73`). A `github-app` row is unchanged: its token belongs to the app installation, not to the admin who created the row.
- `ToolConnection` (`:28–34`) widens to both types; `owner`/`repo` belong to `github-app`, and `entryId` to `hosted-mcp`.

**The catalogue.**

- `TOOL_INSTALLABLES` (`services/installable/toolInstallables.ts:58–65`) gains one tool Installable per entry, built from the entry, and `resolveBrokerFor` (`:124–139`) keys on the entry.
- The catalogue filters connections by `meta.connectionType` (`installableCatalogService.ts:97–119`); for this type it also filters by `config.entryId`, so the Linear Installable lists only Linear rows.
- `publicConnection` already falls back to `_id` for `connectionId` (`:78–79`).
- `IntegrationType` (`models/Integration.ts:13`) and the model's `type` enum (`:203`) gain the value.

## 8. The trail records whose credential ran

`ToolCallRecord` (`models/ToolCall.ts:62–75`) records the grant, the agent, the tool and the outcome, but not whose credential ran. With per-person Connections, that is the first question a trail reader asks: whose Linear was this?

**Every record gains `credentialOwnerId`, the Connection's `createdBy` at call time, for every type.** That includes `github-app`, whose owner is the admin who created the row. It is copied onto the record, because once §10.5's last step deletes the row there is nothing left to join to. The copy holds against the row's delete, not the person's: once a Commonly account is deleted (§7), the id resolves to no one. A name beside it would hold against both, but how long a deleted person's name is kept is a retention decision for account deletion as a whole, and this column does not make it. Soft-deleting the row instead was considered and rejected: §10.5 ends with the delete, and a soft-deleted row is one that the sweeps, the catalogue and the mint would all have to learn to skip.

## 9. Failure is named (C9, C10)

| at the vendor | what the broker does | trail (outcome, reason) | row |
|---|---|---|---|
| 401 on a call | one fenced refresh (§10.3), then one retry | as the retry ends | untouched on success |
| `invalid_grant` on that refresh | fails the call | `refused`, `reconnect_required` | `status: 'error'`, "reconnect"; only the generation holder writes it (§10.3), and later calls are refused as §10.3 says |
| 403 or `insufficient_scope` | fails the call | `refused`, `provider_denied` (§10.4) | recorded, so the page can say what was refused; the grant is not touched |
| 429 | fails the call | `failed`, `provider_rate_limited`, with `Retry-After` when one is sent | untouched |
| 5xx, a timeout, no connection | fails the call | `failed`, `provider_unavailable` | untouched |
| a result with `isError: true` | returns the vendor's text as the tool's error | `failed` | untouched |
| a pinned tool missing, or drifted (§3) | refuses before calling | `refused`, `tool_unavailable` or `tool_drift` | untouched |
| the row's owner banned or gone (§7) | refuses before calling | `refused`, `connection_owner_banned`, `connection_owner_missing` or `connection_owner_bot` | untouched, and so is the grant |
| the row's `clientId` is not the client its entry uses now (§2) | refuses before calling | `refused`, `reconnect_required` | `status: 'error'`, "reconnect"; written only while the row still holds that `clientId`, so a reconnect that lands first stands |

`refused` is for answers about authority, whether ours or the vendor's; `failed` is for a call that could not complete (`ToolCallOutcome`, `models/ToolCall.ts:21`). Each row reaches the person as a named state, never as a silent empty result.

**Removal** is §10.5 unchanged in order:

1. Grants: `revokeConnectionGrants`, which matches a grant by the row's `_id`, the id every hosted grant is stored under.
2. The row goes to `disconnected`, and `isActive` stays true: step 3 needs the token, and the orphan sweep revokes the material of a row that is not active.
3. The provider, by whether the entry's `revoke` names an `endpoint` (§3), never by a URL. A revoke that took ends with §10.5's mark, and a retry that finds the mark skips this step.
   - With an endpoint, the call sends the refresh token when the row names one, and otherwise the access token, each with its RFC 7009 `token_type_hint` (Linear's endpoint is `https://mcp.linear.app/token`). Unlike §10.5's GitHub grant-deletion call, which takes an access token, this sends the token itself, so it needs no refresh first. No call sends an empty token.
   - Only a 2xx counts as revoked. Any other answer, `invalid_grant` included, is a refusal: the row stays with its references, and the response is `502 provider_revoke_failed` with the page as `revokeAt`. RFC 7009 answers a token that is already gone with 200. RFC 6749 §5.2 also gives `invalid_grant` for a token "issued to another client", and a `cimd` client id is a URL on the instance's API host (§4), so after a host move a revoke can answer that way while the authorization stays live.
   - Nothing is sent when the entry has no endpoint, or when that token's secret is not found. Nothing we hold can revoke then, and a kept row only waits for a retry that can never succeed, so the removal finishes and the response carries the page as `revokeAt`, as §10.5 does for a pasted token. A secret that cannot be read for any other reason is a 502 with the row kept, since it may be readable later.
   - Nothing is sent when the row's entry is no longer in the catalogue either (§3). The removal finishes the same way, with the row's `config.revokePage` as `revokeAt`. Keeping the row would keep a live token that nothing may use, waiting on a PR that may never restore the entry. While the entry is present, its own page is used instead of the copy, since a PR may have corrected it. A row whose entry is gone and which holds no copy keeps today's refusal, `provider_revoke_failed` with the row kept, because a removal that finishes must hand the person a page. The catalogue is empty today and the copy lands before its first entry (§10), so every row will hold one.
   - Nothing is sent when the row's `clientId` is not the client its entry uses now (§2). That includes the host move above, which changes a `cimd` client's id, and it is now caught before any send. RFC 7009 §2.1 has the AS refuse a revocation from a client the token was not issued to, so a send could not be relied on, and a kept row would wait for a retry that may never succeed. The removal finishes with the entry's page as `revokeAt`, as for a token whose secret is not found.
4. The material.
5. The delete.

A grant's `expiresAt` is capped at the Connection's when the row has one (§10.4).

## 10. Build order and named tests

Each step can be tested without the vendor, except the live measurements in steps 3, 7 and 8.

1. **The type and the record.** The enum and union, the partial unique index, the two secret kinds, and the config-key registries.
   - `a hosted-mcp row cannot be created through the generic route`
   - `a hosted-mcp row's credential references never leave the server` (extends #1673's)
   - `a channel connector row cannot be granted` (§10.0, unchanged)
2. **The entry, its projection and drift.**
   - `an upstream tool not in the entry is never offered`
   - `the upstream description never reaches an agent`
   - `a pinned tool missing upstream is refused tool_unavailable`
   - `a pinned tool whose schema changed upstream is refused tool_drift`
   - `a read pin carrying no readOnlyHint is refused`, with #2014's other entry-time refusals (§3)
   - the annotation arms (§3): a `destructiveHint: false` gone silent is `tool_drift`; a pin that recorded `readOnlyHint: true` whose tool now also says `destructiveHint: true` is `tool_drift`; a pin that recorded both claims, against that same tool, is refused naming the `destructiveHint: false` it lost; a `destructiveHint: true` newly spelled on a `write` pin that recorded neither claim is `ok`
3. **Intake.** The CIMD document, start and callback.
   - `the callback refuses a state it did not issue, a used state and an expired state`
   - `the callback refuses a valid state from a browser that did not start the flow, and the flow stays pending`, with no cookie, with another flow's cookie, and on a row that stores no nonce
   - `a throttled callback lands on the page with rate_limited`, as every other outcome does
   - `the callback refuses an iss that is not the entry's issuer`
   - `every authorization and token request carries the entry's resource`
   - `a reconnect as a different provider account revokes every grant on the row`
   - Measured live: CIMD end to end at Linear, token lifetimes, and whether an ID token is issued.
4. **The mint and the broker.**
   - `the mint refuses write on a hosted-mcp row`
   - `a hosted grant cannot name another entry's tool`
   - `a hosted row is found by _id only`
   - the §6 arms
   - TASK-175's refusal at the broker call, before the mint admits the type
5. **The trail column.**
   - `every tool call records whose credential ran`
   - `the trail names the credential owner after the Connection is removed`
6. **Removal, and an owner who leaves.**
   - §10.5's named tests, run over a hosted row, except `removal refreshes before it revokes at the provider`, which is GitHub's grant-deletion case, and `an authorization already gone at the provider counts as revoked`, which is GitHub's refresh answer and here would count a live token as revoked (§9)
   - `the provider revoke sends the refresh token to the entry's revocation endpoint`
   - `a row with no refresh token revokes its access token, and no removal sends an empty token`
   - `a provider answer other than 2xx is a refusal, invalid_grant included, and returns the page as revokeAt`
   - `a removal whose token secret is not found sends nothing, finishes, and returns the page as revokeAt`
   - `a token secret that cannot be read refuses the removal and keeps the row`
   - `a page entry's removal calls no provider and returns the page as revokeAt`
   - `the callback copies the entry's revoke page onto the row`
   - `a PATCH that sets config.revokePage leaves the row's copy unchanged`
   - `a removal whose entry is present returns the entry's page, not the row's copy`
   - `a removal whose entry is gone sends nothing, finishes, and returns the row's copied page as revokeAt`
   - `a removal whose entry is gone and whose row holds no copy is refused and keeps the row`
   - `an entry whose revoke names no page, a key other than endpoint and page, or a URL that is not https, is refused at load`
   - TASK-147's witness per removal path (§7), before the first entry ships
   - `deleting a member who owns a hosted row is refused with the rows named, and the row, its grants and its material are unchanged`
   - TASK-181's three, each made by banning or deleting a member who owns the row and then calling through the broker, not by calling the check:
     - `a banned owner's hosted grant is refused as connection_owner_banned and trailed refused, and runs again once the ban is lifted`
     - `a call approved after its owner is banned is refused`
     - `a hosted grant whose owner no longer exists is refused as connection_owner_missing`
7. **The Linear entry**, pinned from a real `tools/list` with read tools only, then the readiness matrix walked for it on the deployed build, including a pi seat's refusal shown on the grant's page (§6).
   - Read first: whether the list's read tools carry `readOnlyHint: true` (§3). If they do not, stop for §11's question before the rest of the step.
   - `the Linear pin is the measured list minus caller-chosen fetch paths`: retain all 38 raw tools in the capture, pin the other 36, and keep the exact-lookup URL keys while excluding `extract_images` and `get_attachment` (§3).
   - `the page's call to start is credentialed`, before the walk (§4)
   - Measured live: that a removal's revoke took at Linear, shown by something other than its 200 (§3). Linear advertises one URL as both its `token_endpoint` and its `revocation_endpoint` (fetched 2026-09-29), so only a live removal shows which request that URL treats as a revoke.
   - The entry's `page`: Linear's Security & access settings, whose "Authorized applications" list has "Revoke access" on each app (Linear docs, *Security & Access*, fetched 2026-09-30). Its URL is pinned from the signed-in walk.
8. **The entries after Linear**, in the order connector-ops proposed (76040) and 76044 kept: Atlassian, Airtable, Todoist, Calendly, then Google through a pre-registered client (§4). Each is its own entry PR, admitted as §11 says and walked as step 7 is.
   - First, while Linear is the only entry: the client record (§2), then its backfill once that build's rollout has finished.
     - `the callback records the client that minted the pair`
     - `a row minted under another client is refused reconnect_required before any call`
     - `a connected row with no recorded client is not refused`
     - `a removal whose row was minted under another client sends nothing and returns the page as revokeAt`
     - `the backfill records Linear's document on a row that holds a pair and no recorded client, and leaves a recorded client alone`
   - Then, in the second entry's PR and after the backfill has run: the refusal of a row without a recorded client (§2).
     - `a connected row with no recorded client is refused as a mismatch`
   - Each entry requests only scopes its vendor's docs say cannot write (§3). Todoist and Calendly enter only if a consent with their read scope alone works, measured at build. Todoist's resource metadata advertises only `data:read_write` (fetched 2026-10-01). Calendly's docs list `mcp:scheduling:read` and `mcp:scheduling:write` and say its server "requires both for full access". Calendly offers DCR and no CIMD, so its entry brings DCR's storage (§4).
   - Before Google: the pre-registered client (§4).
     - `an instance missing the entry's client id or secret projects it not_configured`
     - `a pre-registered client authenticates at the token and revocation endpoints, and still sends PKCE`
   - Google starts as Calendar. Google's setup page lists three scopes for its Calendar server, all reads: `calendar.calendarlist.readonly`, `calendar.events.freebusy` and `calendar.events.readonly`. Calendar's scope page gives them no class; the Cloud console groups declared scopes "into sensitive or restricted categories" (Google's sensitive-scope verification page), so the class is read there. Verification starts now (76044), since an unverified app is capped at "100 new users in total" (support.google.com/cloud/answer/7454865).
   - Docs enters only if its reads work on `documents.readonly` alone, measured at build. The setup page lists four scopes for its Docs server: `documents.readonly`, `documents`, which writes, and Drive's two below. Docs' scope page classes `documents.readonly` Sensitive, so Docs alone needs no security assessment. If Docs shares Calendar's client, its build also measures whether a revoke at Google for one row ends the other's authorization.
   - Drive and Gmail wait for Sam's call on restricted scopes. `drive.file` lets an app "create new Drive files, or modify existing files" (Drive's scope page, updated 2026-09-03), so it fails §3's bar. Drive's only other scope on the setup page is `drive.readonly`, which is Restricted, and so are both Gmail scopes, `gmail.readonly` and `gmail.compose` (Gmail's scope page, updated 2026-09-10). A restricted scope needs Google's restricted-scope review and a security assessment repeated "at least every 12 months" (Google's restricted-scope verification page, updated 2026-08-19).
   - Google's MCP servers are a Developer Preview, and the setup page requires "Membership in the Google Workspace Developer Preview Program".

## 11. What this corrects, and what stays open

**Corrections carried from the card thread (74821):**

- Hosted servers can act as an app too (Linear's app-user credential, GitHub's installation token), so C6 is the only thing unique to the bespoke Linear build.
- GitHub's hosted server is generally available ("Remote GitHub MCP Server is now generally available", GitHub changelog, 2025-09-04) and takes GitHub App user tokens.
- Notion's URL and transport are published.

The TASK-172 ruling's part 3 wording on `:180` is replaced by §6.

**Other vendors join the catalogue only once their own docs verify** the URL, transport, auth mode, token lifetime and refresh, and revocation (74820; the TASK-172 row), and a scope that cannot write (§3). A `tools/list` must also show `readOnlyHint: true` on each tool the entry pins `read` (§3). Three facts already shape their entries:

- Notion's only advertised scope is `default`, so a Notion entry cannot narrow its credential to reads the way Linear's `read` does, and §3's bar keeps Notion out until it offers a scope that cannot write (76043).
- GitHub needs the pre-registered client (§4).
- Two servers publish their source, so their hints can be read before a login, in the files that declare what they serve over MCP. Sentry's tool type makes `readOnlyHint`, `destructiveHint` and `openWorldHint` required, and a test enforces it (`getsentry/sentry-mcp` at `0563bde`, `packages/mcp-core/src/tools/types.ts`); its `internal/agents/tools` are not MCP tools and carry none. GitHub's sets `readOnlyHint` on all 121 tools in `pkg/github`, and its tests fail a tool that omits it (`github/github-mcp-server` at `85598ba`, `pkg/toolvalidation/readonlyhint.go`).

**Still open, and not this note's to decide:**

- CIMD end to end at Linear, the MCP AS's token lifetimes and rotation, and whether it issues an ID token for `openid`: measured at build (§4).
- Whether Linear's read tools carry `readOnlyHint: true`. The test account's first `tools/list` answers it, and that list can be taken before step 7. If they arrive unannotated, §3 leaves Linear with no entry. The one case worth reopening is Linear's own: v1 requests only `read`, whose token "can’t reach write APIs" (§4), a fence Linear enforces where the hint only reports. It is decided on the measured list, not assumed now.
- §10.6's three questions stay Sam's. This is the first per-person Connection type, so the first of them — the granter leaves the room — has a live case the day a member grants their Linear to a room and then leaves it. Until Sam rules, a hosted grant behaves as every grant does today: it survives to its expiry, which it always has.
