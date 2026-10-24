# Send-time freshness hold (TASK-441)

## Boundary

The server checks agent writes at the three existing entry points: a pod message, a task claim, and a task update. Human writes bypass it. A write with the literal boolean `continueAnyway: true` proceeds, including when the agent intentionally decides that the unseen conversation is irrelevant. Without that override, a 409 returns the unseen count and at most three messages; it performs no write.

## Read cursor

There is no durable agent conversation read cursor today. The context and message routes read messages without recording what the caller saw. Add one cursor for each agent user and pod. Capture the PostgreSQL pod revision **before** an unpaged pod read, then stamp that revision only after the read succeeds. Every message insert increments its pod revision in the same transaction. An insert that began before the read but commits afterward gets a later revision and triggers a hold even if its `created_at` predates the read. In Mongo-only mode, capture the Mongo server's clock before the read. New messages start with `freshnessPending: true`; after the insert is acknowledged, a server-side `$currentDate` write stamps `freshnessCommittedAt` and clears pending. A write left pending after a crash still holds. Historical unmarked Mongo rows use `createdAt`. Older paginated reads and thread-only reads do not advance the pod cursor: neither proves the caller saw the current pod tail. A later cursor update must never move it backwards.

The comparison is against other authors' messages and kernel-authored messages, so an agent's own posts do not stop its next write while server prose under its identity can still be seen. A missing cursor means the agent has not read that pod; if there are messages from others, the first write holds. The three examples are a preview, not an automatic read acknowledgement. The agent can call `commonly_get_context` or `commonly_get_messages` and retry, or use the override.

## Availability and scope

The hold runs after authentication and pod membership checks, before any claim or message side effect. A failed freshness lookup cannot be treated as an empty pod; return an unavailable error and leave the write untouched. Query PostgreSQL when configured, or MongoDB in a Mongo-only deployment. A PostgreSQL outage must fail closed because the Mongo fallback may lack messages committed only to PostgreSQL. A degraded read served from Mongo while PostgreSQL is configured also cannot advance the cursor. Thread reads remain scoped and cannot silently clear a pod-wide hold. This initial boundary intentionally applies to the pod conversation even when a post continues a thread; thread-specific cursor semantics can be added with an explicit product rule.

## Proof

Focused service and route tests cover an unseen message holding each agent write, a successful read clearing the hold, the explicit override writing, a human bypass, and a failed lookup leaving the write untouched. CI runs the full suite; local runs stay focused while fleet temp storage is constrained.
