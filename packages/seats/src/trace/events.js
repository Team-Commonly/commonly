/**
 * Trace event vocabulary. Names follow ACP's session/update kinds where one
 * exists, so an ACP agent's stream maps across without a translation table.
 *
 * Event: { runId, seq, ts, type, data }. `seq` is per run, starting at 1;
 * `ts` is an ISO string. Events never carry prompt text, credentials or
 * environment values — only names, ids, sizes and the agent's own output.
 */
export const EVENT_TYPES = Object.freeze([
  'run.started', // { adapter, cli: {name, version}?, sessionId?, attempt }
  'run.settled', // { outcome: 'ok'|'failed'|'stuck'|'cancelled', failure?: {kind, detail}, durationMs, attempts }
  'turn.prompt_sent', // { chars }
  'agent.message_chunk', // { text }
  'agent.thought_chunk', // { chars }  thoughts are counted, not stored
  'tool.call', // { toolCallId, title, kind?, status? }
  'tool.update', // { toolCallId, status?, title? }
  'plan', // { entries: [{content, status}] }
  'permission.requested', // { toolCallId?, options: [{optionId, kind}] }
  'permission.decided', // { outcome: 'selected'|'cancelled', optionId?, kind? }
  'usage', // { inputTokens?, outputTokens?, totalTokens?, cost? }  null-not-zero when unknown
  'liveness.stalled', // { idleMs, windowMs }
  'liveness.recovery', // { action: 'cancel'|'kill'|'retry', attempt }
  'credential.granted', // { names: [...] }  names only, never values
  'credential.denied', // { name }
  'process.exited', // { code, signal }
]);

const KNOWN = new Set(EVENT_TYPES);
export const isEventType = (type) => KNOWN.has(type);

/** The trace hook an adapter receives as ctx.trace. Absent hook → no-op. */
export const NULL_TRACE = Object.freeze({ emit() {} });
export const traceOf = (ctx) => (ctx && ctx.trace && typeof ctx.trace.emit === 'function' ? ctx.trace : NULL_TRACE);
