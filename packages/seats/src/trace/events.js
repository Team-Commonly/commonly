/**
 * Trace event vocabulary. Names follow ACP's session/update kinds where one
 * exists, so an ACP agent's stream maps across without a translation table.
 *
 * Event: { runId, seq, ts, type, data }, plus the record envelope (kind, v,
 * actor, prev, taskId?, podId?) when read back from the store; the on-disk
 * format is docs/record-v1.md. `seq` is per run, starting at 1; `ts` is
 * an ISO string. Events never carry prompt text, credentials or
 * environment values — only names, ids, sizes and the agent's own output.
 */
export const EVENT_TYPES = Object.freeze([
  'run.started', // { adapter, cli: {name, version}?, sessionId?, attempt }
  'run.settled', // { outcome: 'ok'|'failed'|'stuck'|'cancelled', failure?: {kind, detail}, durationMs, attempts }
  'turn.prompt_sent', // { chars }
  'agent.message_chunk', // { text }
  'agent.thought_chunk', // { chars }  thoughts are counted, not stored
  'tool.call', // { toolCallId, title, kind?, status?, name?, surface?, argsDigest? }
  'tool.update', // { toolCallId, status?, title? }
  'plan', // { entries: [{content, status}] }
  'permission.requested', // { toolCallId?, options: [{optionId, kind}], question, askedOf: {id, role}, grantId?, decisionCardId?, argsDigest? }
  'permission.decided', // { outcome: 'selected'|'cancelled', optionId?, kind?, toolCallId?, rule?: {list, pattern}, approval? }
  'usage', // { inputTokens?, outputTokens?, totalTokens?, cost? }  null-not-zero when unknown
  'liveness.stalled', // { idleMs, windowMs }
  'liveness.recovery', // { action: 'cancel'|'kill'|'retry', attempt }
  'credential.granted', // { names: [...] }  names only, never values
  'credential.denied', // { name, reason?: 'not_granted'|'unresolved' }
  'sandbox.applied', // { sandbox: 'seatbelt'|'bwrap'|'none', reason? }  reason only when none
  'egress.allowed', // { host, port }  a proxy tunnel opened; never headers, bodies or addresses
  'egress.denied', // { host, port, reason }  host/port null when unparseable; reason in EGRESS_DENIAL_REASONS
  'process.exited', // { code, signal }
  // Record kinds with no earlier trace name (docs/record-v1.md has the full data).
  'task.claimed', // { leaseUntil? }  mirrors the board's claim; the board stays the source of truth
  'task.released', // { reason? }
  'task.done', // { doneBy? }  written for the board; ends grants bound to the task
  'grant.issued', // { grantId, parentGrantId?, scope: {connectionId?, tools: [names], writeMode?, budget?, audience}, target?, issuedBy?, expiresAt?, binding? }
  'grant.revoked', // { grantIds: [...], reason: 'task.done'|'expired'|'cascade'|'manual' }
  'attempt.settled', // { attempt, outcome, failure?: {kind, detail} }
  'decision.ruled', // { decisionCardId, value, decidedBy, decidedByRole }  a card ruling not tied to a parked tool call
  'result.reported', // { status: 'done'|'partial'|'blocked'|'failed', refs?: [{type, id}] }
]);

const KNOWN = new Set(EVENT_TYPES);
export const isEventType = (type) => KNOWN.has(type);

/** The trace hook an adapter receives as ctx.trace. Absent hook → no-op. */
export const NULL_TRACE = Object.freeze({ emit() {} });
export const traceOf = (ctx) => (ctx && ctx.trace && typeof ctx.trace.emit === 'function' ? ctx.trace : NULL_TRACE);
