/**
 * A generic adapter for any agent that speaks the Agent Client Protocol over
 * stdio. One spawn is one process and one prompt turn:
 *
 *   initialize → session/resume | session/load | session/new → session/prompt
 *
 * The agent-specific part is only how to launch it (`launch(ctx)`), so a new
 * ACP agent is a launch function, not a new adapter. The agent's
 * session/update stream maps onto ctx.trace one kind to one event, because the
 * trace vocabulary was named after ACP's update kinds.
 */
import { spawn as childSpawn } from 'node:child_process';
import { AcpRpcError, createAcpClient, DEFAULT_MAX_LINE_CHARS } from '../acp/client.js';
import { RunFailure, runFailure } from '../failures.js';
import { startProviderWatch } from '../provider-watch.js';
import { traceOf } from '../trace/events.js';
import {
  argsDigestOf, isUserId, PARKED_CALL_ROLES, policyActorId, RETRY_ERROR_TYPES,
} from '../record/format.js';
import { redactKnownCredentials, scrubAdapterFailure, spawnCredentials } from '../upstream-refusal.js';

export const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// After session/cancel the agent owes a prompt response with stopReason
// cancelled; this is how long it gets before the process is killed.
const CANCEL_GRACE_MS = 3000;
// On a normal end the agent gets a moment after stdin closes to exit by
// itself, so a session store it writes on shutdown is complete for a resume.
const CLOSE_GRACE_MS = 1000;
const KILL_GRACE_MS = 2000;
// A provider failure seen on the wire already decided the run; the agent gets
// only a moment to answer the cancel, so the run ends in about a second.
const WIRE_CANCEL_GRACE_MS = 300;
// 'exit' can arrive before the last stdout line is read; give 'close' this
// long before declaring the turn unsettled.
const EXIT_DRAIN_MS = 200;
const MAX_STDERR_CHARS = 4096;
const STDERR_IN_FAILURE = 400;
const FAILURE_LIMIT = 500;
const SECRET_NAME = /(?:^|_)(?:API_KEY|ACCESS_TOKEN|ACCESS_KEY|CLIENT_SECRET|PASSWORD|TOKEN|SECRET)$/i;
const REFUSAL_WORDING = /content[ _-]?policy|refus|rejected by|rate limit/i;
const STOP_FAILURES = Object.freeze({
  refusal: 'refusal',
  max_tokens: 'max_tokens',
  max_turn_requests: 'max_turn_requests',
  cancelled: 'cancelled',
});

// The agent leads its own process group, so a kill reaches what it spawned:
// a CLI launcher's native binary, its MCP servers, a tool's shell. Killing
// only the leader can leave a grandchild holding the run's work and keys.
const OWN_GROUP = process.platform !== 'win32';

/** Signal the whole group; false when it has no members left (or no group). */
const signalGroup = (child, signal) => {
  if (!OWN_GROUP || child.pid === undefined) return false;
  try { process.kill(-child.pid, signal); return true; } catch { return false; }
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Every value this spawn holds that must never reach a failure detail: the
 * runtime token, the provider key, and any secret-named variable in either the
 * caller's env or the env the launch built.
 */
export const acpCredentials = (ctx = {}, launchEnv = {}) => {
  const fromEnv = (env) => Object.entries(env || {})
    .filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => value);
  return [...new Set([
    ...spawnCredentials({ ...ctx, env: ctx.env || {} }, []),
    ctx.provider?.apiKey,
    ...fromEnv(ctx.env),
    ...fromEnv(launchEnv),
  ].filter((value) => typeof value === 'string' && value.length >= 8))];
};

/**
 * Does this error text read as the model route refusing? A 4xx the text names,
 * or refusal wording. Agents disagree on the shape — opencode 1.19.0 answers
 * the prompt with -32603 "Internal error: The request was rejected by the
 * content policy." and no status; goose 1.54.0 writes "Bad request (400)" —
 * so the parenthesised status is read too.
 */
export const readsAsRefusal = (text) => {
  const raw = String(text ?? '');
  const status = scrubAdapterFailure(raw).status ?? Number(/\((\d{3})\)/.exec(raw)?.[1] ?? NaN);
  return (status >= 400 && status <= 499) || REFUSAL_WORDING.test(raw);
};

