/**
 * The run record, format v1: one canonical JSON object per line, each line
 * hash-chained to the one before it. docs/record-v1.md is the specification;
 * this file is its reference writer and verifier, and nothing here imports
 * the store, so another tool can vendor it alone.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { FAILURE_KINDS } from '../failures.js';

export const RECORD_VERSION = 1;
export const RECORD_SCHEMA = 'seats.record';

export const ACTOR_TYPES = Object.freeze(['agent', 'human', 'policy', 'system']);
// Who decides an approval today is the owner of the credential it would use;
// `decision-owner` is reserved for a separately assigned decider.
export const DECIDED_BY_ROLES = Object.freeze(['credential-owner', 'decision-owner', 'agent-owner', 'policy']);
export const TOOL_SURFACES = Object.freeze(['connector', 'commonly', 'native']);
export const GRANT_ENDS_ON = Object.freeze(['task.done', 'expiresAt']);
export const REVOKE_REASONS = Object.freeze(['task.done', 'expired', 'cascade', 'manual']);
export const WRITE_MODES = Object.freeze(['read', 'write', 'write-with-confirm']);
export const GRANT_TARGET_KINDS = Object.freeze(['pod', 'seat']);
export const OUTCOMES = Object.freeze(['ok', 'failed', 'stuck', 'cancelled']);
export const RESULT_STATUSES = Object.freeze(['done', 'partial', 'blocked', 'failed']);
// Whose request an agent acts on: 'requester' sent the message that started
// the run, 'assigner' assigned its task. Absent when no human asked.
export const ON_BEHALF_ROLES = Object.freeze(['requester', 'assigner']);
// Why the egress proxy refused a request. The first two can leave host and port null.
export const EGRESS_DENIED_REASONS = Object.freeze([
  'bad_request', 'not_connect', 'ip_literal', 'not_allowed', 'unresolved', 'private_address', 'unreachable',
]);
const EGRESS_TARGETLESS = new Set(['bad_request', 'not_connect']);
export const SANDBOXES = Object.freeze(['seatbelt', 'bwrap', 'none']);
export const SESSION_METHODS = Object.freeze(['new', 'resume', 'load']);
// Why a requested session was not reopened: the two forms an ACP adapter
// writes. The code is the JSON-RPC error's, an integer by JSON-RPC 2.0.
const SESSION_FALLBACK = /^(?:agent supports neither session\/resume nor session\/load|session\/(?:resume|load) answered error -?\d{1,16})$/;
export const REDACTED = '[redacted]';

/** The actors a writer records for its own bookkeeping, and for the board. */
export const SYSTEM_ACTOR = Object.freeze({ type: 'system', id: 'seats' });
export const BOARD_ACTOR = Object.freeze({ type: 'system', id: 'board' });

/**
 * Every v1 kind. `actor` is who a writer records when the emitter names
 * nobody: 'run' (the run's own actor), 'system', or derived from the data
 * ('issuer', 'decider'). `trace` is the EVENT_TYPES name, when it differs.
 */
