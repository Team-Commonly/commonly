/**
 * Export run records as OTLP/JSON traces (an ExportTraceServiceRequest), so
 * a tracing backend can show who let which agent do what beside its own
 * spans. docs/record-v1.md §5 is the mapping; the gen_ai.* names follow the
 * OpenTelemetry GenAI conventions, which are Development status upstream.
 *
 * Ids are derived, never random: the same entries export to the same bytes.
 */
import { createHash } from 'node:crypto';
import { KINDS, RECORD_SCHEMA, RECORD_VERSION } from './format.js';

const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;
const FAILED_OUTCOMES = new Set(['failed', 'stuck', 'cancelled']);
// Content stays out of the export, as upstream makes content capture opt-in.
const CONTENT_KINDS = new Set(['agent.message_chunk', 'agent.thought_chunk']);

const digest = (text, bytes) => {
  const hex = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, bytes * 2);
  // An all-zero id is invalid in OTLP; vanishingly unlikely, cheap to exclude.
  return /^0+$/.test(hex) ? digest(`${text}#`, bytes) : hex;
};

/** 16-byte trace id per task (task ids repeat across pods, so the pod is in it), else per run. */
export const traceIdOf = (entry) => digest(entry.taskId
  ? `seats.record/trace/task/${entry.podId}/${entry.taskId}`
  : `seats.record/trace/run/${entry.runId}`, 16);
/** 8-byte span id for the span an entry opens; the run span uses seq 0. */
export const spanIdOf = (runId, seq) => digest(`seats.record/span/${runId}/${seq}`, 8);

/** RFC 3339 → Unix nanoseconds as a decimal string, keeping sub-millisecond digits. */
const nanos = (ts) => {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(ts);
  if (!match) return '0';
  return String(BigInt(Date.parse(`${match[1]}Z`)) * 1000000n + BigInt((match[2] || '').padEnd(9, '0')));
};

const snake = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

const anyValue = (value) => {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.filter((v) => v !== null && v !== undefined).map(anyValue) } };
  return {
    kvlistValue: {
      values: Object.keys(value).filter((k) => value[k] !== null && value[k] !== undefined).sort()
        .map((k) => ({ key: snake(k), value: anyValue(value[k]) })),
    },
  };
};
const attr = (key, value) => ({ key, value: anyValue(value) });
const attrs = (pairs) => pairs.filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => attr(key, value));

/** Nested data → `seats.<path>` attributes, keys sorted for a stable export. */
const flatten = (data, prefix = 'seats') => Object.keys(data || {}).sort().flatMap((key) => {
  const value = data[key];
  const name = `${prefix}.${snake(key)}`;
  if (value === null || value === undefined) return [];
  if (typeof value === 'object' && !Array.isArray(value)) return flatten(value, name);
  return [attr(name, value)];
});

const eventOf = (entry) => ({
  timeUnixNano: nanos(entry.ts),
  name: entry.kind,
  attributes: [
    attr('seats.seq', entry.seq),
    ...(entry.actor ? attrs([
      ['seats.actor.type', entry.actor.type], ['seats.actor.id', entry.actor.id],
      ['seats.actor.owner', entry.actor.owner], ['seats.actor.name', entry.actor.name],
      ['seats.actor.on_behalf_of.id', entry.actor.onBehalfOf?.id], ['seats.actor.on_behalf_of.role', entry.actor.onBehalfOf?.role],
    ]) : []),
    ...flatten(entry.data),
  ],
});

const fail = (span, errorType) => {
  span.status = { code: STATUS_ERROR, message: errorType };
  span.attributes.push(attr('error.type', errorType));
};