/** A JSON-RPC error answer, as a named failure. */
export const failureFromRpcError = (error, credentials) => {
  const kind = readsAsRefusal(error.rpcMessage) ? 'refusal' : 'protocol';
  return runFailure(kind, `${error.method} answered error ${error.code}: ${error.rpcMessage}`, {
    credentials, limit: FAILURE_LIMIT,
  });
};

/** The reject default: a reject_once option if offered, otherwise cancelled. */
export const defaultPermissionDecision = (options = []) => {
  const reject = options.find((option) => option?.kind === 'reject_once');
  return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
};

/** A hook answer is used only when it names an option the agent offered; else null. */
const checkedDecision = (decision, options) => {
  if (decision?.outcome === 'cancelled') return { outcome: 'cancelled' };
  if (decision?.outcome === 'selected' && options.some((option) => option?.optionId === decision.optionId)) {
    return { outcome: 'selected', optionId: decision.optionId };
  }
  return null;
};

/** How a permission ask pending at stop is answered: cancelled, as ACP requires. */
const ABORTED_ANSWER = Object.freeze({ decision: Object.freeze({ outcome: 'cancelled' }), by: 'aborted' });

const isAsker = (value) => value !== null && typeof value === 'object'
  && isUserId(value.id) && PARKED_CALL_ROLES.includes(value.role);

/**
 * The roles a hook's answer may name: a person's role on a parked call. Not
 * `policy` (the policy deciding is never an answer) and not `pod-member`
 * (ADR-033 D5: a pod member's word decides no parked call).
 */
const ANSWER_ROLES = Object.freeze(PARKED_CALL_ROLES.filter((role) => role !== 'policy'));
/** A hook answer the adapter records must say who gave it, as the valet's must. */
const isAttributed = (raw) => isUserId(raw?.decidedBy) && ANSWER_ROLES.includes(raw?.decidedByRole);

/**
 * The record's human-readable ask: the tool call's kind and title, scrubbed of
 * this spawn's credentials (it is agent text) and kept short.
 */
const questionOf = (toolCall, credentials) => {
  const kind = typeof toolCall?.kind === 'string' && toolCall.kind ? toolCall.kind : 'tool';
  const title = typeof toolCall?.title === 'string' ? toolCall.title.trim() : '';
  const text = title ? `${kind}: ${title}` : `${kind} call`;
  return redactKnownCredentials(text, credentials).slice(0, QUESTION_CHARS);
};

const abortFailure = (signal) => (signal?.reason instanceof RunFailure
  ? signal.reason : runFailure('cancelled', 'the run was aborted'));

const textOf = (content) => (content?.type === 'text' && typeof content.text === 'string' ? content.text : '');

const QUESTION_CHARS = 200;
/** A context count the record accepts: an integer >= 0, else null (unknown). */
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

const usageFromPrompt = (usage) => ({
  inputTokens: usage.inputTokens ?? null,
  outputTokens: usage.outputTokens ?? null,
  totalTokens: usage.totalTokens ?? null,
  cost: null,
});

/**
 * A retry report from the launch's reader, as the record takes it: each field
 * only in its recorded shape, and absent otherwise. A type outside the
 * record's closed set is `other`, so no agent text reaches errorType.
 */
const retryData = (report, turn) => {
  const attempt = Number.isInteger(report.attempt) && report.attempt >= 1 ? report.attempt : undefined;
  if (report.state === 'started') {
    const started = attempt ?? turn.retryAttempt;
    return { state: 'started', ...(started ? { attempt: started } : {}) };
  }
  turn.retryAttempt = attempt;
  const at = typeof report.nextRetryAt === 'string' ? new Date(report.nextRetryAt) : null;
  const { status, errorType } = report;
  return {
    state: 'scheduled',
    ...(attempt ? { attempt } : {}),
    ...(at && !Number.isNaN(at.getTime()) ? { nextRetryAt: at.toISOString() } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(errorType != null ? { errorType: RETRY_ERROR_TYPES.includes(errorType) ? errorType : 'other' } : {}),
  };
};

/** One session/update → at most one trace event. Unknown kinds are dropped. */
const traceUpdate = (trace, update, turn, { readRetry } = {}) => {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textOf(update.content);
      if (!text) return;
      turn.text += text;
      trace.emit('agent.message_chunk', { text });
      return;
    }
    case 'agent_thought_chunk':
      trace.emit('agent.thought_chunk', { chars: textOf(update.content).length });
      return;
    case 'tool_call':
      trace.emit('tool.call', {
        toolCallId: update.toolCallId, title: update.title, kind: update.kind, status: update.status,
      });
      return;
    case 'tool_call_update':
      trace.emit('tool.update', { toolCallId: update.toolCallId, status: update.status ?? undefined, title: update.title ?? undefined });
      return;
    case 'plan':
      trace.emit('plan', {
        entries: (Array.isArray(update.entries) ? update.entries : [])
          .map((entry) => ({ content: entry?.content, status: entry?.status })),
      });
      return;
    case 'usage_update':
      turn.contextTokens = count(update.used) ?? turn.contextTokens;
      trace.emit('usage', {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : null,
        contextTokens: count(update.used),
        contextSize: count(update.size),
      });
      break;
    case 'session_info_update': {
      // Session state (a title) unless the launch's reader finds a retry
      // report in it; the protocol has no retry update of its own.
      const report = readRetry?.(update);
      if (report) trace.emit('agent.retry', retryData(report, turn));
      return;
    }
    default:
  }
};

