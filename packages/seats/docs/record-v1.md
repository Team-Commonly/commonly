# Run record, format v1

A run record is an append-only log of one agent run:
- who claimed which task;
- which access the run was granted, and by whom;
- which tool calls were asked about, and who decided them;
- what the agent attempted, and what came of it.

The format is plain JSON lines, so a tool that has never seen this code can
read it, verify it and export it.

One file holds one run. Several runs of the same task (a retry under a new
run, another person's agent reviewing the work) are several files that share
a `podId` and a `taskId`.

The reference implementation:
- `src/record/format.js` writes and verifies records;
- `src/record/otel.js` exports them as OTLP;
- `src/trace/store.js` is the store that writes them.

A generated sample is in [`examples/`](examples/) (section 7).

## 1. Envelope

Each line is one JSON object, followed by `\n` (UTF-8):

```json
{"actor":{"id":"u-agent-ana-opencode","name":"Ana's opencode","owner":"u-ana","type":"agent"},"data":{"adapter":"opencode","attempt":1,"cli":{"name":"opencode","version":"1.19.0"}},"kind":"attempt.started","podId":"pod-checkout","prev":"8de2801011b74ef1386e35eaa53bf6e0d5fce3692309ba832bc44a9005c2b97c","runId":"run-ana-0001","schema":"seats.record","seq":4,"taskId":"TASK-101","ts":"2026-10-25T16:00:05.000Z","v":1}
```

| field | type | meaning |
|---|---|---|
| `v` | integer | Format version. This document is `1`. |
| `schema` | string | Always `"seats.record"`. |
| `runId` | string | The run, `[A-Za-z0-9_-]{6,64}`. The same on every line of a file. |
| `taskId` | string, optional | The board's task id, verbatim (e.g. `"TASK-490"`). The same on every line when present. |
| `podId` | string; **required when `taskId` is set** | The pod the run belongs to. Task ids restart in each pod, so `taskId` is unique only together with `podId`. The same on every line when present. |
| `seq` | integer | 1 on the first line, then +1 per line, with no gaps. |
| `ts` | string | RFC 3339 timestamp in UTC: `YYYY-MM-DDTHH:MM:SS(.fraction)Z`. |
| `kind` | string | What happened (section 2). |
| `actor` | object or `null` | Who caused the entry (below). |
| `data` | object | Kind-specific fields (section 2). |
| `prev` | string or `null` | Lowercase hex SHA-256 of the previous line's bytes. `null` on `seq` 1. |

**`actor`** is `{type, id, owner?, onBehalfOf?, name?}`:
- `type` is `agent`, `human`, `policy` or `system`.
- `id` is an identity, never a display name.
  - For `agent` and `human` it is the instance's user id. Agents are users too.
  - For `system` it names the writing component: `seats` (the run writer)
    or `board`.
  - For `policy` it names the grant whose rules decided (`grant:<grantId>`),
    or `policy`.
  - It is a token (`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`), so a name with spaces
    can't pass for one.
- `owner` is set on `agent` actors only. It is the user id of the person the
  agent belongs to.
- `onBehalfOf` is set on `agent` actors only, and is optional. It is the
  human whose request the agent is acting on (below).
- `name` is an optional display name. It is never part of the identity.

The owner of an agent and the person who approves what it does are separate
fields on purpose:
- `actor.owner` says whose agent this is;
- the approver is `decidedBy` on `permission.decided`.

In the case this format exists for, they differ: Ana's agent asks, and Ben
approves.

**`actor.onBehalfOf`** is `{id, role}`. It records the pair an audit trail
needs for an agent's action: the agent, and the human it acted for
(ADR-025 D18). `owner` can't say this, because it only says whose agent it is.
- `id` is the human's user id, an id token under the same rule as `actor.id`.
- `role` is one of:
  - `requester`: the human whose message started the run;
  - `assigner`: the human who assigned the task.
- No other key is allowed. A writer throws on an unknown role or key, and a
  verifier reports `bad_envelope` (`actor`) for a line that has one.
- It is allowed on `agent` actors only. Any other actor type carrying it is a
  malformed actor.
- It lives on the actor, never in `data`, so it covers every entry the agent
  authors (`tool.call` and `permission.requested` included), and the pair is
  never split across two places.
- A run with no human behind it (a schedule, a heartbeat, an agent-to-agent
  DM) writes no `onBehalfOf`. A writer never fills it in with the agent's
  owner: `owner` already says whose agent it is, and `onBehalfOf` means a
  human asked. The writer does not enforce this by comparing `id` to `owner`,
  because the owner can really be the requester (Ana asks her own agent), and
  that line must be accepted.

Adding it kept `v: 1` (section 3, rule 3), and a line without it is
byte-identical to one written before the field existed. Ana's agent, acting
on a message from Ben, calls a Sentry tool:

```json
{"actor":{"id":"u-agent-ana-opencode","onBehalfOf":{"id":"u-ben","role":"requester"},"owner":"u-ana","type":"agent"},"data":{"name":"sentry.resolve_issue","surface":"connector","title":"Resolve CHECKOUT-88","toolCallId":"tc-1"},"kind":"tool.call","podId":"pod-checkout","prev":"cbe33a93d273b1ad959fb6e836995ac8c9a119921ddbcce7b785c7d63ccf2a9e","runId":"run-ana-0002","schema":"seats.record","seq":2,"taskId":"TASK-101","ts":"2026-10-25T16:01:05.000Z","v":1}
```

`actor: null` means the writer did not know who caused the entry. A reader
must not fill it in. Each kind has a default actor (section 2), which a
writer records when the emitter names none.

**Canonical serialization.** A line is the JSON Canonicalization Scheme
(RFC 8785) form of its entry:
- object keys are sorted by UTF-16 code units;
- there is no insignificant whitespace;
- strings and numbers are serialized as ECMAScript `JSON.stringify` does;
- an absent field is omitted, never written as `null`. `actor` and `prev` are
  the two fields where `null` is a value.

A writer in any language that follows these rules produces byte-identical
lines. A verifier rejects a line that is not in canonical form.

**What `prev` covers.** `prev` is SHA-256 over the exact bytes of the previous
line, without its trailing `\n`. It is not taken over a re-serialization, so
a verifier needs no JSON library to check the chain.

## 2. Kinds

Every kind below is part of v1. "Default actor" is the actor a writer records
when the emitter names none. "run" means the run's own actor, usually the
agent.

### Claim

The board is the source of truth for tasks. Its states are `pending`,
`claimed`, `done` and `blocked`. The record only observes the board: these
entries mirror what the board already holds, and they never change it.

| kind | data | default actor |
|---|---|---|
| `task.claimed` | `{leaseUntil?}` | run |
| `task.released` | `{reason?}`, such as `blocked`, `lease_expired`, `reassigned` or `abandoned` | run |
| `task.done` | `{doneBy?}` (a user id) | `{type: system, id: board}`. The board is its writer. |

`task.done` needs a run with a `taskId`. Writing it ends every open grant
bound to that task (below).

### Grant

A grant has the shape of a room grant: a connection, exact tool names, a
write mode, a budget and an audience, plus its parent for attenuation.

| kind | data | default actor |
|---|---|---|
| `grant.issued` | `{grantId, parentGrantId?, scope, target?, issuedBy?, expiresAt?, binding?}` | derived from `issuedBy`: `policy` gives a policy actor, a user id gives a human actor |
| `grant.revoked` | `{grantIds: [grantId, …], reason}` | `system` |

**`scope`** is `{connectionId?, tools: [name], writeMode?, budget?, audience: [userId]}`:
- `connectionId` is the connection whose credential the grant uses. The
  credential itself is never named or recorded. A broker resolves it.
- `tools` are exact tool names, such as `sentry.resolve_issue`, never patterns.
- `writeMode` is `read`, `write` or `write-with-confirm`.
- `budget` is `{calls?, windowMs?}`.
- `audience` lists the user ids the grant was minted for.

**The other fields:**
- `parentGrantId` is the grant this one attenuates, if any. Following it gives
  the lineage.
- `target` is `{kind: pod|seat, id}`: whom the grant is to.
- `issuedBy` is a user id, or `policy`.
- `binding` is `{taskId, podId, endsOn}`, and it must name the run's own
  `taskId` and `podId`. `endsOn` is one of:
  - `task.done`: the grant ends when the board marks its task done;
  - `expiresAt`: it ends at `expiresAt`, which is then required.

**`grant.revoked`** ends every id in `grantIds` in a single entry. `reason` is
one of:
- `task.done`: the bound task is done. The writer records this right after `task.done`;
- `expired`: `expiresAt` passed;
- `cascade`: an ancestor was revoked. `grantIds[0]` is that ancestor, and the
  rest are its descendants, all ended by the same write;
- `manual`: a person or policy revoked exactly these grants. The actor says who.

The reasons are unchanged by the 2026-10-25 revision. In a hosted pod, server
writers (TASK-513) supply `expired` and `cascade`, because the server holds
grant expiry and lineage. The local store writes the same two reasons from
`expireGrants` and `revokeGrant` for a run that has no server writer.

**What revocation means in v1.** A revoked grant is no longer valid. A
credential that a run placed in its agent process's environment stays there
until that process exits. A revocation records that the grant's term ended;
it does not prove the process lost access. That happens at `run.settled`.

### Approval

| kind | data | default actor |
|---|---|---|
| `permission.requested` | `{toolCallId?, options: [{optionId, kind}], question, askedOf: {id, role}, grantId?, decisionCardId?, argsDigest?}` | run |
| `permission.decided` | `{outcome, optionId?, kind?, toolCallId, rule, approval?, decidedBy, decidedByRole, decisionCardId?, grantId?, argsDigest?}` | the decider: a human actor for a user id, a policy actor for `policy` |
| `decision.ruled` | `{decisionCardId, value, decidedBy, decidedByRole}` | the decider, as for `permission.decided` |

**The request:**
- `question` is required: the human-readable ask, normally the tool call's
  title. It is agent text, so it is scrubbed of known credential values
  before it is written, like other agent text (section 3, rule 1).
- `askedOf` is required: `{id, role}`.
  - `id` is an id token, under the same rule as `actor.id`.
  - `role` is from the `decidedByRole` enum below.
  - A call that a rule decides, with no person asked, is asked of the policy:
    `{id: "grant:<grantId>", role: "policy"}`.
- `grantId` is the grant the call would act under.
- `decisionCardId` is the card the ask rides on, when there is one.
- `argsDigest` identifies the call's arguments (under Tool activity, below).

**The decision:**
- `outcome` is `selected` or `cancelled`.
- `kind` is the ACP option kind chosen: `allow_once` approves, and
  `reject_once` refuses.
- `rule` is `{list, pattern}`:
  - `list` is `allow`, `ask`, `deny` or `default` (no rule matched);
  - `pattern` is the run policy's pattern that matched, or `null`.
- `approval` is present only when someone was asked. It is `approved`,
  `rejected`, `timed_out`, `failed` or `aborted`.

**Who decided:**
- `decidedBy` is required: a user id, or `"policy"`. A writer refuses `null`.
  - A rule-decided call is `"policy"`. So is the default given when no
    answer came in time, or when the answer did not name a user and an owner
    role: such an answer approves nothing.
  - A permission hook's answer is held to the same rule. An answer that does
    not name who decided (`decidedBy` a user id, plus an owner
    `decidedByRole`) gets the reject default, recorded as
    `decidedBy`/`decidedByRole` `policy`/`policy` with `approval: failed`. A
    decider marked `recordsPermissions` (the valet's policy) writes and
    attributes its own entries, so it is exempt.
  - It is `"policy"` exactly when `decidedByRole` is `"policy"`.
- `decidedByRole` is one of:
  - `credential-owner`: the owner of the connection the call would use. This
    is who decides approvals today;
  - `decision-owner`: a person assigned to the decision. This is reserved,
    and writers may not emit it yet;
  - `agent-owner`: the owner of the asking agent;
  - `pod-member`: a person in the pod who owns neither the credential nor
    the asking agent. It is valid only on `decision.ruled`. A parked call is
    decided by an owner or by policy, so `permission.decided` and
    `permission.requested.askedOf` refuse it;
  - `policy`.

  It is required on `permission.decided`, and a writer refuses `null`.
- `decisionCardId` is set when the decision came through a decision card.
- `grantId` ties the decision to its `grant.issued`.

**`decision.ruled`** records a ruling on a decision card that is not tied to
a parked tool call, such as whether to retry a stuck attempt.
- `decisionCardId` is required.
- `value` is the ruling: a string, number or boolean.
- `decidedBy` is required. It is a user id, or `"policy"`.
- `decidedByRole` is required, and comes from the same enum. Only here may it
  be `pod-member`.

A ruling on a card that a `permission.requested` carried belongs with that
request, and the OTLP export places it there.

### Attempt

| kind | data | default actor |
|---|---|---|
| `attempt.started` | `{attempt, adapter, cli?: {name, version}, sessionId?}` | run |
| `session.opened` | `{method, sessionId, requestedSessionId?, fallback?}` | `system` |
| `attempt.settled` | `{attempt, outcome, failure?: {kind, detail}}` | `system` |
| `run.settled` | `{outcome, failure?, durationMs, attempts}` | `system` |
| `harness.switched` | `{from, to, reason}` | `system` |

- `outcome` is `ok`, `failed`, `stuck` or `cancelled`.
- `failure.kind` is a key of `FAILURE_KINDS` in `src/failures.js`, or `null`
  when the cause had no name.
- The agent's id and owner are the actor of `attempt.started`.
- `session.opened` records the agent session an attempt runs in, as an ACP
  adapter opens it:
  - `method` is `new`, `resume` or `load`;
  - `sessionId` is the session the attempt runs in, a non-empty string;
  - `requestedSessionId` and `fallback` are set together, only when
    `method` is `new`: a session was asked for and could not be reopened.
    `fallback` is one of two forms, `agent supports neither session/resume
    nor session/load`, or `session/<resume|load> answered error <code>`
    with the JSON-RPC error's integer code;
  - no other field is allowed.
- `harness.switched` comes before the `attempt.started` of an attempt that
  runs on another entry of the seat's run config than the one the seat was on
  (`src/harness-plan.js`):
  - `from` and `to` are entry labels, `harness/model` or
    `harness/model@effort`, written the one canonical way and never equal;
  - `reason` is a key of `SWITCH_REASONS`: `not_authenticated`, `quota` or
    `provider_unsupported` (the entry above failed that way), `blocked`
    (the entries above were skipped), `probe` (a probe moved back up the
    list) or `operator` (an operator switched the seat);
  - no other field is allowed. The attempt that follows starts a fresh
    session.
- `run.settled` is the last line of a complete record. Nothing is written
  after it.
- If an attempt has no `attempt.settled`, the record says only that the next
  `attempt.started`, or `run.settled`, came after it. A reader must not infer
  the outcome.

### Tool activity

| kind | data | default actor |
|---|---|---|
| `tool.call` | `{toolCallId, title, kind?, status?, name?, surface?, argsDigest?}` | run |
| `tool.update` | `{toolCallId, status?, title?}` | run |

- `kind` is the ACP tool kind (`read`, `edit`, `execute`, `fetch`, …).
- `name` is the tool's own name, when known.
- `surface` says where the call went:
  - `connector`: a third-party service, through a connector;
  - `commonly`: the room's own tools (`commonly_*`);
  - `native`: the CLI's built-in tools.

  All three land in the same record.
- `argsDigest` is a digest of the call's arguments, never the arguments:
  `"sha256:"` followed by the lowercase hex SHA-256 of the arguments'
  RFC 8785 canonical form, the same serialization as a line. Key order does
  not change it. For example, `{"b":2,"a":1}` is digested as the bytes
  `{"a":1,"b":2}`.
  - A writer refuses any other value, so raw arguments can't ride in under
    this name.
  - The same arguments give the same digest on `tool.call`,
    `permission.requested` and `permission.decided`, so a reader can match a
    call to the approval it ran under.
  - The valet writes it on both permission entries when the ACP tool call
    carries `rawInput`. An adapter writes it on `tool.call` with
    `argsDigestOf(rawInput)`.
  - A digest of low-entropy arguments can be confirmed by guessing them. It
    hides the values from a casual reader, not from someone who can guess them.

**Conformance gate for writers in other languages.** Every record writer,
in any language, must pass every vector in
[`test/vectors/args-digest.json`](../test/vectors/args-digest.json), and a
writer that fails it does not ship. `test/args-digest-vectors.test.js` holds
the file to `argsDigestOf`, so the file is the definition, not a sample. The
vectors cover:
- key order by UTF-16 code units;
- string escaping, with U+2028 and U+2029 written raw;
- number formatting: `1.0` is `1`, `-0` is `0`, `1e21`, small floats, and an
  integer past 2^53, which a writer parses as an IEEE 754 double first, so
  `9007199254740993` on the wire is written `9007199254740992`;
- the cases where a hand-rolled key-sorted serializer drifts: an undefined
  value in an object drops its key, one in an array becomes `null`, and `NaN`
  or `Infinity` anywhere means the arguments have no digest.

A lone surrogate (half of a UTF-16 pair) in any string or key also means no
digest, as RFC 8785 requires. Only the digest refuses it: a line still
records agent text holding one, as a `\u` escape, because a stream cut
mid-pair must not lose the chunk. On arguments that can't be digested, a
writer omits `argsDigest` rather than writing a different digest, because a
different digest would not match the approval the call ran under. A writer
built in Go runs its tests with `-race` in CI.

### Credentials

| kind | data | default actor |
|---|---|---|
| `credential.granted` | `{names: [NAME]}` | `system` |
| `credential.denied` | `{name, reason}`, where `reason` is `not_granted`, `unresolved` or `too_short` (a value under 8 characters) | `system` |

These cover the environment credentials a run is started with. Values never
appear here: `NAME` is an environment variable name matching
`[A-Z_][A-Z0-9_]*`.

### Sandbox

| kind | data | default actor |
|---|---|---|
| `sandbox.applied` | `{sandbox, reason?}` | `system` |

- `sandbox` is the OS sandbox the run's process was started in: `seatbelt`
  (macOS), `bwrap` (Linux), or `none`.
- `reason` says why there was none. It is set only when `sandbox` is `none`,
  and is a non-empty string. A writer may leave it out when it has no
  reason to give.
- No other field is allowed.
- It is its own group, not part of Attempt: it records how the process was
  confined, not what the attempt did or how it ended.

### Egress

A sandboxed run reaches the network only through the egress proxy, which
admits the hosts its grant names, plus its model provider. These lines
record what the proxy did.

| kind | data | default actor |
|---|---|---|
| `egress.allowed` | `{host, port}`: a tunnel opened | `system` |
| `egress.denied` | `{host, port, reason}`: a request was refused | `system` |

- `host` is a lowercase DNS name, an IP literal (IPv6 without brackets), or
  the literal string `"[redacted]"` when the requested name held one of the
  run's credentials.
- `port` is an integer from 1 to 65535.
- `reason` is one of:
  - `bad_request`: the request could not be parsed;
  - `not_connect`: a method other than `CONNECT`;
  - `ip_literal`: the target was an address, not a name;
  - `not_allowed`: no grant entry names the host and port;
  - `unresolved`: the name did not resolve;
  - `private_address`: it resolved to a non-public address that no exact
    entry names;
  - `unreachable`: the connection failed.
- `host` and `port` are `null` together, and only on a malformed request
  (`bad_request`, or `not_connect` when the target can't be read). Every
  other line names both.
- No other field is allowed, so no header, body or resolved address is
  recorded.

### Result

| kind | data | default actor |
|---|---|---|
| `result.reported` | `{status, refs?: [{type, id}]}` | run |

- `status` is `done`, `partial`, `blocked` or `failed`.
- A ref points at what the run produced, such as `{type: "pr", id: "#212"}`.

### Run activity

These kinds carry the trace vocabulary through unchanged. Their data is
documented in `src/trace/events.js`.

| kind | default actor |
|---|---|
| `turn.prompt_sent` | `system` |
| `agent.message_chunk`, `agent.thought_chunk`, `agent.retry`, `plan`, `usage` | run |
| `liveness.stalled`, `liveness.recovery`, `process.exited` | `system` |

`usage` may also carry `contextTokens` (how much of the agent's context
window is in use) and `contextSize` (the window's size). Each is an integer
`>= 0`, or `null` when unknown; a writer refuses any other value.

`agent.retry` is the agent reporting that it is retrying its provider:
`{state, attempt?, nextRetryAt?, status?, errorType?}`.
- `state` is `scheduled` (a retry waits until `nextRetryAt`) or `started`
  (the waited-for attempt went out).
- `attempt` is an integer `>= 1`, and `nextRetryAt` an RFC 3339 UTC
  timestamp.
- `status` is an integer HTTP status, `100` to `599`.
- `errorType` is one of `provider.auth`, `provider.content-filter`,
  `provider.free-limit`, `provider.internal`, `provider.invalid-output`,
  `provider.invalid-request`, `provider.no-route`, `provider.quota`,
  `provider.rate-limit`, `provider.timeout`, `provider.transport`,
  `provider.unknown`, `provider.unsupported-operation` or `other`. These are
  the provider error types opencode 2.1.4 reports on a retry; a writer maps
  any other type to `other`.
- A field that is not known is absent, never `null`. The agent's error
  message and the provider's response body are never recorded, and a writer
  refuses any field not listed here.

### Mapping from the trace vocabulary

Emitters keep calling `emit(type, data)` with `EVENT_TYPES` names, and the
store writes the record kind:

| `EVENT_TYPES` entry | record kind |
|---|---|
| `run.started` | `attempt.started` (renamed: it is emitted once per attempt) |
| every other entry | the same name |

What's new or changed in `EVENT_TYPES`:
- `task.claimed`, `task.released`, `task.done`, `grant.issued`,
  `grant.revoked`, `attempt.settled`, `decision.ruled` and
  `result.reported` are new entries.
- `emit` also accepts the record kind `attempt.started`.
- `readRun` returns each entry with its trace name as `type` (`run.started`
  for an `attempt.started` line), and puts the envelope fields beside it.

## 3. Rules

1. **No secret values, by construction.**
   - No field of any kind holds a credential value. A grant names a
     connection id. A run's environment credentials appear only as names,
     and a writer refuses one that is not name-shaped.
   - Agent-authored text, such as message chunks and tool titles, belongs to
     the agent and could repeat a value the agent holds. A writer that knows
     the run's credential values replaces every occurrence of each, whatever
     its length, with `[redacted]` before the line is hashed. A writer does
     not grant a credential shorter than 8 characters (`credential.denied`,
     `too_short`).
   - Message and thought chunks are scrubbed per stream, not per line, so a
     value split across chunks is caught. A writer holds back a chunk's tail
     while it could begin a known value, and writes it with the stream's next
     chunk. If the stream ends first, the held tail is a partial value, so the
     writer writes `[redacted]` as a chunk of its own in its place, before the
     next `attempt.started`, `attempt.settled` or `run.settled`. A short
     ordinary tail that happened to begin a value is redacted too. A held tail
     lives only in the writer's memory: a writer that crashes before the next
     write loses it, and never writes it.
   - That replacement covers known values only. A value the writer was not
     given, or one the agent transformed (base64, say), passes through.
2. **Readers ignore unknown fields and skip unknown kinds.** A reader that
   meets a kind it doesn't know still checks the chain over that line.
3. **`v` bumps only on a breaking change:**
   - a field removed or renamed;
   - a meaning changed;
   - a change to the hash or serialization rules.

   Adding a kind, an optional field or an enum value doesn't break anything,
   and keeps `v: 1`. A reader refuses a `v` higher than it knows.

   The 2026-10-25 revision kept `v: 1`. It added `decision.ruled`,
   `argsDigest`, and `grantId` and `decisionCardId` on
   `permission.requested`. It also made `question` and `askedOf` required
   for writers of `permission.requested`.
   - Readers must not assume those two fields on lines written before the
     revision.
   - The verifier checks the envelope and the chain, never data, so those
     lines still verify.

   A later revision, also at `v: 1`, added the optional `actor.onBehalfOf`,
   the kinds `session.opened`, `sandbox.applied`, `egress.allowed`,
   `egress.denied` and `agent.retry`, `contextTokens` and `contextSize` on
   `usage`, and the `pod-member` value of `decidedByRole`. Lines without them
   are unchanged.

   A later revision, also at `v: 1`, added the kind `harness.switched` and the
   failure kinds `not_authenticated`, `quota`, `provider_unsupported` and
   `capacity`. Lines without them are unchanged.
4. **One writer per file.** A single process appends lines in `seq` order.

## 4. What the hash chain proves, and what it doesn't

**It detects:**
- an edited byte in any line except the last;
- a deleted line, which leaves a `seq` gap and a `prev` mismatch;
- lines reordered within the file;
- a torn final line, where a crash stopped a write partway.

**The last line** is covered only against an outside record of the head:
- When a run settles, the store writes `head` (the SHA-256 of the last line)
  and `entries` to its index, and `verifyRun` checks both.
- The index sits in the same directory and is just as editable, so this
  catches accidents, not an adversary.
- A record cut short before `run.settled` is a valid prefix. It is reported
  as unsettled, not as tampered.

**It does not prove:**
- that any event happened. The writer could have recorded anything;
- who wrote the file. There is no signature in v1;
- that the whole file wasn't replaced by a different chain that is consistent
  with itself;
- anything across files. Two runs of one task are not chained together.

So the chain shows that the file is the one its writer wrote, in the order
it was written. Whether the writer told the truth is a question for whoever
operates it.

## 5. OpenTelemetry mapping

`toOtlpJson(entries, {serviceName})` returns an OTLP/JSON
`ExportTraceServiceRequest`, nested as `resourceSpans` → `scopeSpans` →
`spans`. The resource carries `service.name`, and the scope is
`seats.record`, version `1`.

### Shape

- **A task is a trace.** `traceId` is the first 16 bytes of
  SHA-256(`"seats.record/trace/task/" + podId + "/" + taskId`). A run with no
  task uses SHA-256(`"seats.record/trace/run/" + runId`). Every run of one
  task lands in one trace.
- **A run is a span:** `seats.run`, kind INTERNAL, the root of its run.
- **An attempt is a child span of its run:** `invoke_agent {agent name}`.
- **A tool call is a child span of its attempt:** `execute_tool {tool name}`.
- **Decisions are span events.** A `permission.*` entry goes on the tool span
  with the same `toolCallId`. Without one, it goes on the current attempt,
  then the run. A `decision.ruled` entry goes on the span of the request
  that carried its `decisionCardId`, and otherwise on the span current at
  the time.
- **Every other kind is an event on the span current at the time.** That
  covers grants, credentials, claims, `task.done`, results, liveness,
  `session.opened`, `harness.switched`, `sandbox.applied`, egress and `tool.update`. An egress denial is an event, not an error status.
- **Span ids** are the first 8 bytes of
  SHA-256(`"seats.record/span/" + runId + "/" + seq`), where `seq` belongs to
  the entry that opens the span. The run span uses `0`. Exporting the same
  entries always produces the same bytes.
- **Times** come from the entries' `ts`:
  - A span ends at its closing entry: `attempt.settled`, the next
    `attempt.started`, `run.settled`, or a tool's `completed` or `failed`
    update.
  - A span with no closing entry ends when its parent does.
- **Status:**
  - The outcomes `failed`, `stuck` and `cancelled`, and a tool update with
    status `failed`, set `STATUS_CODE_ERROR`.
  - The error class goes in `error.type`: the failure kind, or `tool_failed`.
  - Success leaves the status unset, as OpenTelemetry recommends for
    instrumentation.
- **Not exported:** message and thought chunks are left out, following the
  upstream conventions, which make content capture opt-in. Unknown kinds are
  skipped.

### OpenTelemetry GenAI conventions used

The source is github.com/open-telemetry/semantic-conventions-genai, read on
2026-10-25 at commit `9ffc7e00`. The GenAI pages on opentelemetry.io now say
they have moved there.

**Upstream status:** both documents used here (`gen-ai-agent-spans.md` and
`gen-ai-spans.md`), and every `gen_ai.*` attribute below, are **Development**
status. They can change without a major version, so this mapping is pinned
to that commit. `error.type` is Stable.

| attribute | on | from |
|---|---|---|
| `gen_ai.operation.name` | attempt, tool | `invoke_agent`, `execute_tool` |
| `gen_ai.agent.id` | attempt | `actor.id` of `attempt.started` |
| `gen_ai.agent.name` | attempt, tool | `actor.name`, else `actor.id` |
| `gen_ai.conversation.id` | attempt | `sessionId` of `attempt.started`, else of the attempt's `session.opened` |
| `gen_ai.tool.name` | tool | `name`, else `title` |
| `gen_ai.tool.call.id` | tool | `toolCallId` |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | attempt | the last `usage` entry in the attempt |
| `error.type` | any span with error status | failure kind, or `tool_failed` |

### Choices and gaps

- **The attempt span is INTERNAL, not CLIENT.** The agent runs in a child
  process, so neither upstream variant fits exactly. The CLIENT variant of
  `invoke_agent` makes `gen_ai.provider.name` Required, and a supervisor
  cannot know which provider a CLI chose.
- **`gen_ai.tool.type` (Recommended) is not set.** Its upstream values
  (`function`, `extension`, `datastore`) don't map cleanly onto `surface`.
- **Everything else uses the neutral `seats.*` namespace:**
  - these named attributes: `seats.run.id`, `seats.task.id`, `seats.pod.id`,
    `seats.run.outcome`, `seats.run.attempts`, `seats.attempt.number`,
    `seats.attempt.outcome`, `seats.adapter`, `seats.cli.name`,
    `seats.usage.context_tokens`, `seats.usage.context_size` (the last
    known values in the attempt),
    `seats.cli.version`, `seats.agent.owner`, `seats.agent.on_behalf_of.id`,
    `seats.agent.on_behalf_of.role`, `seats.tool.kind`,
    `seats.tool.surface` and `seats.tool.args_digest`;
  - on every event, `seats.seq` and `seats.actor.type`, `.id`, `.owner`,
    `.name`, `.on_behalf_of.id` and `.on_behalf_of.role`;
  - on the tool span, `seats.actor.on_behalf_of.id` and `.role` from the
    `tool.call` actor, so the pair sits on the action itself;
  - the event's data, flattened as `seats.<path>` with camelCase segments in
    snake_case. For example, `decidedBy` becomes `seats.decided_by`, and
    `scope.connectionId` becomes `seats.scope.connection_id`, and
    `askedOf.id` becomes `seats.asked_of.id`.

## 6. Not in v1 (open for v2)

- **Signing.** The writer signs each line, or each head, so that "who wrote
  this" can be proved and a replaced file can be detected.
- **Multi-writer chains.** A pod-level record that several hosts append to
  needs ordering across writers: one chain per writer plus a merge, or a
  sequencer.
- **Cross-run linking.** A run's first line could be chained to the previous
  run of the same task, or each task could keep a head, so that a deleted run
  can be detected. This also closes a v1 gap. When a task is marked done after
  a run that held a task-bound grant has already settled, that run's file has
  no `grant.revoked` line. The sample shows this with Ana's grant.
- **Live revocation.** A brokered credential, behind a proxy rather than in an
  environment variable, would let `grant.revoked` take effect inside a running
  process.
- **Pod-level views.** These are a filter on `podId`, which v1 already writes
  on every task-bound line.

## 7. Sample

`examples/` is generated by `test/record-example.test.js`. A test fails if the
files drift from what the code writes.

- `run-ana-0001.jsonl`: Ana's agent (opencode 1.19.0) claims `TASK-101` in
  `pod-checkout`.
  - Its grant attenuates Ben's Sentry connection grant.
  - The first attempt is stuck. Ana rules `retry` on card `card-2b9` as
    `agent-owner` (`decision.ruled`), and the agent is retried.
  - A `git push` is denied by the policy.
  - The headline case: Ana's agent asks a question about a Sentry write. The
    `permission.requested` line is tied to Ana's grant and to card
    `card-7f3`, and is asked of Ben as `credential-owner`. Ben approves it on
    that card. `tool.call` and both permission entries carry the same
    `argsDigest`.
  - The run reports a PR.
- `run-ben-0001.jsonl`: Ben's agent (goose 1.54.0) reviews the PR under a
  read grant bound to the task. The board then marks the task done, which
  revokes that grant in the same run.
- `TASK-101.otlp.json`: both runs exported as one trace.