/** One run's entries, in seq order → its spans. */
const spansOfRun = (entries) => {
  const head = entries[0];
  const traceId = traceIdOf(head);
  const last = entries[entries.length - 1];
  const span = ({ seq, parent, name, attributes, start }) => ({
    traceId,
    spanId: spanIdOf(head.runId, seq),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    name,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: null,
    attributes,
    events: [],
    status: { code: STATUS_UNSET },
  });
  const run = span({
    seq: 0,
    name: 'seats.run',
    start: head.ts,
    attributes: attrs([['seats.run.id', head.runId], ['seats.task.id', head.taskId], ['seats.pod.id', head.podId]]),
  });
  const spans = [run];
  let attempt = null; // { span, number, tools: Map<toolCallId, span>, usage, context, sessionId }
  const cards = new Map(); // decisionCardId → the span its request sits on
  const end = (s, ts) => { if (s && s.endTimeUnixNano === null) s.endTimeUnixNano = nanos(ts); };
  const closeAttempt = (ts) => {
    if (!attempt) return;
    for (const tool of attempt.tools.values()) end(tool, ts);
    if (attempt.usage) {
      attempt.span.attributes.push(...attrs([
        ['gen_ai.usage.input_tokens', attempt.usage.inputTokens], ['gen_ai.usage.output_tokens', attempt.usage.outputTokens],
      ]));
    }
    attempt.span.attributes.push(...attrs([
      ['seats.usage.context_tokens', attempt.context.tokens], ['seats.usage.context_size', attempt.context.size],
    ]));
    // The session an attempt opened names the conversation when attempt.started did not.
    if (attempt.sessionId && !attempt.span.attributes.some((a) => a.key === 'gen_ai.conversation.id')) {
      attempt.span.attributes.push(attr('gen_ai.conversation.id', attempt.sessionId));
    }
    end(attempt.span, ts);
    attempt = null;
  };
  const current = () => attempt?.span || run;

  for (const entry of entries) {
    const { kind, data = {} } = entry;
    if (!Object.hasOwn(KINDS, kind) || CONTENT_KINDS.has(kind)) continue; // unknown kinds are skipped
    if (kind === 'attempt.started') {
      closeAttempt(entry.ts);
      const agentName = entry.actor?.name || entry.actor?.id;
      const s = span({
        seq: entry.seq,
        parent: run,
        name: agentName ? `invoke_agent ${agentName}` : 'invoke_agent',
        start: entry.ts,
        attributes: attrs([
          ['gen_ai.operation.name', 'invoke_agent'],
          ['gen_ai.agent.id', entry.actor?.id], ['gen_ai.agent.name', agentName],
          ['gen_ai.conversation.id', data.sessionId],
          ['seats.agent.owner', entry.actor?.owner],
          ['seats.agent.on_behalf_of.id', entry.actor?.onBehalfOf?.id], ['seats.agent.on_behalf_of.role', entry.actor?.onBehalfOf?.role],
          ['seats.attempt.number', data.attempt], ['seats.adapter', data.adapter],
          ['seats.cli.name', data.cli?.name], ['seats.cli.version', data.cli?.version],
        ]),
      });
      spans.push(s);
      attempt = {
        span: s, number: data.attempt, agentName, tools: new Map(), usage: null, context: { tokens: null, size: null }, sessionId: null,
      };
    } else if (kind === 'attempt.settled' && attempt && attempt.number === data.attempt) {
      attempt.span.attributes.push(attr('seats.attempt.outcome', data.outcome));
      if (FAILED_OUTCOMES.has(data.outcome)) fail(attempt.span, data.failure?.kind || data.outcome);
      closeAttempt(entry.ts);
    } else if (kind === 'run.settled') {
      run.attributes.push(...attrs([['seats.run.outcome', data.outcome], ['seats.run.attempts', data.attempts]]));
      if (FAILED_OUTCOMES.has(data.outcome)) {
        const errorType = data.failure?.kind || data.outcome;
        fail(run, errorType);
        // The run's outcome is the last attempt's when nothing settled it.
        if (attempt) fail(attempt.span, errorType);
      }
      closeAttempt(entry.ts);
      end(run, entry.ts);
    } else if (kind === 'tool.call') {
      const toolName = data.name || data.title || 'tool';
      const s = span({
        seq: entry.seq,
        parent: current(),
        name: `execute_tool ${toolName}`,
        start: entry.ts,
        attributes: attrs([
          ['gen_ai.operation.name', 'execute_tool'],
          ['gen_ai.tool.name', toolName], ['gen_ai.tool.call.id', data.toolCallId],
          ['gen_ai.agent.name', attempt?.agentName],
          ['seats.actor.on_behalf_of.id', entry.actor?.onBehalfOf?.id], ['seats.actor.on_behalf_of.role', entry.actor?.onBehalfOf?.role],
          ['seats.tool.kind', data.kind], ['seats.tool.surface', data.surface], ['seats.tool.args_digest', data.argsDigest],
        ]),
      });
      spans.push(s);
      if (attempt && data.toolCallId) attempt.tools.set(data.toolCallId, s);
    } else if (kind === 'tool.update') {
      const tool = attempt?.tools.get(data.toolCallId);
      (tool || current()).events.push(eventOf(entry));
      if (tool && data.status === 'failed') fail(tool, 'tool_failed');
      if (tool && (data.status === 'completed' || data.status === 'failed')) end(tool, entry.ts);
    } else if (kind === 'usage' && attempt) {
      attempt.usage = data;
      // Context fill comes from the stream's usage updates; a later entry without it keeps the last known.
      if (Number.isInteger(data.contextTokens)) attempt.context.tokens = data.contextTokens;
      if (Number.isInteger(data.contextSize)) attempt.context.size = data.contextSize;
      attempt.span.events.push(eventOf(entry));
    } else if (kind === 'permission.requested' || kind === 'permission.decided') {
      const target = attempt?.tools.get(data.toolCallId) || current();
      target.events.push(eventOf(entry));
      if (data.decisionCardId && !cards.has(data.decisionCardId)) cards.set(data.decisionCardId, target);
    } else if (kind === 'session.opened') {
      if (attempt && typeof data.sessionId === 'string') attempt.sessionId = data.sessionId;
      current().events.push(eventOf(entry));
    } else if (kind === 'decision.ruled') {
      // A ruling on a card that a request rode on joins that request; any other is an event where it happened.
      (cards.get(data.decisionCardId) || current()).events.push(eventOf(entry));
    } else {
      current().events.push(eventOf(entry));
    }
  }
  closeAttempt(last.ts);
  end(run, last.ts);
  return spans;
};

/**
 * toOtlpJson(entries, { serviceName? }) → ExportTraceServiceRequest (OTLP/JSON)
 *
 * `entries` are record entries (readRun's output, or parsed lines) from one
 * or more runs. Entries of another schema or a newer version are left out.
 */
export const toOtlpJson = (entries, { serviceName = 'seats' } = {}) => {
  const runs = new Map();
  for (const entry of entries || []) {
    if (!entry || entry.schema !== RECORD_SCHEMA || !(entry.v <= RECORD_VERSION)) continue;
    if (!runs.has(entry.runId)) runs.set(entry.runId, []);
    runs.get(entry.runId).push(entry);
  }
  const spans = [...runs.values()].flatMap((run) => spansOfRun([...run].sort((a, b) => a.seq - b.seq)));
  return {
    resourceSpans: [{
      resource: { attributes: [attr('service.name', serviceName)] },
      scopeSpans: [{ scope: { name: RECORD_SCHEMA, version: String(RECORD_VERSION) }, spans }],
    }],
  };
};
