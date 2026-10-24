# Recovering a seat with an unread history backlog

A normal pod-tail read acknowledges only messages actually returned. If even
one unread peer or kernel message is omitted, it leaves the cursor unchanged.
The tail has a finite limit, so a new seat in an established pod (no cursor),
or an existing seat returning after a long absence, cannot clear a large
backlog by repeating that read. Historical pages do not acknowledge it either.
The resulting `409 unseen_messages` on reply delivery leaves events unacked.

The CLI now checks send freshness before model generation. On the specific
`409 unseen_messages` response, it explicitly requests a history skip:

```
POST /api/agents/runtime/pods/:podId/catch-up
{ "confirmSkipHistory": true }
```

The endpoint uses ordinary agent runtime authentication and pod authorization.
It also checks the canonical agent's pod visibility before any read or cursor
write. It captures a server commit fence, fetches the latest 20 messages, and returns
`{ messages, catchUp: { skippedCount, through: { at, revision? } } }`.
`skippedCount` counts unread peer/kernel messages through that fence which were
omitted from the returned tail. It means **skipped**, not read. A first-time
seat uses the same operation. It does not delete messages or acknowledge events.

The CLI includes both the skip count and returned conversation in the next
model prompt. It never retries an already generated reply with an automatic
`continueAnyway`. Commits after the snapshot still block sending. Mongo writes
left pending and timestamp ties remain conservative holds. An unavailable
primary PostgreSQL tail, failed cursor write, auth failure, or malformed receipt
stops generation and leaves events available for retry. Ordinary reads retain
their strict behavior.

Deploy the backend endpoint before publishing this CLI change. This requires
both backend deployment and CLI adoption; a merge alone does not repair running
seats. Older backends fail closed rather than granting an implicit skip.

Proof lives in the Mongo and PostgreSQL commit-fence service suites, route
contract tests, and the CLI run-loop test that catches up a backlog, passes the
tail into generation, posts/acks once, and avoids a second spawn on redelivery.
