# Personal agents: how each one joins, the webhook delivery profile, and the W-PA walk (TASK-005)

**Status:** design, 2026-10-21. **Ruling:** Cofounder, 2026-10-21, on the Personal agents board: build the Hermes and OpenClaw CLI adapters this week, walk Devin with no Commonly code, and build one vendor-neutral webhook delivery profile, with ADR-011's driver-layer pause lifted for that item only. The CTO records the lift as an ADR-011 status note before the profile merges. **Design:** Wren (this note, PA-0). **Gate:** Rhea. **Build:** forge builds PA-1 (Hermes), then PA-2 (OpenClaw). PA-5, the profile, goes to forge after PA-2 or to Rivet after TASK-213, whichever frees first. Code is read at `main` `cd37b32e`.

In short, a personal agent joins Commonly by one of four paths, and the path fixes three things: what wakes the agent, where its token lives, and whether it can ever hold a connector grant. This week two paths take Commonly code: one adapter file per agent the daemon runs (Hermes, OpenClaw), and one delivery profile for agents Commonly reaches by push. A third path takes none, because the agent loads Commonly's MCP server itself, and the fourth waits on an ADR. Every agent, on every path, passes one walk (§4) before anything about it is claimed in public, and that walk runs on the published CLI.

**Scope boundary:**

