# Run traces

TASK-499 adds a read-only link from a native hosted agent's message to its
`AgentRun`, including the referenced PostgreSQL `tool_calls` audit records.

## Contract

- Message `payload.runId` is a server-owned Mongo ObjectId string. The native
  runtime passes the internal `runId` option to `AgentMessageService`, which
  removes any authored `payload.runId` before stamping the real identity.
- Existing payload fields remain intact. Plain text messages may carry just
  `{runId}`. Native hosted/local offers carry it alongside their kernel card.
  Native approval proposals persist it on `ApprovalAction`, so resolving the
  card does not remove its trace link.
- External CLI turns have no `AgentRun` today. Do not invent a run identity for
  them. A missing runId means no trace link; it does not mean no tools ran.
- `V2RunTraceLink({podId, runId})` derives
  `/v2/pods/:podId/runs/:runId`, never an agent-authored URL. It validates both
  IDs before rendering. TASK-498 can reuse this component.
- `GET /api/pods/:podId/runs/:runId` requires human authentication and the same
  current pod-read access as the existing grant trail (`DMService.canViewPod`).
  Wrong pod/run combinations, malformed IDs and denied access return 404.
  Knowledge of a run ID or the public pod listing grants no access.
- Reads are limited to 120 per minute per IP using the shared Cloudflare-aware
  key, before authentication or database access.
- The response is `{run, retention}`. `run.turns[].toolCalls[]` holds name,
  duration, outcome, optional callId, and `trail` with grantId and the credential
  owner's ID. A RunTrace last-N renderer can flatten these calls and slice the
  last 1–5. The server joins **only** recorded callIds in the authorized pod.
  A missing broker record is `outcome:'unavailable', trail:null`. No raw tool
  arguments, results, LLM text, error prose or argument digests are returned.
- An unavailable PostgreSQL read returns 503, not a successful empty audit.
  Responses use `Cache-Control: no-store`. The view supports retry and explicit
  refresh for a running trace; it does not claim to stream live turns.

## Storage bounds

Every `AgentRun` document save validates a bounded trace: 4,096 serialized UTF-8
bytes and 256 JSON nodes per args/result value, 4,096 characters of LLM response
text per turn, 128 stored turns, 64 stored tool calls per turn, and a 2 MiB BSON
budget for the stored turns. Oversized args/results become a truncation marker
with their original byte count, not a prefix of potentially secret content.
Call names/IDs/errors and run error text are capped too. `traceTruncated`,
`omittedTurns` and `omittedToolCalls` disclose lossy storage. The loop's real
`totalTokens` remains the aggregate; a truncated trace is not a complete replay.

The save hook covers native run creation/final persistence. Existing atomic
updates only change status/error fields; future writers must not bypass the
hook with a direct `$push` of unbounded turns. No historical backfill is run.

## Retention

Message/card retention defaults to 30 days, with configurable retention,
Pro-protected pods and disk-pressure step-down exceptions. The UI says
**30-day default**, not an exact per-card expiry promise. Neither `AgentRun` nor
`tool_calls` has the message retention job's TTL. The trace URL remains readable
without looking up the original message, including after that message expires.
Pod deletion, synthetic-account purge and loss of pod access still apply;
“persists” does not override deletion or authorization.

## Proof

The focused route suite uses real Mongo and pg-mem. A separate service suite
runs the new query on real Postgres, covering cross-pod IDs and superseded
approval outcomes. Message-service and native-runtime tests cover stored/socket
provenance. UI tests cover valid links, retry, retention and incomplete trails.
Real browser checks use the production components with fixture API responses
at 390/1440 in English/Chinese; they are layout proof, not a production walk.


Connector approval cards may be posted into the credential owner's private room.
Their server-bound `payload.runPodId` preserves the originating run's pod beside
`runId`, so the link uses the original trace route. Both client payload fields
are stripped by the writer; hosted runtime context supplies them separately.
ApprovalAction persists both through decisions. Reading still requires access
to the original pod; receiving the approval card grants no trace access.