export const KINDS = Object.freeze({
  'task.claimed': Object.freeze({ group: 'claim', actor: 'run' }),
  'task.released': Object.freeze({ group: 'claim', actor: 'run' }),
  'task.done': Object.freeze({ group: 'claim', actor: 'board' }),
  'grant.issued': Object.freeze({ group: 'grant', actor: 'issuer' }),
  'grant.revoked': Object.freeze({ group: 'grant', actor: 'system' }),
  'permission.requested': Object.freeze({ group: 'approval', actor: 'run' }),
  'permission.decided': Object.freeze({ group: 'approval', actor: 'decider' }),
  'decision.ruled': Object.freeze({ group: 'approval', actor: 'decider' }),
  'attempt.started': Object.freeze({ group: 'attempt', actor: 'run', trace: 'run.started' }),
  'session.opened': Object.freeze({ group: 'attempt', actor: 'system' }),
  'attempt.settled': Object.freeze({ group: 'attempt', actor: 'system' }),
  'run.settled': Object.freeze({ group: 'attempt', actor: 'system' }),
  'tool.call': Object.freeze({ group: 'tool', actor: 'run' }),
  'tool.update': Object.freeze({ group: 'tool', actor: 'run' }),
  'credential.granted': Object.freeze({ group: 'credential', actor: 'system' }),
  'credential.denied': Object.freeze({ group: 'credential', actor: 'system' }),
  'result.reported': Object.freeze({ group: 'result', actor: 'run' }),
  'turn.prompt_sent': Object.freeze({ group: 'activity', actor: 'system' }),
  'agent.message_chunk': Object.freeze({ group: 'activity', actor: 'run' }),
  'agent.thought_chunk': Object.freeze({ group: 'activity', actor: 'run' }),
  plan: Object.freeze({ group: 'activity', actor: 'run' }),
  usage: Object.freeze({ group: 'activity', actor: 'run' }),
  'liveness.stalled': Object.freeze({ group: 'activity', actor: 'system' }),
  'liveness.recovery': Object.freeze({ group: 'activity', actor: 'system' }),
  'process.exited': Object.freeze({ group: 'activity', actor: 'system' }),
  // The supervisor's provider-relay verdicts (wire/provider-relay.js): never text.
  'provider.relay': Object.freeze({ group: 'activity', actor: 'system' }),
  'provider.refusal': Object.freeze({ group: 'activity', actor: 'system' }),
  // The run's confinement, recorded once per spawn, beside its egress.
  'sandbox.applied': Object.freeze({ group: 'sandbox', actor: 'system' }),
  'egress.allowed': Object.freeze({ group: 'egress', actor: 'system' }),
  'egress.denied': Object.freeze({ group: 'egress', actor: 'system' }),
});

const TRACE_TO_KIND = new Map(Object.entries(KINDS).filter(([, spec]) => spec.trace).map(([kind, spec]) => [spec.trace, kind]));

/** Record kind for an EVENT_TYPES name or a kind; null when it is neither. */
export const kindOfType = (type) => TRACE_TO_KIND.get(type) || (Object.hasOwn(KINDS, type) ? type : null);
/** The EVENT_TYPES name readRun reports for a kind (unknown kinds pass through). */
export const traceTypeOf = (kind) => KINDS[kind]?.trace || kind;

const fail = (message) => { throw new Error(`record: ${message}`); };
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RUN_ID = /^[A-Za-z0-9_-]{6,64}$/;
// A user id is an opaque token from the instance: no spaces, so a display
// name can't pass for one. Display names go in actor.name.
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const isUserId = (value) => typeof value === 'string' && USER_ID.test(value);
const TOOL_NAME = /^[^\s*?]{1,256}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const KIND_SHAPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const isTimestamp = (value) => typeof value === 'string' && RFC3339_UTC.test(value) && !Number.isNaN(Date.parse(value));

/**
 * RFC 8785 (JCS) serialization. For the JSON values a record holds, JCS is
 * JSON.stringify with object keys sorted by UTF-16 code units, which is what
 * Array.prototype.sort does by default.
 *
 * `strict` also refuses a lone surrogate in any string or key, as RFC 8785
 * requires. Lines are not strict: agent text from a stream cut mid-pair must
 * still record, and JSON.stringify writes the lone half as a \u escape.
 */
const canonicalString = (text, strict) => {
  if (strict && !text.isWellFormed()) fail('strings must be well-formed UTF-16 (no lone surrogates)');
  return JSON.stringify(text);
};
const canonical = (value, strict = false) => {
  if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') return canonical(value.toJSON(), strict);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return canonicalString(value, strict);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) fail('numbers must be finite');
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonical(item, strict))).join(',')}]`;
      return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
        .map((key) => `${canonicalString(key, strict)}:${canonical(value[key], strict)}`).join(',')}}`;
    default: return fail(`cannot serialize a ${typeof value}`);
  }
};

/** The canonical line for an entry, without its trailing newline. */
export const canonicalLine = (entry) => {
  if (!isPlainObject(entry)) fail('an entry is a JSON object');
  return canonical(entry);
};

/** Lowercase hex SHA-256 over a line's UTF-8 bytes: what the next `prev` holds. */
export const hashLine = (line) => createHash('sha256').update(String(line), 'utf8').digest('hex');