const runTurn = ({
  name, launched, prompt, ctx, memoryPreamble, readReplyFailure, readRetryStatus, maxLineChars, timings, wire,
}) => new Promise((resolveRun, rejectRun) => {
  const trace = traceOf(ctx);
  // A trace writer that refuses an entry (record-v1's emit throws on data it
  // cannot record) ends the run with that error; it never escapes into a
  // stream handler, where it would crash the host instead.
  const emit = (type, data) => {
    try { trace.emit(type, data); } catch (error) { stop(error); }
  };
  const credentials = acpCredentials(ctx, launched.env);
  const cwd = launched.cwd ?? ctx.cwd ?? process.cwd();
  const turn = { text: '', contextTokens: undefined, retryAttempt: undefined };
  const pendingPermissions = new Set();
  let stderr = '';
  // Set only once session/new|resume|load has answered. Updates are read only
  // for this id, which is also what drops a load's replayed history: the
  // agent streams it before answering, while this is still null.
  let sessionId = null;
  let promptInFlight = null;
  let stopping = null;
  let settled = false;
  let exitInfo = null;
  let resolveGone;
  const gone = new Promise((resolve) => { resolveGone = resolve; });

  let child;
  try {
    child = (ctx._spawnImpl || childSpawn)(launched.command, launched.args || [], {
      cwd, env: launched.env, stdio: ['pipe', 'pipe', 'pipe'], detached: OWN_GROUP,
    });
  } catch (error) {
    rejectRun(runFailure('exited', `could not start ${name}: ${error?.code || error?.message}`, { credentials }));
    return;
  }

  const exitedFailure = () => {
    const tail = stderr.trim().slice(-STDERR_IN_FAILURE);
    const how = exitInfo ? `code ${exitInfo.code}, signal ${exitInfo.signal}` : 'no exit status';
    return runFailure('exited', `${name} exited before the turn settled (${how})${tail ? `: ${tail}` : ''}`, {
      credentials, limit: FAILURE_LIMIT,
    });
  };

  // Who decides, for the record. With a hook, the run's approver (ctx.askedOf)
  // is asked, and its answer is {outcome, optionId?, decidedBy, decidedByRole}:
  // a user id and an owner role. Without a hook, or when the hook fails or
  // names nobody, the reject default is the policy deciding. A decider that writes its own permission entries (the
  // valet's policy) carries recordsPermissions = true, and then the adapter
  // writes none, so each ask is recorded exactly once.
  const hasHook = typeof ctx.decidePermission === 'function';
  const grantId = typeof ctx.grantId === 'string' && ctx.grantId ? ctx.grantId : undefined;
  const policy = { id: policyActorId(grantId), role: 'policy' };
  const recordPermissions = ctx.decidePermission?.recordsPermissions !== true;

  /** Resolves { decision, by }: by is 'hook' (with its attribution), 'default', 'failed' or 'aborted'. */
  const decide = (params) => {
    const options = Array.isArray(params?.options) ? params.options : [];
    if (stopping) return Promise.resolve({ decision: { outcome: 'cancelled' }, by: 'aborted' });
    return new Promise((resolve) => {
      const answer = (result) => {
        if (!pendingPermissions.delete(answer)) return;
        resolve(result);
      };
      pendingPermissions.add(answer);
      if (!hasHook) { answer({ decision: defaultPermissionDecision(options), by: 'default' }); return; }
      Promise.resolve().then(() => ctx.decidePermission(params)).then((raw) => {
        // An answer the adapter records decides only when it names who gave
        // it; one naming nobody, or a pod member, is a failed ask and the
        // policy default decides. A decider that records itself (the valet)
        // has already held its own answer to that.
        const decision = checkedDecision(raw, options);
        if (!decision || (recordPermissions && !isAttributed(raw))) {
          answer({ decision: defaultPermissionDecision(options), by: 'failed' });
          return;
        }
        answer({ decision, by: 'hook', decidedBy: raw?.decidedBy, decidedByRole: raw?.decidedByRole });
      }, () => answer({ decision: defaultPermissionDecision(options), by: 'failed' }));
    });
  };

  const onRequest = async (method, params) => {
    if (method !== 'session/request_permission') return undefined;
    const options = Array.isArray(params?.options) ? params.options : [];
    const toolCall = params?.toolCall || {};
    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null;
    const argsDigest = argsDigestOf(toolCall.rawInput);
    const shared = { ...(grantId ? { grantId } : {}), ...(argsDigest ? { argsDigest } : {}) };
    if (recordPermissions) {
      emit('permission.requested', {
        toolCallId,
        options: options.map((option) => ({ optionId: option?.optionId, kind: option?.kind })),
        question: questionOf(toolCall, credentials),
        askedOf: hasHook && isAsker(ctx.askedOf) ? { id: ctx.askedOf.id, role: ctx.askedOf.role } : policy,
        ...shared,
      });
    }
    const result = await decide(params);
    const { decision } = result;
    if (recordPermissions) {
      const kind = options.find((option) => option?.optionId === decision.optionId)?.kind;
      const asked = result.by !== 'default';
      const approval = { hook: kind?.startsWith('allow') ? 'approved' : 'rejected', failed: 'failed', aborted: 'aborted' }[result.by];
      emit('permission.decided', {
        outcome: decision.outcome,
        ...(decision.optionId ? { optionId: decision.optionId, kind } : {}),
        toolCallId,
        rule: { list: result.by === 'hook' ? 'ask' : 'default', pattern: null },
        ...(asked && hasHook ? { approval } : {}),
        ...(result.by === 'hook'
          ? { decidedBy: result.decidedBy, decidedByRole: result.decidedByRole }
          : { decidedBy: 'policy', decidedByRole: 'policy' }),
        ...shared,
      });
    }
    return { outcome: decision };
  };

  const onNotification = (method, params) => {
    if (method !== 'session/update' || !sessionId || params?.sessionId !== sessionId) return;
    traceUpdate({ emit }, params.update, turn, { readRetry: readRetryStatus });
  };

  const client = createAcpClient({
    input: child.stdout, output: child.stdin, onRequest, onNotification, maxLineChars,
  });

  child.stdin.on('error', () => { /* EPIPE after exit; the exit path reports it */ });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS); });
  child.on('error', (error) => {
    if (exitInfo) return;
    client.close(runFailure('exited', `could not start ${name}: ${error?.code || error?.message}`, { credentials }));
    if (child.pid === undefined) resolveGone();
  });
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
    emit('process.exited', { code, signal });
    resolveGone();
    const done = () => client.close(exitedFailure());
    if (child.stdout.readableEnded) { done(); return; }
    const timer = setTimeout(done, EXIT_DRAIN_MS);
    timer.unref?.();
    child.once('close', () => { clearTimeout(timer); done(); });
  });

  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});

  // Cancel, then kill. ACP requires every pending permission request to be
  // answered cancelled once session/cancel is sent.
  const stop = async (failure, { cancelGraceMs = timings.cancelGraceMs } = {}) => {
    if (stopping || settled) return;
    stopping = failure;
    if (pendingPermissions.size) {
      for (const answer of [...pendingPermissions]) answer(ABORTED_ANSWER);
      // The answers are written a few microtasks later; let them reach the
      // agent before the cancel does, so it never sees a cancel with its
      // permission questions still open.
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    if (promptInFlight && sessionId) {
      client.notify('session/cancel', { sessionId });
      await Promise.race([promptInFlight.catch(() => {}), sleep(cancelGraceMs), gone]);
    }
    rejectStopped(failure);
  };

  const requestedTimeout = Number(ctx.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => stop(runFailure('timeout', `${name} exceeded ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => stop(abortFailure(ctx.signal));
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  if (wire) {
    const onWire = (failure) => stop(failure, { cancelGraceMs: timings.wireCancelGraceMs });
    if (wire.failure) onWire(wire.failure); else wire.stop = onWire;
  }

  const call = async (method, params) => {
    try {
      return await client.request(method, params);
    } catch (error) {
      if (error instanceof AcpRpcError) throw failureFromRpcError(error, credentials);
      throw error;
    }
  };

  const openSession = async (capabilities) => {
    const base = { cwd, mcpServers: launched.mcpServers || [] };
    const wanted = ctx.sessionId;
    let fallback = null;
    if (wanted) {
      const ways = [];
      if (capabilities?.sessionCapabilities?.resume) ways.push('resume');
      if (capabilities?.loadSession) ways.push('load');
      fallback = 'agent supports neither session/resume nor session/load';
      for (const way of ways) {
        try {
          await client.request(`session/${way}`, { ...base, sessionId: wanted });
          emit('session.opened', { method: way, sessionId: wanted });
          return { id: wanted, fresh: false };
        } catch (error) {
          if (!(error instanceof AcpRpcError)) throw error;
          fallback = `session/${way} answered error ${error.code}`;
        }
      }
    }
    const created = await call('session/new', base);
    if (typeof created?.sessionId !== 'string' || !created.sessionId) {
      throw runFailure('protocol', 'session/new returned no sessionId');
    }
    emit('session.opened', {
      method: 'new', sessionId: created.sessionId, ...(wanted ? { requestedSessionId: wanted, fallback } : {}),
    });
    return { id: created.sessionId, fresh: true };
  };

  const drive = async () => {
    const init = await call('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'seats', version: '0.0.0' },
    });
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw runFailure('unsupported', `${name} negotiated ACP protocol ${JSON.stringify(init?.protocolVersion ?? null)}; this adapter speaks ${ACP_PROTOCOL_VERSION}`);
    }
    const session = await openSession(init.agentCapabilities);
    sessionId = session.id;
    const text = memoryPreamble(prompt, ctx.memoryLongTerm, { freshSession: session.fresh });
    if (stopping) throw stopping;
    promptInFlight = call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    emit('turn.prompt_sent', { chars: text.length });
    const response = await promptInFlight;
    if (stopping) throw stopping;
    if (response?.usage) emit('usage', usageFromPrompt(response.usage));
    const reason = response?.stopReason;
    if (reason === 'end_turn') {
      const replyFailure = readReplyFailure?.(turn.text, { credentials });
      if (replyFailure) throw replyFailure;
      return {
        text: turn.text.trim(),
        newSessionId: sessionId,
        ...(turn.contextTokens !== undefined ? { contextTokens: turn.contextTokens } : {}),
      };
    }
    if (STOP_FAILURES[reason]) throw runFailure(STOP_FAILURES[reason], `${name} stopped the turn: ${reason}`);
    throw runFailure('protocol', `${name} answered session/prompt with unknown stopReason ${JSON.stringify(reason ?? null)}`);
  };

  const terminate = async () => {
    if (!exitInfo && !stopping) {
      child.stdin.end();
      await Promise.race([gone, sleep(timings.closeGraceMs)]);
    }
    const kill = (signal) => { if (!signalGroup(child, signal)) child.kill(signal); };
    if (!exitInfo) {
      kill('SIGTERM');
      await Promise.race([gone, sleep(timings.killGraceMs)]);
    }
    if (!exitInfo) kill('SIGKILL');
    await gone;
    // The leader is gone; anything it left in its group goes too, on every
    // end, so no descendant outlives the run.
    if (signalGroup(child, 0)) {
      signalGroup(child, 'SIGTERM');
      const deadline = Date.now() + timings.killGraceMs;
      while (signalGroup(child, 0) && Date.now() < deadline) await sleep(20);
      signalGroup(child, 'SIGKILL');
    }
  };

  const outcome = drive().catch((error) => { throw stopping || error; });
  Promise.race([outcome, stopped]).then(
    (result) => ({ result }),
    (error) => ({ error: stopping || error }),
  ).then(async (end) => {
    settled = true;
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
    for (const answer of [...pendingPermissions]) answer(ABORTED_ANSWER);
    await terminate();
    if (end.error) rejectRun(end.error); else resolveRun(end.result);
  });
});

/**
 * @param {import('../contract.js').SeatHost & {
 *   name: string,
 *   launch: (ctx: object) => Promise<AcpLaunch> | AcpLaunch,
 *   detect: () => Promise<{ path: string, version: string } | null>,
 *   runtimeType?: string,
 *   providerKeyEnv?: string,
 *   readReplyFailure?: (text: string, opts: { credentials: string[] }) => RunFailure | null,
 *   readRetryStatus?: (update: object) => { state: 'scheduled'|'started', attempt?, nextRetryAt?, status?, errorType? } | null,
 *   maxLineChars?: number,
 *   timings?: { cancelGraceMs?: number, closeGraceMs?: number, killGraceMs?: number, wireCancelGraceMs?: number },
 *   watchProvider?: boolean,
 * }} options
 *
 * @typedef {object} AcpLaunch
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} env  the whole child env; nothing is inherited
 * @property {string} [cwd]
 * @property {object[]} [mcpServers]  ACP McpServer entries for session/new|load|resume
 * @property {() => Promise<void> | void} [cleanup]
 *
 * `watchProvider` (default true) relays ctx.provider.baseURL through
 * provider-watch.js when the ctx carries one: a 4xx ends the run as
 * refusal_retry_loop, a 5xx/408/429 or an unreachable provider as
 * provider_unavailable, at the first one.
 *
 * `readReplyFailure` exists because some agents end a failed turn with
 * end_turn and the error as the reply text; the launch knows that shape, the
 * protocol does not. `readRetryStatus` is the same idea for retries: an agent
 * that reports its own provider retries does it in a session_info_update
 * `_meta` key of its own, and the reader turns that into an agent.retry.
 */
export const createAcpAdapter = ({
  name,
  launch,
  detect,
  runtimeType = name,
  providerKeyEnv,
  readReplyFailure,
  readRetryStatus,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
  timings = {},
  memoryPreamble = (prompt) => prompt,
  effectiveTrust = (trust) => trust,
  seatModelRequired = () => false,
  watchProvider = true,
} = {}) => {
  if (!name || typeof launch !== 'function' || typeof detect !== 'function') {
    throw new Error('createAcpAdapter needs a name, a launch function and a detect function');
  }
  const resolvedTimings = {
    cancelGraceMs: timings.cancelGraceMs ?? CANCEL_GRACE_MS,
    closeGraceMs: timings.closeGraceMs ?? CLOSE_GRACE_MS,
    killGraceMs: timings.killGraceMs ?? KILL_GRACE_MS,
    wireCancelGraceMs: timings.wireCancelGraceMs ?? WIRE_CANCEL_GRACE_MS,
  };
  return {
    get requiresModel() { return seatModelRequired(); },
    name,
    runtimeType,
    ...(providerKeyEnv ? { providerKeyEnv } : {}),
    detect,

    async validateEnvironment(environment) {
      // The agent's own permission system plus decidePermission is all the
      // confinement there is; nothing here can enforce a sandbox.
      if (effectiveTrust(environment?.sandbox?.trust) === 'public'
        || (environment?.sandbox?.mode && environment.sandbox.mode !== 'none')) {
        throw runFailure('unsupported', `${name}: public or sandbox-declared seats are unsupported; no enforced confinement exists for ACP agents`);
      }
    },

    async spawn(prompt, ctx = {}) {
      await this.validateEnvironment(ctx.environment);
      if (ctx.signal?.aborted) throw abortFailure(ctx.signal);
      // The provider route runs through a relay that ends the run on the
      // first failing answer; see provider-watch.js for why the wire is the
      // only place that answer is visible.
      const wire = { failure: null, stop: null };
      const watch = watchProvider && ctx.provider?.baseURL ? await startProviderWatch({
        baseURL: ctx.provider.baseURL,
        credentials: acpCredentials(ctx),
        onFailure: (failure) => {
          wire.failure = failure;
          wire.stop?.(failure);
        },
      }) : null;
      let launched;
      try {
        launched = await launch(watch ? { ...ctx, provider: { ...ctx.provider, baseURL: watch.baseURL } } : ctx);
        return await runTurn({
          name, launched, prompt, ctx, memoryPreamble, readReplyFailure, readRetryStatus, maxLineChars, timings: resolvedTimings, wire,
        });
      } finally {
        try { await launched?.cleanup?.(); } catch { /* cleanup is best effort; the turn's outcome stands */ }
        await watch?.close();
      }
    },
  };
};