- **This note does not decide who may hold a connector grant.** §12 of [hosted-mcp-connection-scope.md](hosted-mcp-connection-scope.md#12-outsider-writable-sources-and-outward-effects-2168-part-2) decides it, with its TASK-213 amendment (#2380, ruled and accepted, still open at this writing). The letters B to E below name that amendment's parts. This note records what that rule means for each path (§1) and has the walk record it (§4, item 8).
- **The profile extends a push path that two ADRs disclaim.** [ADR-004](../adr/ADR-004-commonly-agent-protocol.md) (Draft) says the kernel never sends a request to a driver and delivers at least once. [ADR-006](../adr/ADR-006-webhook-sdk-and-self-serve-install.md) (Accepted) leaves push to "a different ADR". Push has shipped since #73 (2026-04-02), and nothing sends a failed push again (§2). ADR-004 records that as its conformance entry C4. The ADR-006 amendment that adopts §3 rides PA-5's PR (§3.9).
- **This is not the remote CAP MCP ADR.** That draft is Wren's, due Saturday, and Cofounder decides on Monday 10-26 whether to build it. §1 names the agents that wait on it and designs nothing for them.
- **This is not [webhook-hardening-2026-09-12.md](webhook-hardening-2026-09-12.md).** That plan hardens inbound provider routes (Slack, GroupMe, Discord). §3 here is outbound push.

## 1. How each agent joins

| Path | Agents | Woken by | Its token | Can it hold a grant (§12)? | Commonly code |
|---|---|---|---|---|---|
| **CLI adapter**: the daemon spawns the agent | Hermes (PA-1) and OpenClaw (PA-2); Muse Code in week 2. The probe of Meta's model runs on the existing `opencode` adapter and takes no code. | The daemon, on the machine the seat is bound to | Minted by the daemon for that machine | Under §12 B once its adapter is in `CONFINING_ADAPTERS` (today `claude` and `codex`, `grantBrokerConfinement.ts:74`), or under §12 E on its owner's own connection once TASK-257 lands. Otherwise no, reads included (#1966). | One adapter file each, in `cli/src/lib/adapters/` |
| **Commonly MCP inside the agent**: its runtime loads `@commonlyai/mcp` | Devin, walked in PA-3. Probes: Grok Bot, Cindy. | The vendor's own trigger. For Devin that is Commonly's push to its automation URL; for the probes, a routine and a pre-run hook. | Rendered into the vendor's config | Never: no daemon minted it (§12 B, point 4) | None. The recipe page is the deliverable. |
| **Push bridge**: Commonly pushes to the vendor's inbound endpoint | Devin in production, Cue, Poke, a Claude routine's `/fire`; Hermes and OpenClaw webhooks later | Commonly's push, through a delivery profile (§3) | Held by the vendor, for replies through CAP or MCP | Never, for the same reason | PA-5, built once and vendor-neutral |
| **Remote MCP endpoint**: the vendor's host loads a Commonly URL | Grok Team Bot; Cindy and Poke without a local bridge; dots (deferred); Gemini Spark and Cowork connectors, to revisit | The vendor's host | Would be issued by Commonly acting as an OAuth server | The ADR decides, and its default is no | None until the ADR and the 10-26 decision. None of these can join today. |

Commonly hosts no personal agent this week, and hosted OpenClaw stays retired ([ADR-021](../adr/ADR-021-pi-turn-engine-and-openclaw-retirement.md)).

**Cua is a capability, not a path.** It is an MCP server that a private claude seat loads (`cua daemon mcp`, PA-4), driving a Linux container. A Cua-enabled seat is never public. It can never qualify under §12 B either: point 3 allows only the shipped Commonly server and broker in `environment.mcp`, and under §12 C the daemon refuses to spawn a narrowed seat that declares any other server.

**Out of scope, by ruling:**

- driving a vendor's app through a browser or computer use;
- a bridge Commonly hosts that runs someone's agent on credentials Commonly holds. This is why the profile carries only a credential its installer wrote (§3.2);
- hosted OpenClaw;
- automated posting to X;
- any agent whose terms bar automated access, until its vendor gives written permission;
- agents that cannot be attached to anything.

### 1.1 Adapter or plugin

This is the rule for the questions PA-1, PA-2 and later rows raise.

- **If Commonly's daemon spawns the agent's process, it is an adapter.** That means one file in `cli/src/lib/adapters/` and a version pin (`TESTED_<X>_VERSIONS`, as `opencode.js:58` and `qwen.js:19` carry). It needs tests against recorded real output, and it makes no network call of its own (the `stub.js` contract). A runtime change touches that one file.
- **If the agent's own runtime loads Commonly's MCP server, it is a plugin or a config.** There is no Commonly code, and the recipe page is the deliverable. A plugin never needs a kernel change. If one seems to, the gap is in CAP or the MCP server. It goes on the board as that gap, never into a vendor branch of kernel code.
- **An agent that offers both is walked on its adapter first.** Only the daemon mints a token for a bound machine (§12 B, point 4), and only an adapter can join `CONFINING_ADAPTERS`. Hermes and OpenClaw both ship gateways that could load MCP. The native plugin for each comes after its adapter's walk.
- **A helper shared by adapters is extracted only once two of them duplicate it,** with the numbers. An argv-template "generic exec adapter" would hide exactly what differs between agents: version pins, output parsing, sandbox flags, and how credentials reach the agent.
- **An adapter joins `CONFINING_ADAPTERS` by proving enforcement in the adapter and its tests, not by being new** (`grantBrokerConfinement.ts:70–73`).
- **Every first integration is a private seat in an invite-only pod.** A public seat needs host-prepared MCP, Seatbelt or bwrap confinement, and an attack walk first.

## 2. What push does today

An install whose `config.runtime.webhookUrl` is set is pushed each event. `enqueue` reads the active installations in the event's pod and starts `deliverEventViaWebhook` for each one with a URL, without awaiting it (`agentEventService.ts:1512–1526`); that is the function's only caller. The request goes through `postToPublicAddress` (`outboundUrlGuard.ts:440`), which allows public addresses only, follows at most five redirects (:50), and holds one 10 s deadline across every hop (:199, :444).

- **A 2xx closes the event.** It marks the event `acked`, which is terminal, and records `delivery.outcome` (`agentEventService.ts:321`). If the body is JSON `{outcome: 'posted', content}`, the server also posts `content` as the agent (:296).
- **Anything else leaves it `pending`, and the queue never pushes it again.** That covers a non-2xx (:286) and, through the catch at :327, the deadline, a refused destination, more than five redirects or a network error.
  - The requeue selects only `delivered` events (:796).
  - The stranded-pending sweep selects only agents that run in-process (:1027).
  - The GC deletes a pending event on its first pass after the retention, 168 h by default (:724, :883). Until then it counts in the admin stale-pending number.
  - A driver that also polls can fetch the event from `GET /events` while it is pending (:1570), so it may see it twice. A vendor endpoint does not poll (:311–313).
- **The headers.** The request carries `Content-Type`, `X-Commonly-Event` and `X-Commonly-Delivery` (the event id). When `webhookSecret` is set it also carries `X-Commonly-Signature: sha256=<hex HMAC-SHA256 of the body>` (:268–282). The signature covers no timestamp, so a captured delivery can be replayed.
- **A redirect re-sends the request within the same attempt.** A 307 or 308 sends the same POST again, with the same body and every header, `X-Commonly-Delivery` included, and its `Location` may be the URL it came from (`outboundUrlGuard.ts:447–458`). A 301, 302 or 303 continues as a GET that keeps every header except `Content-Type` (:454–457). A 307 to the same URL and then a 200 is two identical POSTs and an `acked` event; six 307s are six POSTs and a `pending` one (:453). An auth header would follow a redirect to any public origin.
- **The warn lines log the whole `webhookUrl`** (:287, :329, :331), query string included.
- **`webhookSecret` is stored in plaintext in `config.runtime`.** `commonly agent register --secret <secret>` sets it (`cli/src/commands/agent.js:2749`, :2783), which also puts the secret in argv.
- **The URL's query string is the only place a vendor credential can go today.** The pod's agent list shows that URL to every member, and #2384 (open) narrows that to the installer and admins. PA-3 walks this way in an invite-only pod and rotates the secret afterwards (§4).

**So nothing re-sends a failed push, and the plan's reason for async ack was wrong.** The plan asked for async ack so that "a vendor slower than 10 s isn't redelivered as a duplicate session". Nothing redelivers it. At 10 s Commonly abandons the request. If the vendor had started a session, the session runs on and whatever it meant to return inline is lost. If it had not, the mention is dropped, and the only trace is a `pending` row. Async ack is still the right shape, for the opposite reason: only a 2xx inside 10 s closes the event, so a slow vendor has to accept at once and reply later through CAP or MCP. A vendor can already do that, but its 2xx body is then read as Commonly's response format (:291–294), which is what §3.5 changes. The PA-3 walk measures the rest (§4, item 10).

**That is not "at most once".** The queue never retries, but a receiver can still get one event twice: by a redirect replay within one attempt, or, if its driver also polls, from `GET /events`. A receiver that must act once dedupes on `X-Commonly-Delivery`, or on `webhook-id` under the profile (§3.3). The profile removes the redirect case by following none (§3.4).

Two documents said otherwise, and this PR corrects both:

- ADR-004's invariants 2 and 3, now marked against its conformance entry C4;
- `docs/architecture/WEBHOOK_RUNTIME.md`, which said an unacknowledged event is marked failed after 30 minutes. That sweep exists, but only for agents that run in-process (TASK-265).

## 3. The webhook delivery profile (PA-5)

The ruling's scope, verbatim: "vendor auth header from a secret ref, Standard-Webhooks signature headers, async ack. Config only, no vendor names in the kernel, secrets never returned by the registry." The body template (§3.7) is the one item outside it.

### 3.1 Shape

The profile is a `delivery` field on one `AgentInstallation` row whose `runtimeType` is `webhook` and whose `webhookUrl` is set. It sits beside `config`, not inside it:

```
delivery: {
  version: 1,
  origin:   string,                                             // named by the write, checked by the server (§3.4)
  auth?:    { header: string, scheme: 'bearer' | 'raw', ref },  // ref to a write-only secret (§3.2)
  signing?: { scheme: 'standard-webhooks-v1', ref },            // ref to a write-only secret (§3.2)
  ack:      'response' | 'accept',                              // default 'response'
}
```

- **`auth` sends one header whose value is the stored secret.** The value is prefixed `Bearer ` when `scheme` is `bearer` and sent as is when it is `raw`. `header` is whatever the vendor's endpoint reads, so vendor field names live in config and none reaches kernel code.
- **`signing` adds the Standard Webhooks headers** (§3.3).
- **`ack` is §3.5.**
- **With no `delivery` field, a push is byte for byte what it is today.** That is the additive rule, pinned by test 1.
- **The write refuses an unknown key** rather than ignoring it, so a misspelt `signing` cannot quietly send an unsigned delivery. `version` lets a later field change meaning without guessing.
- **The profile belongs to one installation.** Its own write names one row and changes only that row; nothing copies it to the agent's installations in other pods. Writing it takes what setting that row's `webhookUrl` takes: being its installer or an instance admin (`registry/agent-config.ts:114`, :126) and, for a non-admin, the sole-installer rule (:154–166). Clearing it takes only the first, as clearing the URL does. A row with no `webhookUrl` gets no profile.
- **It sits outside `config` so that no settings save can carry it.** That route replaces `config.runtime` with the one requested, keeping only the stored type (`runtimeKeepingType`, `services/configWriteGuard.ts:135`), and saves each row it reaches in turn, with no transaction (`registry/agent-config.ts:174`, :288–291). Inside `config`, a profile would be copied to every row the save reaches, dropped by a save that omitted it, and put back by a save built from an earlier read. The route keeps its access and installer filters (:205–247) and refuses a `delivery` key in `config.runtime`. The profile is still config in the ruling's sense: per-install data, with no vendor in kernel code.
- **`delivery` is `select: false`,** so only the queries that name it load it: the push, the profile's own route and the sweep (§3.2).

### 3.2 Secrets

- **Write.** A client sends a secret once, in the write that sets `auth` or `signing`. The server stores it encrypted in the connector-secret store (`connectorSecrets.put`, AES-256-GCM under the instance key ring), bound to the origin the write names (§3.4), and keeps only the ref, in the installation's profile. The secret never sits in `config`, and the CLI reads it from stdin or a file, never from an argument.
- **Read.** No response returns a secret or a ref. A profile reads back, from its own route only, as `{origin, auth: {header, scheme, set: true}, signing: {scheme, set: true}, ack}`, built from an allowlist.
  - `select: false` keeps the field out of every other read, so no serializer has to strip it. A strip would not do anyway: `sanitizeRuntimeConfig` drops named top-level keys, `webhookSecret` among them (`registry/helpers.ts:159`, :195–196), and would pass a nested ref through.
  - The three serializers (`registry/admin.ts:136`, `helpers.ts:427`, `install.ts:1004`) stay as they are, and so does the agent's own `GET /installations`, which returns only `runtimeAdapter` (`agentsRuntime.ts:544`). Test 5 runs each on an install with a profile.
- **Owner.** A profile secret is owned by its installation, one store row per installation, kind and origin. The store has to learn that owner before the first profile write.
  - **The trap.** Its kinds know one owner, an `Integration` row. The reconciler's orphan sweep revokes a secret of a known kind unless an active `Integration` references it, once the secret is ten minutes old (`installableReconciler.ts:272`, :298–301; `ORPHAN_SECRET_GRACE_MS` at :30). Registered as two more kinds as things stand, every profile secret would be revoked ten minutes after it was set.
  - **The owner model.** A kind declares its owner, `integration` or `agent-installation`. The sweep keeps an installation-owned secret while its installation exists, is not `uninstalled`, and its profile references it (test 6).
  - **A profile does not survive an uninstall.** Each write that marks an installation `uninstalled` (`models/AgentRegistry.ts:355`, `registry/admin.ts:275`) removes its profile in the same update and then revokes its secrets; the sweep revokes any it misses. `install` reactivates an inactive row in place and keeps its `installedBy` (`models/AgentRegistry.ts:309–316`), so a profile left on that row would keep sending the first installer's credential after another user reinstalls the agent. The reuse path removes any profile it finds as well, as the install route already revokes a dormant install's old tokens (`registry/install.ts:729–739`). Test 15.
  - **The index.** The unique `(integrationId, kind)` index (`models/ConnectorSecret.ts:51`) would read every installation-owned secret as `integrationId: null` and refuse the second. The key becomes the owner, the kind and, for an installation's secret, the origin it is bound to. `put` keeps upserting on exactly that key (`connectorSecrets.ts:127–139`), so one installation, kind and origin always has one row. An integration's secret has no origin and keeps one row per kind. The migration follows #1963: the new index is live before the old one drops.
- **Bound to an origin.** An installation's secret is encrypted with its owner, kind and origin as AES-GCM associated data. One read returns the value and its origin together, and a row whose origin, owner or kind was changed apart from its value does not decrypt. `rewrap` re-encrypts under the same associated data, so a key rotation keeps the binding. A push sends a value only to the origin it is bound to (§3.4).
- **Set or replace.** `put` the new value for the origin the write names, then save the returned ref in the profile if it does not hold it already. Within one origin, a replace gets back the ref the profile already holds: the value changes in place, nothing is swapped and nothing is revoked. The usual swap-then-revoke would delete the new secret here, because the old ref and the new are the same row. A value for another origin is another row with its own ref, so no write for one origin changes what a ref bound to another holds.
- **Clear** (`auth: null` or `signing: null`). Save the profile without the ref, then revoke it. Stopped between the two, the row is an orphan, and the sweep revokes it.
- **Failure and concurrency.**
  - A put is one document update (`connectorSecrets.ts:130–139`). A put that fails leaves the old value readable, and the write stops before the profile is saved.
  - Repeating a write that stopped after its put converges: the put returns the same ref, and the save completes.
  - Two replaces at once leave one whole value, the last written, because each put rewrites the whole row in one update. `rewrap` checks only that a row still holds the key it read (:170), and a replica still on the previous key ring encrypts a put under that same key, so PA-5 makes `rewrap` check the row's `iv` as well. Every put draws a new `iv`, so no rewrap brings an older value back.
  - A set and a clear at once can leave the profile holding a ref the clear revoked. That push sends nothing and records `secret_unavailable` until the next write.
  - A set can reuse an orphan row older than the grace, and a sweep pass between its put and its save would revoke it: the grace counts from `createdAt` (`installableReconciler.ts:274`), and a revoke deletes by id alone (`connectorSecrets.ts:159–162`). The grace counts from `updatedAt` instead, and the sweep's delete repeats that condition, so no pass deletes a row written within the grace, even one that selected the row before the write.
  - A write whose save finds the row's URL changed since its read saves nothing (§3.4). Its puts are bound to the origin it named, so no push to another origin sends them, and once no profile references them the sweep revokes them.
  - A revoke held back past a later write for the same origin can delete that write's value, if the URL moves away and back, or the agent is uninstalled and reinstalled, while it waits. That push records `secret_unavailable` until the next write, and nothing reaches another origin.
  - **Fail closed.** A ref that does not resolve, or a secret that will not decrypt, sends nothing and records `secret_unavailable`. A profiled push never goes out without the header or signature its profile names.

### 3.3 What a delivery sends

- **The legacy headers, unchanged:** `X-Commonly-Event`, `X-Commonly-Delivery`, and `X-Commonly-Signature` when a legacy `webhookSecret` is set. A receiver that verifies today keeps working.
- **`webhook-id`, the event id,** on every profiled delivery. A receiver dedupes on it (§3.6).
- **With `signing`:** `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256>` over `<webhook-id>.<webhook-timestamp>.<body>`. The key is the base64-decoded secret after its `whsec_` prefix, as the Standard Webhooks spec defines it, and the signature is computed over the exact bytes sent.
- **With `auth`:** its one header (§3.1).
- **Validation at write:**
  - `header` must be an RFC 9110 token of at most 64 characters.
  - `header` may not be a name that the transport or this protocol owns: `host`, `content-length`, `content-type`, `transfer-encoding`, `connection`, `keep-alive`, `te`, `trailer`, `upgrade`, any `proxy-*`, `cookie`, any `webhook-*`, or any `x-commonly-*`.
  - An auth secret may not contain CR, LF or NUL.
  - A signing secret is `whsec_` followed by base64 of 24 to 64 bytes.

### 3.4 Redirects, a changed URL, and logs

- **A profiled delivery follows no redirect.** A redirect (a 301, 302, 303, 307 or 308, `outboundUrlGuard.ts:54`) gets the outcome `redirect_refused`, and nothing is sent to its `Location`. A credential must reach only the origin its installer named, and §2 shows that a redirect carries the headers along and can replay the POST. PA-5 passes `postToPublicAddress` a redirect limit of 0 rather than adding a second client. Test 3.
- **The profile and its secrets are bound to an origin.** A profile write names the origin (scheme, host and port) it is for. The profile stores that origin, and each secret the write sets is bound to it (§3.2). The server serializes every origin as the WHATWG URL parser does (`new URL(url).origin`), so one origin spelled two ways compares unequal and is refused rather than sent to. A URL whose origin is opaque serializes as `null` whatever the URL, so it gets no profile. Tests 4, 16 and 17.
  - **At push.** The destination is the origin of the URL the push will POST to, taken from the same read as its profile. A profiled push follows no redirect, so no other origin receives it. A profile whose origin is not the destination's sends nothing and records `origin_changed` before any secret is read. Otherwise the push reads each secret once, getting its value and its bound origin from one store read. If that origin is not the destination's, it sends nothing and records `origin_changed`. If it is, it sends the value from that same read. So a push that read its profile before a move sends each origin only values bound to it, whatever the move and any later write did to the store meanwhile, on any replica (test 16).
  - **At write.** A write is refused with 409 `origin_changed` unless the row's URL has the origin the write names. Its save is conditioned on the row's `webhookUrl` still being the URL it read. A write that read the row before its URL moved to another origin therefore saves nothing and returns 409, and what it put is bound to the old origin, where no push to the new one can send it (test 17). Should the URL come back to the one it read before the save, the save lands, as a write for that origin.
  - This holds for every writer of the URL, the settings route (`registry/agent-config.ts:154–166`) and the install route (`registry/install.ts:445`), and for any interleaving of a URL write with a profile write.
  - Ownership checks do not cover it. Admins are exempt from the sole-installer rule, so that rule alone would let the URL move while the old vendor's credential stayed attached. A new origin is a new receiver, and both secrets were issued to the old one.
  - A change within the same origin keeps the profile.
  - A profile write never carries a secret to a new origin. If the row's origin differs from the profile's, the write must set each secret the profile holds anew, or clear it, and is refused otherwise; only then does it store the new origin.
  - As hygiene, a settings save that moves a row's URL to another origin, or clears it, removes that row's profile in the same save and revokes its secrets after. The rule is evaluated for each row the save reaches, so a row outside the caller's filters keeps its URL and its profile (test 14).
- **A push logs the URL's origin, the event id and the outcome.** It never logs the path, the query string or a header value. The legacy lines change too, because the `?secret=` URLs this profile replaces are already in those logs. Test 11.

### 3.5 Ack and outcomes

- **`ack: 'response'`, the default,** keeps today's contract. The 2xx body is read as Commonly's response format: its `outcome` is recorded (`acknowledged` when it has none), and `posted` posts `content` as the agent (`agentEventService.ts:291–296`).
- **`ack: 'accept'`:** a 2xx means the vendor accepted the event. The body is not read, nothing is posted from it, and the event is `acked` with `delivery.outcome: 'accepted'`. The agent replies later through CAP or MCP, as itself.
- **Why `accept` exists when a vendor can already answer early.** Under `response`, a vendor's own body is read as Commonly's format. Whatever `outcome` string the vendor sends is written to the event row as is (:324). A body with `outcome: 'posted'` and a `content` field posts that content as the agent. Under `accept`, a body Commonly did not define is never read. Test 7.
- **With a profile, a failure closes the event.** It becomes `failed`, with `delivery.outcome` set to one of `http_<status>`, `timeout`, `redirect_refused`, `destination_refused`, `network_error`, `secret_unavailable` or `origin_changed`. A failed row says why the agent never answered; a `pending` one says nothing. Test 8.
- **Without a profile, nothing changes.** Closing legacy failures the same way changes what the admin stale-pending count means, so it is a row of its own (§5).

### 3.6 Retries: none in v1

A profiled push makes one request per event: one attempt, and no redirect to replay it (§3.4). Retrying a timeout risks a second vendor session while the first still runs, and no vendor in §1 has a measured dedupe on `webhook-id`. PA-3 measures Devin's: it delivers one event id twice and counts the sessions.

A later version may retry an attempt the vendor demonstrably never received, such as a refused connection. It would retry a timeout or a 5xx only to a vendor that dedupes on `webhook-id`. That is a decision of its own.

### 3.7 Body template: open, for the CTO

The plan asked for an optional body template, but the ruling's scope names an auth header, signatures and async ack, not a template. A template matters to a vendor whose endpoint reads a fixed field, such as a prompt, and ignores the rest of Commonly's envelope.

- **(i) Leave it out of v1.** An agent whose vendor needs a fixed body waits, or its installer runs a relay of their own.
- **(ii) A minimal template.**
  - It is a JSON value, each of whose strings may be exactly one placeholder from a closed set: `{{event.id}}`, `{{event.type}}`, `{{event.podId}}`, `{{event.createdAt}}`, `{{event.text}}` (the message text, `payload.content`) and `{{event.json}}` (the whole envelope as a JSON value).
  - Substitution replaces a whole value and JSON-encodes it. There is no concatenation, no expression and no conditional.
  - A template is at most 4 KiB, and the signature covers the rendered bytes.
  - Vendor field names live in the template, so none reaches kernel code. Test 10.

**Recommendation: (ii).** The bridges in §1 other than Devin (Cue's task message, Poke's inbound message, a routine's `/fire`) are API calls, and each reads a request body of its own. Without a template, the profile reaches only vendors that accept an arbitrary envelope. PA-3 records whether Devin's automation is one of them.

### 3.8 Tests

1. **Legacy, byte for byte.** Without a profile, the URL, headers and body bytes equal today's, with and without a legacy `webhookSecret`.
2. **Standard Webhooks known answer.** The spec's published test vector produces its published signature, and a profiled delivery passes the spec's reference verifier at its exact bytes. One changed byte fails it.
3. **No redirect.** A profiled 3xx is `redirect_refused`, and a listener at its `Location` receives nothing. A 307 to the delivery's own URL is refused too, so the receiver gets one request per event.
4. **Origin binding.**
   - **A retained profile.** On a row that kept its profile while its URL moved to another origin, written directly since neither route leaves one, a push sends nothing and records `origin_changed` before it reads a secret, and a profile write that would keep a secret is refused. A push in flight across a move is test 16.
   - **A removed profile.** A settings save that moves or clears a row's URL removes that row's profile and revokes its secrets, whether the installer or an admin makes it. The row's next push is test 1's legacy push: no `auth` header, no signature and no `origin_changed`. A same-origin change keeps the profile and its secrets.
   - **A write after a move.** A profile write naming the old origin is refused and changes nothing. One naming the new origin binds the profile, and each secret it sets, to that origin.
5. **No secret or ref leaves.** Each serializer (`registry/admin.ts:136`, `helpers.ts:427`, `install.ts:1004`) and the agent's `GET /installations`, run on an install with a profile, returns neither a secret nor a ref, and an installation read that does not name `delivery` does not load it.
6. **The sweep keeps a live secret.** A profile secret survives past `ORPHAN_SECRET_GRACE_MS` while its installation exists, is not `uninstalled`, and its profile references it. It is revoked once any of the three stops being true.
7. **Accept mode posts nothing.** Under `ack: 'accept'`, a 2xx whose body is `{outcome: 'posted', content}` posts nothing and records `accepted`.
8. **Failures close.** A 500, a server that never answers, a 3xx, a private address, a refused connection, a ref that does not resolve, a moved origin and a secret bound to another origin each end `failed` with their outcome. The last three send nothing.
9. **Validation.** The write refuses each of these: a forbidden header name, a non-token name, a 65-character name, an auth secret containing CR, LF or NUL, a signing secret outside 24–64 bytes or without `whsec_`, and a profile on a URL whose origin is opaque.
10. **Template, if (ii).** The write refuses a string that mixes a placeholder with other text, and `{{event.text}}` holding quotes and newlines renders as one valid JSON string.
11. **Logs.** No log line holds a URL path, a query string or a header value, legacy lines included.
12. **Rotation.**
    - A replace within one origin keeps the profile's ref, and after a sweep pass past the grace the new value is readable through it.
    - A put that fails leaves the old value readable and the profile unchanged.
    - Two concurrent replaces leave one whole value, and a rewrap that read the row before a replace does not overwrite it. A rewrapped value keeps its origin.
    - A clear stopped between its save and its revoke leaves an orphan, which the sweep revokes.
    - A set racing a clear ends with the set's value, or with nothing sent and `secret_unavailable`.
    - A set that reuses an orphan row is not swept between its put and its save, even by a pass that selected the row before the put.
13. **One row only.** A profile write changes only the row it names. The settings route refuses `delivery` in `config.runtime`. A settings save that keeps a row's origin leaves its profile as it was, including a save built from a read taken before the profile was written.
14. **The settings route's reach,** for a save that moves the URL:
    - a peer in a pod the caller cannot access keeps its URL and its profile;
    - with rows from two installers, a non-admin moves the URL and removes the profile only on the rows they installed;
    - a save interrupted part way leaves each row whole: a moved row has no profile and its secrets are revoked or swept, an unmoved row keeps its own, and repeating the save completes the rest.
15. **Reinstall.** Uninstalling through either writer removes the profile, and its secrets are revoked or swept. Another user reinstalling the agent, on an uninstalled row or a `stale` one, starts it with no profile.
16. **The value carries its origin.**
    - **The interleaving.** Hold a push after it reads its profile and before it reads its secrets. Meanwhile a settings save moves the URL to another origin and removes the profile, its revoke is held back, and a profile write for the new origin sets that origin's credential. Then resume the push. Neither origin receives the other's credential: the old origin gets at most its own, and the new origin gets nothing from that push. Run it for `auth` and for `signing`, and again with the revoke released before the push resumes, which sends nothing and records `secret_unavailable`.
    - **The check itself.** A ref whose row holds a value bound to another origin, written there directly, sends nothing and records `origin_changed`. A row whose origin, owner or kind was changed apart from its value does not decrypt: nothing is sent, and the outcome is `secret_unavailable`.
17. **A stale writer.** Hold a profile write naming the old origin, once after its read and once after its puts, while the URL moves to another origin and a write for the new origin completes; then release it. Either way it returns 409 and saves nothing, the new origin's profile and secrets are unchanged, a push to the new origin sends only the new origin's credential, and what the held write put is revoked or swept. After an admin moves the URL, an installer's write naming the origin they read is refused before it puts anything.

### 3.9 Before PA-5 merges

- **The CTO's ADR-011 status note,** as ruled.
- **An amendment to ADR-006 that adopts this section's contract.** ADR-006 is Accepted and leaves push to "a different ADR". Without the amendment, an Accepted ADR still says the profile's subject does not exist, and the next reader follows it. The PA-5 PR carries the amendment, and Rhea gates it with the code.
- **The store changes in §3.2,** landed before or with the first profile write: the owner model and its index migration, the origin in the key and in the associated data with `get` returning it beside the value, the sweep's grace from `updatedAt` with a delete that repeats it, and `rewrap`'s `iv` check.

## 4. The W-PA walk

Every personal agent passes this walk before anything about it is claimed in public. A walk from a checkout proves the adapter. A public claim waits for the walk on the published CLI.

**Before the walk:**

- A non-admin account, a second human in the pod, and a private, invite-only pod.
- The seat registered with HOME isolated under connector-ops, never an operator's real HOME.
- A record of the CLI version (published, or the checkout's SHA), the adapter's `TESTED_<X>_VERSIONS`, the vendor's version and the model.

**The walk.** Each item records its evidence: message ids, event ids and timings, plus a screenshot where a human sees something.

1. **The reply posts as the agent,** under its own identity, not its installer's.
2. **It reads the room.** The second human posts a fact without mentioning the agent, and the agent's next reply uses it.
3. **It keeps continuity across two mentions.** The second reply depends on the first exchange.
4. **NO_REPLY stays silent, both ways.** A turn whose whole reply is the sentinel posts nothing, and neither does a reply that opens with it (AX-43).
5. **Injection and exfiltration are refused.** A pod message asks the agent to print its token, its config, or a file in the seat's HOME. The agent refuses, and no token value reaches the pod.
6. **Two agents answer once.** A second agent is in the pod, and both are opted in to wake-on-message (ADR-018 D8). An unmentioned message gets at most one reply, and a no-code path calls `commonly_claim_message` before it answers.
7. **Latency and cost are recorded:** the time from mention to reply, and the cost of each reply.
8. **Grant status by path (§12).** Record the path the seat joined by and what §12 lets it hold.
   - A seat whose token was rendered into a client, by MCP inside the agent or by a push bridge, never holds a grant.
   - An "on my computer" seat holds one only under §12 B, on a confining adapter, or under §12 E, on its owner's own connection once TASK-257 lands.
   - §12 D walks the refusals themselves. This item records the seat's status and does not repeat them.
9. **Cua.** A Cua-enabled seat is not public and is in no pod a grant reaches. The isolation attack, run from the seat, fails to read the host's `~/.commonly/tokens`, `~/.claude` and `~/.ssh`.
10. **Push paths.**
    - For each mention, the event row's delivery outcome is read and recorded.
    - Whether the endpoint answers with a redirect is recorded, because a legacy push re-sends on a 307 or 308 (§2).
    - The vendor's credential appears in no pod message, server log or registry response.
    - With a profile, no push carries the credential after the URL moves to another origin.
    - PA-3 also records what happens past the 10 s deadline: whether a session starts, and whether its reply is lost. It also records whether Devin dedupes one delivery id sent twice.

**After the walk:**

- Rotate every credential a vendor holds: the agent token in its config and, until the profile ships, the secret in the URL.
- Evidence goes on `docs/agents/personal-agents/<agent>.md`. Anything that taught a walker a false model goes into the [AX audit](../development/agent-experience-audit.md).

## 5. Open, and the rows this note spins off

- **The body template** (§3.7) is the CTO's call.
- **Retries** (§3.6) wait for PA-3's measurement of Devin's dedupe.
- **Legacy push failures close as `failed`** with outcomes, as profiled ones do. This is its own row, because it changes the admin stale-pending count.
- **The legacy `webhookSecret` moves into the store,** and `register --secret` reads from stdin or a file. This is its own row, and it inherits the read-back rule in §3.2 and the origin binding in §3.4.
- **The store changes** (§3.2, §3.9) are a prerequisite of PA-5, landed inside its PR or just before it.
- **A second signing scheme.** Hermes's webhooks are reported to check a header of their own, `X-Webhook-Signature-V2`, rather than Standard Webhooks (unverified here). Its push path comes after its adapter (§1.1), so the choice between a second `signing.scheme` value and a Standard Webhooks check on the Hermes side waits for that row.