/**
 * A tool call's arguments as a digest, never the values: `sha256:` + the
 * lowercase hex SHA-256 of the arguments' RFC 8785 form. The same arguments
 * give the same digest wherever they are seen, so a reader can match a
 * tool.call to the permission entries that approved it. Returns undefined
 * when there are no arguments, or they are not JSON (a function, NaN, a
 * string or key holding a lone surrogate): a writer then omits argsDigest.
 */
const ARGS_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const argsDigestOf = (args) => {
  if (args === undefined) return undefined;
  try { return `sha256:${hashLine(canonical(args, true))}`; } catch { return undefined; }
};
export const isArgsDigest = (value) => typeof value === 'string' && ARGS_DIGEST.test(value);

/** null when the actor is well formed, else the reason. */
const actorProblem = (actor) => {
  if (actor === null) return null;
  if (!isPlainObject(actor)) return 'actor must be an object or null';
  if (!ACTOR_TYPES.includes(actor.type)) return `actor.type must be one of ${ACTOR_TYPES.join(', ')}`;
  if (!isUserId(actor.id)) return 'actor.id must be an id token (a user id for agent and human actors), never a display name';
  if (actor.owner !== undefined && (actor.type !== 'agent' || !isUserId(actor.owner))) return 'actor.owner is a user id, on agent actors only';
  if (actor.name !== undefined && !isText(actor.name)) return 'actor.name must be a non-empty string';
  if (actor.onBehalfOf !== undefined) {
    const behalf = actor.onBehalfOf;
    if (actor.type !== 'agent') return 'actor.onBehalfOf is on agent actors only';
    if (!isPlainObject(behalf)) return 'actor.onBehalfOf must be {id, role}';
    const extra = Object.keys(behalf).find((key) => key !== 'id' && key !== 'role');
    if (extra !== undefined) return `unknown field actor.onBehalfOf.${extra}`;
    if (!isUserId(behalf.id)) return 'actor.onBehalfOf.id must be an id token (a user id), never a display name';
    if (!ON_BEHALF_ROLES.includes(behalf.role)) return `actor.onBehalfOf.role must be one of ${ON_BEHALF_ROLES.join(', ')}`;
  }
  return null;
};

export const validateActor = (actor) => {
  const problem = actorProblem(actor);
  if (problem) fail(problem);
  if (actor === null) return null;
  return Object.freeze({
    type: actor.type,
    id: actor.id,
    ...(actor.owner ? { owner: actor.owner } : {}),
    ...(actor.onBehalfOf ? { onBehalfOf: Object.freeze({ id: actor.onBehalfOf.id, role: actor.onBehalfOf.role }) } : {}),
    ...(actor.name ? { name: actor.name } : {}),
  });
};

const refuseUnknownKeys = (value, allowed, where) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown field ${where}${key}`);
};
const envNames = (names, where) => {
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string' && ENV_NAME.test(name))) {
    fail(`${where} must be credential NAMES ([A-Z_][A-Z0-9_]*), never values`);
  }
  return [...names];
};
const optionalText = (value, where) => {
  if (value !== undefined && value !== null && !isText(value)) fail(`${where} must be a non-empty string`);
};
const userIdOrPolicy = (value, where) => {
  if (value !== undefined && value !== null && value !== 'policy' && !isUserId(value)) fail(`${where} must be a user id or "policy"`);
};
// Only the digest form: raw arguments would carry values.
const optionalArgsDigest = (data, kind) => {
  if (data.argsDigest !== undefined && !isArgsDigest(data.argsDigest)) fail(`${kind}.argsDigest must be sha256:<64 hex>, a digest of the arguments, never the arguments`);
};
// A host as the egress proxy traces it: a lowercase DNS name, an IP literal
// (IPv6 without brackets), or [redacted] when it held a run credential.
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const isEgressHost = (host) => typeof host === 'string' && (host === REDACTED || isIP(host) !== 0
  || (host.length <= 253 && host.split('.').every((label) => DNS_LABEL.test(label))));
const isPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;
const checkEgressTarget = (data, kind, { nullable }) => {
  if (data.host === null && data.port === null && nullable) return;
  if (data.host === null || data.port === null) {
    fail(nullable ? `${kind}: host and port are null together, or both set` : `${kind} needs a host and a port`);
  }
  if (!isEgressHost(data.host)) fail(`${kind}.host must be a lowercase DNS name, an IP literal or "${REDACTED}"`);
  if (!isPort(data.port)) fail(`${kind}.port must be an integer from 1 to 65535`);
};

const checkRole = (role, where) => {
  if (!DECIDED_BY_ROLES.includes(role)) fail(`${where} must be one of ${DECIDED_BY_ROLES.join(', ')}`);
};

/** A grant's scope, in the shape of a room grant: exact tool names and a connection id. */
const checkScope = (scope) => {
  if (!isPlainObject(scope)) fail('grant.issued needs a scope');
  refuseUnknownKeys(scope, ['connectionId', 'tools', 'writeMode', 'budget', 'audience'], 'grant.issued.scope.');
  optionalText(scope.connectionId, 'grant.issued.scope.connectionId');
  const tools = scope.tools ?? [];
  if (!Array.isArray(tools) || !tools.every((name) => typeof name === 'string' && TOOL_NAME.test(name))) {
    fail('grant.issued.scope.tools must be exact tool names (no spaces, no * or ?), not patterns');
  }
  if (scope.writeMode !== undefined && !WRITE_MODES.includes(scope.writeMode)) fail(`grant.issued.scope.writeMode must be one of ${WRITE_MODES.join(', ')}`);
  let budget;
  if (scope.budget !== undefined) {
    if (!isPlainObject(scope.budget)) fail('grant.issued.scope.budget must be an object');
    refuseUnknownKeys(scope.budget, ['calls', 'windowMs'], 'grant.issued.scope.budget.');
    if (scope.budget.calls !== undefined && !(Number.isInteger(scope.budget.calls) && scope.budget.calls >= 0)) fail('grant.issued.scope.budget.calls must be an integer >= 0');
    if (scope.budget.windowMs !== undefined && !(Number.isInteger(scope.budget.windowMs) && scope.budget.windowMs >= 1)) fail('grant.issued.scope.budget.windowMs must be an integer >= 1');
    budget = { ...scope.budget };
  }
  const audience = scope.audience ?? [];
  if (!Array.isArray(audience) || !audience.every(isUserId)) fail('grant.issued.scope.audience must be user ids');
  return {
    ...(scope.connectionId ? { connectionId: scope.connectionId } : {}),
    tools: [...tools],
    ...(scope.writeMode ? { writeMode: scope.writeMode } : {}),
    ...(budget ? { budget } : {}),
    audience: [...audience],
  };
};

// Per-kind checks, applied by every writer. They are strictest where a value
// could ride in: a grant's scope, target and binding refuse fields they don't define.
const CHECKS = {
  'grant.issued': (data, envelope) => {
    refuseUnknownKeys(data, ['grantId', 'parentGrantId', 'scope', 'target', 'issuedBy', 'expiresAt', 'binding'], 'grant.issued.');
    if (!isText(data.grantId)) fail('grant.issued needs a grantId');
    optionalText(data.parentGrantId, 'grant.issued.parentGrantId');
    const scope = checkScope(data.scope);
    let target;
    if (data.target !== undefined) {
      if (!isPlainObject(data.target)) fail('grant.issued.target must be an object');
      refuseUnknownKeys(data.target, ['kind', 'id'], 'grant.issued.target.');
      if (!GRANT_TARGET_KINDS.includes(data.target.kind) || !isText(data.target.id)) fail('grant.issued.target is {kind: pod|seat, id}');
      target = { kind: data.target.kind, id: data.target.id };
    }
    userIdOrPolicy(data.issuedBy, 'grant.issued.issuedBy');
    if (data.expiresAt !== undefined && !isTimestamp(data.expiresAt)) fail('grant.issued.expiresAt must be an RFC 3339 UTC timestamp');
    let binding;
    if (data.binding !== undefined) {
      if (!isPlainObject(data.binding)) fail('grant.issued.binding must be an object');
      refuseUnknownKeys(data.binding, ['taskId', 'podId', 'endsOn'], 'grant.issued.binding.');
      if (!isText(data.binding.taskId) || !isText(data.binding.podId)) fail('grant.issued.binding needs taskId and podId: task ids repeat across pods');
      if (data.binding.taskId !== envelope.taskId || data.binding.podId !== envelope.podId) fail('grant.issued.binding must name the run\'s own taskId and podId');
      if (!GRANT_ENDS_ON.includes(data.binding.endsOn)) fail(`grant.issued.binding.endsOn must be one of ${GRANT_ENDS_ON.join(', ')}`);
      if (data.binding.endsOn === 'expiresAt' && data.expiresAt === undefined) fail('a grant that ends on expiresAt needs an expiresAt');
      binding = { taskId: data.binding.taskId, podId: data.binding.podId, endsOn: data.binding.endsOn };
    }
    return {
      ...data,
      ...(data.parentGrantId === undefined ? {} : { parentGrantId: data.parentGrantId }),
      scope,
      ...(target ? { target } : {}),
      ...(binding ? { binding } : {}),
    };
  },
  'grant.revoked': (data) => {
    if (!Array.isArray(data.grantIds) || data.grantIds.length === 0 || !data.grantIds.every(isText)) fail('grant.revoked needs grantIds: a non-empty array');
    if (new Set(data.grantIds).size !== data.grantIds.length) fail('grant.revoked.grantIds repeats an id');
    if (!REVOKE_REASONS.includes(data.reason)) fail(`grant.revoked.reason must be one of ${REVOKE_REASONS.join(', ')}`);
    return { ...data, grantIds: [...data.grantIds] };
  },
  'task.done': (data, envelope) => {
    if (!envelope.taskId) fail('task.done needs a run with a taskId');
    userIdOrPolicy(data.doneBy, 'task.done.doneBy');
    return data;
  },
  'permission.requested': (data) => {
    if (!isText(data.question)) fail('permission.requested needs a question: the human-readable ask');
    if (!isPlainObject(data.askedOf)) fail('permission.requested needs askedOf: {id, role}');
    refuseUnknownKeys(data.askedOf, ['id', 'role'], 'permission.requested.askedOf.');
    if (!isUserId(data.askedOf.id)) fail('permission.requested.askedOf.id must be an id token, never a display name');
    checkRole(data.askedOf.role, 'permission.requested.askedOf.role');
    optionalText(data.grantId, 'permission.requested.grantId');
    optionalText(data.decisionCardId, 'permission.requested.decisionCardId');
    optionalArgsDigest(data, 'permission.requested');
    return { ...data, askedOf: { id: data.askedOf.id, role: data.askedOf.role } };
  },
  'decision.ruled': (data) => {
    if (!isText(data.decisionCardId)) fail('decision.ruled needs a decisionCardId');
    const { value } = data;
    if (!(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
      fail('decision.ruled.value must be a string, number or boolean');
    }
    if (data.decidedBy !== 'policy' && !isUserId(data.decidedBy)) fail('decision.ruled.decidedBy must be a user id or "policy"');
    checkRole(data.decidedByRole, 'decision.ruled.decidedByRole');
    return data;
  },
  'permission.decided': (data) => {
    optionalArgsDigest(data, 'permission.decided');
    // A rule-decided call never had a person in the loop; a writer says so
    // rather than leave a reader to infer it from rule.list.
    const out = { ...data };
    if (!('decidedBy' in out)) {
      const byRule = out.rule && out.rule.list !== 'ask';
      out.decidedBy = byRule ? 'policy' : null;
      if (!('decidedByRole' in out)) out.decidedByRole = byRule ? 'policy' : null;
    }
    if (!('decidedByRole' in out)) out.decidedByRole = null;
    if (out.decidedBy !== null) userIdOrPolicy(out.decidedBy, 'permission.decided.decidedBy');
    if (out.decidedByRole !== null && !DECIDED_BY_ROLES.includes(out.decidedByRole)) {
      fail(`permission.decided.decidedByRole must be one of ${DECIDED_BY_ROLES.join(', ')}, or null`);
    }
    optionalText(out.decisionCardId, 'permission.decided.decisionCardId');
    return out;
  },
  'tool.call': (data) => {
    if (data.surface !== undefined && !TOOL_SURFACES.includes(data.surface)) fail(`tool.call.surface must be one of ${TOOL_SURFACES.join(', ')}`);
    optionalArgsDigest(data, 'tool.call');
    return data;
  },
  'credential.granted': (data) => ({ ...data, names: envNames(data.names ?? [], 'credential.granted.names') }),
  'credential.denied': (data) => {
    envNames([data.name], 'credential.denied.name');
    return data;
  },
  'attempt.settled': (data) => {
    if (!Number.isInteger(data.attempt) || data.attempt < 1) fail('attempt.settled.attempt must be a positive integer');
    if (!OUTCOMES.includes(data.outcome)) fail(`attempt.settled.outcome must be one of ${OUTCOMES.join(', ')}`);
    if (data.failure !== undefined && data.failure !== null) {
      const { kind } = data.failure;
      if (kind !== null && kind !== undefined && !FAILURE_KINDS[kind]) fail(`attempt.settled.failure.kind ${kind} is not a FAILURE_KINDS key`);
    }
    return data;
  },
  'session.opened': (data) => {
    refuseUnknownKeys(data, ['method', 'sessionId', 'requestedSessionId', 'fallback'], 'session.opened.');
    if (!SESSION_METHODS.includes(data.method)) fail(`session.opened.method must be one of ${SESSION_METHODS.join(', ')}`);
    if (!isText(data.sessionId)) fail('session.opened needs a sessionId');
    if ((data.requestedSessionId === undefined) !== (data.fallback === undefined)) {
      fail('session.opened.requestedSessionId and fallback come together: a session was asked for and not reopened');
    }
    if (data.requestedSessionId !== undefined) {
      if (data.method !== 'new') fail('session.opened.requestedSessionId is set only when method is new');
      if (!isText(data.requestedSessionId)) fail('session.opened.requestedSessionId must be a non-empty string');
      if (typeof data.fallback !== 'string' || !SESSION_FALLBACK.test(data.fallback)) {
        fail('session.opened.fallback must be "agent supports neither session/resume nor session/load" or "session/<resume|load> answered error <code>"');
      }
    }
    return data;
  },
  usage: (data) => {
    for (const key of ['contextTokens', 'contextSize']) {
      const value = data[key];
      if (value !== undefined && value !== null && !(Number.isInteger(value) && value >= 0)) fail(`usage.${key} must be an integer >= 0, or null when unknown`);
    }
    return data;
  },
  'sandbox.applied': (data) => {
    refuseUnknownKeys(data, ['sandbox', 'reason'], 'sandbox.applied.');
    if (!SANDBOXES.includes(data.sandbox)) fail(`sandbox.applied.sandbox must be one of ${SANDBOXES.join(', ')}`);
    if (data.reason !== undefined) {
      if (data.sandbox !== 'none') fail('sandbox.applied.reason is set only when sandbox is none');
      if (!isText(data.reason)) fail('sandbox.applied.reason must be a non-empty string');
    }
    return data;
  },
  'egress.allowed': (data) => {
    refuseUnknownKeys(data, ['host', 'port'], 'egress.allowed.');
    checkEgressTarget(data, 'egress.allowed', { nullable: false });
    return data;
  },
  'egress.denied': (data) => {
    refuseUnknownKeys(data, ['host', 'port', 'reason'], 'egress.denied.');
    if (!EGRESS_DENIED_REASONS.includes(data.reason)) fail(`egress.denied.reason must be one of ${EGRESS_DENIED_REASONS.join(', ')}`);
    checkEgressTarget(data, 'egress.denied', { nullable: EGRESS_TARGETLESS.has(data.reason) });
    return data;
  },
  'result.reported': (data) => {
    if (!RESULT_STATUSES.includes(data.status)) fail(`result.reported.status must be one of ${RESULT_STATUSES.join(', ')}`);
    if (data.refs !== undefined && !(Array.isArray(data.refs) && data.refs.every((ref) => isPlainObject(ref) && isText(ref.type) && isText(ref.id)))) {
      fail('result.reported.refs must be [{type, id}]');
    }
    return data;
  },
};

/**
 * Validate one kind's data and return the copy a writer records. `envelope`
 * is {taskId, podId}, for checks that tie data to the run it sits in.
 */
export const normalizeData = (kind, data = {}, envelope = {}) => {
  if (!isPlainObject(data)) fail(`${kind} data must be an object`);
  const check = CHECKS[kind];
  return check ? check({ ...data }, envelope) : { ...data };
};

/** A grant's rules acting on their own: named by the grant when its id is a token. */
export const policyActorId = (grantId) => (isText(grantId) && isUserId(`grant:${grantId}`) ? `grant:${grantId}` : 'policy');
const policyActor = (grantId) => ({ type: 'policy', id: policyActorId(grantId) });

/** The actor a writer records when the emitter names none. */
export const defaultActor = (kind, data = {}, runActor = null) => {
  switch (KINDS[kind]?.actor) {
    case 'run': return runActor;
    case 'system': return SYSTEM_ACTOR;
    case 'board': return BOARD_ACTOR;
    case 'issuer':
      if (data.issuedBy === 'policy') return policyActor(data.grantId);
      return isUserId(data.issuedBy) ? { type: 'human', id: data.issuedBy } : null;
    case 'decider':
      if (data.decidedByRole === 'policy' || data.decidedBy === 'policy') return policyActor(data.grantId);
      return isUserId(data.decidedBy) ? { type: 'human', id: data.decidedBy } : null;
    default: return null;
  }
};

const parseLine = (line) => {
  let entry;
  try { entry = JSON.parse(line); } catch { return fail('the previous line is not JSON'); }
  if (!isPlainObject(entry) || !Number.isInteger(entry.seq)) fail('the previous line is not a record entry');
  return entry;
};

/**
 * appendEntry(prevLine, fields, { runActor }?) → the next line, canonical,
 * without its newline.
 *
 * fields: { runId, taskId?, podId?, ts, kind, actor?, data, seq? }. seq and
 * prev come from prevLine (null for the first line); a given seq must agree.
 * An absent actor takes the kind's default; null records "unknown".
 */
export const appendEntry = (prevLine, fields = {}, { runActor = null } = {}) => {
  let seq = 1;
  let prev = null;
  if (prevLine !== null && prevLine !== undefined) {
    const before = parseLine(prevLine);
    seq = before.seq + 1;
    prev = hashLine(prevLine);
    if (before.runId !== fields.runId) fail('one record holds one run');
    if (before.taskId !== fields.taskId || before.podId !== fields.podId) fail('taskId and podId are fixed for the whole run');
    if (before.kind === 'run.settled') fail('nothing is written after run.settled');
  }
  if (fields.seq !== undefined && fields.seq !== seq) fail(`seq ${fields.seq} does not follow ${seq - 1}`);
  if (!RUN_ID.test(String(fields.runId))) fail('runId must be 6-64 characters of [A-Za-z0-9_-]');
  optionalText(fields.taskId, 'taskId');
  optionalText(fields.podId, 'podId');
  if (fields.taskId && !fields.podId) fail('a taskId needs a podId: task ids repeat across pods');
  const ts = fields.ts instanceof Date ? fields.ts.toISOString() : fields.ts;
  if (!isTimestamp(ts)) fail('ts must be an RFC 3339 UTC timestamp');
  if (!Object.hasOwn(KINDS, fields.kind)) fail(`unknown record kind: ${fields.kind}`);
  const data = normalizeData(fields.kind, fields.data ?? {}, { taskId: fields.taskId, podId: fields.podId });
  const actor = validateActor(fields.actor === undefined ? defaultActor(fields.kind, data, runActor) : fields.actor);
  return canonicalLine({
    v: RECORD_VERSION,
    schema: RECORD_SCHEMA,
    runId: fields.runId,
    ...(fields.taskId ? { taskId: fields.taskId } : {}),
    ...(fields.podId ? { podId: fields.podId } : {}),
    seq,
    ts,
    kind: fields.kind,
    actor,
    data,
    prev,
  });
};

/** Split a record file's text into lines; a last line with no newline is torn. */
export const splitRecord = (text) => {
  if (!text) return { lines: [], torn: null };
  const parts = String(text).split('\n');
  const tail = parts.pop();
  return { lines: parts, torn: tail === '' ? null : tail };
};

const envelopeProblem = (entry) => {
  if (!Number.isInteger(entry.v) || entry.v < 1) return 'v';
  if (entry.schema !== RECORD_SCHEMA) return 'schema';
  if (!RUN_ID.test(String(entry.runId))) return 'runId';
  if (entry.taskId !== undefined && !isText(entry.taskId)) return 'taskId';
  if (entry.podId !== undefined && !isText(entry.podId)) return 'podId';
  if (entry.taskId !== undefined && entry.podId === undefined) return 'podId';
  if (!Number.isInteger(entry.seq) || entry.seq < 1) return 'seq';
  if (!isTimestamp(entry.ts)) return 'ts';
  if (typeof entry.kind !== 'string' || !KIND_SHAPE.test(entry.kind)) return 'kind';
  if (actorProblem(entry.actor)) return 'actor';
  if (!isPlainObject(entry.data)) return 'data';
  if (entry.prev !== null && !(typeof entry.prev === 'string' && /^[0-9a-f]{64}$/.test(entry.prev))) return 'prev';
  return null;
};

/**
 * verifyRecord(text | lines) → { ok, errors: [{seq, reason, detail?}], entries, head, settled }
 *
 * Text is a whole file, so a torn final line (no newline) can be seen; an
 * array is taken as complete lines. Each problem is reported at the seq of
 * the line where it was observed:
 *   torn           the last line was cut short by a crash mid-write
 *   unparseable    not JSON
 *   bad_envelope   an envelope field is missing or malformed (detail names it)
 *   unsupported_version  v is newer than this reader
 *   not_canonical  the bytes are not the canonical form of what they parse to
 *   seq_mismatch   seq is not the previous seq + 1 (a deleted or moved line)
 *   prev_mismatch  prev is not the hash of the line before it: that line, or
 *                  this one's prev, was changed, removed or moved
 *   run_mismatch   runId, taskId or podId differs from the first line
 *   after_settled  a line follows run.settled
 * The chain re-syncs after each problem, so one edit is reported once.
 */
export const verifyRecord = (input) => {
  const { lines, torn } = Array.isArray(input) ? { lines: input.map(String), torn: null } : splitRecord(input);
  const errors = [];
  const report = (seq, reason, detail) => errors.push(detail ? { seq, reason, detail } : { seq, reason });
  let expected = 1;
  let prevRaw = null;
  let first = null;
  let settled = false;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { entry = undefined; }
    if (!isPlainObject(entry)) {
      report(expected, 'unparseable');
      prevRaw = line;
      expected += 1;
      continue;
    }
    const seq = Number.isInteger(entry.seq) ? entry.seq : expected;
    if (Number.isInteger(entry.v) && entry.v > RECORD_VERSION) report(seq, 'unsupported_version', `v${entry.v}`);
    const problem = envelopeProblem(entry);
    if (problem) report(seq, 'bad_envelope', problem);
    let canonicalForm = null;
    try { canonicalForm = canonicalLine(entry); } catch { /* reported below */ }
    if (canonicalForm !== line) report(seq, 'not_canonical');
    if (seq !== expected) report(seq, 'seq_mismatch', `expected ${expected}`);
    const expectedPrev = prevRaw === null ? null : hashLine(prevRaw);
    if (entry.prev !== expectedPrev) report(seq, 'prev_mismatch');
    if (first === null) first = entry;
    else if (entry.runId !== first.runId || entry.taskId !== first.taskId || entry.podId !== first.podId) report(seq, 'run_mismatch');
    if (settled) report(seq, 'after_settled');
    if (entry.kind === 'run.settled') settled = true;
    prevRaw = line;
    expected = seq + 1;
  }
  if (torn !== null) report(expected, 'torn');
  return {
    ok: errors.length === 0,
    errors,
    entries: lines.length,
    head: prevRaw === null ? null : hashLine(prevRaw),
    settled,
  };
};

/** Parse a record's text into entries, skipping a torn tail and unparseable lines. */
export const readRecord = (text) => splitRecord(text).lines.flatMap((line) => {
  try {
    const entry = JSON.parse(line);
    return isPlainObject(entry) ? [entry] : [];
  } catch { return []; }
});

/**
 * Which surface a tool name belongs to, for an adapter that knows the real
 * tool name (an MCP server/tool pair, say). Never apply it to a title: a
 * title is the agent's own text and can claim any prefix.
 */
export const toolSurfaceOf = (toolName) => {
  const name = String(toolName || '');
  if (/^(?:mcp__commonly__|commonly_)/.test(name)) return 'commonly';
  if (/^mcp__[^_]/.test(name)) return 'connector';
  return 'native';
};
