/**
 * approvalActionService — ADR-020 D2/D3 (implements ADR-017's card lifecycle).
 *
 * propose → a flagged ApprovalAction row + a 'card' message whose payload
 * renders it; resolve → one-way, owner-only, human-only transition that (on
 * approval) executes the action with the USER's authority and rewrites the
 * card payload so every client converges on the authoritative face.
 *
 * Executor contract (D2): the agent identity executes, the user's authority
 * owns. Every executor receives the resolved ApprovalAction and MUST create
 * resources owned by `ownerUserId` — never by the agent's bot user. The
 * resolved row is the AuthorizedAction audit record.
 */
import { createHash, randomUUID } from 'crypto';
import ApprovalAction, {
  IApprovalAction, ApprovalActionType, ApprovalToolCall, ApprovalToolCallEnding,
} from '../models/ApprovalAction';
import Pod from '../models/Pod';
import User from '../models/User';
import { assertAgentRuntimeMayJoinPod } from './outsiderGrantAgentJoinPolicy';
import { recordApprovalOutcome } from './brokerRecordService';
import { nextFreeByoName } from './byoNameAllocator';
import { prWriteApprovalSummary } from './prWriteScope';
import { APPROVAL_OUTCOME_UNKNOWN } from './brokerWriteOutcome';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation, AgentRegistry } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reservedAgentNameRefusal } = require('./agentNameReservation');

const CARD_KIND = 'approval-card';

// Pod types an approved create_pod may mint. DM-shaped types are excluded for
// the same reason podController's DM guard exists: minting a 1:1-typed pod
// with arbitrary membership breaks the §3.10 invariant.
const CREATABLE_POD_TYPES = new Set(['chat', 'team']);

/**
 * What the owner reads when that happens, on the room receipt. The card's
 * `approvalCard.toolCall.outcomeUnknown` says the same.
 */
const OUTCOME_UNKNOWN_SENTENCE = 'This call may have run. Check before approving it again.';

const KNOWN_ACTION_TYPES = new Set<ApprovalActionType>(['create_pod', 'connect_local_agent', 'tool_call']);

// Same shape the registry install route enforces for self-serve names (no
// scoped @publisher/ names for local seats). Mirrors the BYO page's
// sanitizeAgentName output alphabet.
const LOCAL_AGENT_NAME_RE = /^[a-z0-9-]{2,40}$/;
// What the person runs, as the CLI's --adapter names it. The proposer asked,
// so the connect page opens on that tool's command instead of guessing.
const LOCAL_AGENT_ADAPTERS = new Set(['claude', 'codex']);

// Scopes the BYO connect page grants a self-serve seat (V2AgentBYO
// DEFAULT_SCOPES) — the approved seat must be interchangeable with a
// hand-connected one, or the connect page's token step behaves differently
// depending on who created the seat.
const LOCAL_AGENT_SCOPES = [
  'context:read', 'summaries:read', 'messages:write', 'messages:read',
  'posts:write', 'posts:read', 'memory:read', 'memory:write',
];

export interface CardPayload {
  runId?: string;
  runPodId?: string;
  kind: typeof CARD_KIND;
  approvalId: string;
  actionType: ApprovalActionType;
  summary: string;
  params: Record<string, unknown>;
  /** Safe tool metadata visible on the shared card; arguments remain owner-only. */
  toolCall?: { tool: string };
  status: string;
  decision?: string;
  // Owner id lets the client decide whether to show action buttons. This is
  // shared state (who owns the card), NOT per-viewer state — never broadcast
  // per-viewer fields like `canApprove` (the reaction `mine` lesson).
  ownerUserId: string;
  agentName: string;
  instanceId: string;
  expiresAt: string;
  executionResult?: unknown;
  executionError?: string;
  toolCallEnding?: ApprovalToolCallEnding;
  toolCallCode?: string;
  toolCallTrailId?: string;
}

const legacyToolCallOutcome = (row: IApprovalAction): Partial<CardPayload> => {
  if (row.actionType !== 'tool_call' || row.toolCallEnding || row.status !== 'resolved'
    || row.decision !== 'approved') return {};
  const result = row.executionResult as Record<string, unknown> | undefined;
  if (row.executionError || result?.isError === true) {
    return { toolCallEnding: 'failed', toolCallCode: 'legacy_execution_failed' };
  }
  return row.executionResult !== undefined ? { toolCallEnding: 'ran' } : {};
};

export const buildCardPayload = (row: IApprovalAction): CardPayload => ({
  kind: CARD_KIND,
  ...(row.runId ? { runId: String(row.runId),
    ...(row.runPodId ? { runPodId: String(row.runPodId) } : {}) } : {}),
  approvalId: String(row._id),
  actionType: row.actionType,
  summary: row.summary,
  // Broker arguments are secret-bearing user input. They are rendered by an
  // owner-scoped read, never in the shared card payload.
  params: row.actionType === 'tool_call' ? {} : (row.params || {}) as Record<string, unknown>,
  ...(row.actionType === 'tool_call' && row.toolCall?.tool
    ? { toolCall: { tool: row.toolCall.tool } }
    : {}),
  status: row.status,
  ...(row.decision ? { decision: row.decision } : {}),
  ownerUserId: String(row.ownerUserId),
  agentName: row.agentName,
  instanceId: row.instanceId || 'default',
  expiresAt: row.expiresAt?.toISOString?.() || new Date(row.expiresAt).toISOString(),
  ...(row.actionType === 'tool_call'
    ? {
      ...legacyToolCallOutcome(row),
      ...(row.toolCallEnding ? { toolCallEnding: row.toolCallEnding } : {}),
      ...(row.toolCallCode ? { toolCallCode: row.toolCallCode } : {}),
      ...(row.toolCallTrailId ? { toolCallTrailId: row.toolCallTrailId } : {}),
    }
    : {
      ...(row.executionResult !== undefined ? { executionResult: row.executionResult } : {}),
      ...(row.executionError ? { executionError: row.executionError } : {}),
    }),
});

/**
 * Add the parked call's exact arguments only for its accountable owner. A PR
 * write (TASK-783) shows the owner a summary instead: a push's bundle and a
 * commit's file contents stay server-side on the row, and only the envelope's
 * winner ever reads them.
 */
export const buildOwnerCardPayload = (
  row: IApprovalAction,
  callerUserId: string,
): CardPayload & { toolCall?: ApprovalToolCall & { summary?: Record<string, unknown> } } => {
  const payload = buildCardPayload(row) as CardPayload & {
    toolCall?: ApprovalToolCall & { summary?: Record<string, unknown> };
  };
  if (row.actionType === 'tool_call' && String(row.ownerUserId) === String(callerUserId) && row.toolCall) {
    const summary = prWriteApprovalSummary(row.toolCall.tool, row.toolCall.canonicalArgs);
    if (summary) {
      const { canonicalArgs: _withheld, ...envelope } = row.toolCall;
      payload.toolCall = { ...envelope, summary };
    } else {
      payload.toolCall = row.toolCall;
    }
  }
  return payload;
};

interface ProposeOptions {
  /** Internal runtime identity, never copied from the agent HTTP body. */
  runId?: string;
  runPodId?: string;
  podId: string;
  agentName: string;
  instanceId: string;
  displayName?: string;
  actionType: string;
  params: Record<string, unknown>;
  summary: string;
  installationConfig?: unknown;
  /** A native turn that called a grant keeps its later card inside the pod. */
  noOutboundRelay?: boolean;
  /** Broker calls bind approval to the Integration owner, not pod creator. */
  ownerUserId?: string;
  agentUserId?: string;
  toolCall?: ApprovalToolCall;
  /** Broker-supplied upper bound; a parked card never outlives its grant. */
  approvalExpiresAt?: Date;
}

interface ProposeResult {
  ok: boolean;
  error?: string;
  /**
   * Why the card was not posted (F180), when it was not: `approval_card_refused`
   * (the message service declined it; asking again will not help) or
   * `approval_unavailable` (the message store failed; a retry may work).
   */
  code?: 'approval_card_refused' | 'approval_unavailable' | 'approval_queue_full';
  /** The message service's own reason for a refused card. */
  reason?: string;
  approvalId?: string;
  messageId?: string;
  /**
   * A `tool_call` identical to one already waiting (F180): the existing
   * approval is returned, with the call id it parked under, and no new card
   * is posted.
   */
  reused?: boolean;
  callId?: string;
  /** For `approval_queue_full`: how many of this seat's cards are waiting here. */
  pending?: number;
}

/**
 * Open `tool_call` cards one seat may have waiting in one pod (F180). Parking
 * spends no grant budget, so without this the only bound on a seat's cards
 * is the message rate limit.
 */
export const MAX_OPEN_TOOL_CALL_APPROVALS = 3;

const validateParams = (actionType: ApprovalActionType, params: Record<string, unknown>): string | null => {
  if (actionType === 'create_pod') {
    const name = String(params.name || '').trim();
    if (!name) return 'params.name is required for create_pod';
    if (name.length > 80) return 'params.name must be 80 characters or fewer';
    const type = String(params.type || 'chat');
    if (!CREATABLE_POD_TYPES.has(type)) {
      return `params.type must be one of: ${Array.from(CREATABLE_POD_TYPES).join(', ')}`;
    }
    return null;
  }
  if (actionType === 'connect_local_agent') {
    const name = String(params.name || '').trim().toLowerCase();
    if (!name) return 'params.name is required for connect_local_agent';
    if (!LOCAL_AGENT_NAME_RE.test(name)) {
      return 'params.name must be 2-40 chars of lowercase letters, digits, and dashes';
    }
    if (params.adapter !== undefined && !LOCAL_AGENT_ADAPTERS.has(String(params.adapter))) {
      return `params.adapter must be one of: ${Array.from(LOCAL_AGENT_ADAPTERS).join(', ')}`;
    }
    return null;
  }
  if (actionType === 'tool_call') {
    if (!params || Object.keys(params).length !== 0) return 'tool_call params must be empty';
    return null;
  }
  return `unknown actionType '${actionType}'`;
};

// #609 cross-owner identity guard, propose-time edition: agent identity +
// memory key on (agentName, instanceId) with no owner dimension, so binding
// a name any OTHER user already owns would reuse their bot User + memory.
// Checking at propose time lets the agent pick a new name immediately
// instead of minting a card doomed to fail; executeConnectLocalAgent
// re-checks at approval time (state can change in between). The registry
// install route checks the same durable publisher and principal owner.
const findForeignLocalAgentOwner = async (
  agentName: string,
  ownerUserId: unknown,
): Promise<boolean> => {
  // Installation rows can be pruned, while the registry publisher and bot
  // principal survive uninstall. Both durable records must agree with the
  // proposed owner before we offer or execute this seat.
  const registry = await AgentRegistry.getByName(agentName);
  if (registry?.ephemeral && String(registry.publisher?.userId || '') !== String(ownerUserId)) return true;
  const principal = await User.findOne({ username: agentName, isBot: true })
    .select('botMetadata.ownerUserId').lean();
  const principalOwner = principal?.botMetadata?.ownerUserId;
  if (principalOwner && String(principalOwner) !== String(ownerUserId)) return true;
  // An unowned legacy principal with no registry owner is ambiguous. A
  // same-owner registry row lets the install route backfill the User stamp.
  if (principal && !principalOwner && (!registry?.ephemeral
    || String(registry.publisher?.userId || '') !== String(ownerUserId))) return true;
  const foreign = await AgentInstallation.findOne({
    agentName,
    instanceId: 'default',
    installedBy: { $ne: ownerUserId },
  });
  return !!foreign;
};

const nameSlug = (value: unknown): string => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  // The line above collapses every run to one '-', so trimming one is enough.
  .replace(/^-|-$/g, '');

// The leading words of a slug that fit in `max` characters, cut at a dash so a
// word is never chopped (QA BYO walk 2: a 20-character slice turned the
// username "eng-smoke-byo2-470105" into "...-47010"). A first word longer than
// `max` is the only one cut.
const leadingWords = (slug: string, max: number): string => {
  const words = slug.split('-').filter(Boolean);
  let out = '';
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return out || slug.slice(0, max);
};

// What the seat runs, in one word, from the name the agent proposed: the CLI
// when it names one, otherwise its first words.
const toolWord = (requestedName: string): string => {
  if (/claude/.test(requestedName)) return 'claude';
  if (/codex/.test(requestedName)) return 'codex';
  return leadingWords(nameSlug(requestedName.replace(/^(my|your-name|your)-/, '').replace(/-code$/, '')), 12) || 'agent';
};

/**
 * A free seat name built from the owner's username, offered when a proposed
 * connect_local_agent name is refused. Seat names are instance-wide and stay
 * held after an uninstall (identity continuity), so a generic proposal such as
 * "my-claude" works once on the whole instance. The proposing agent gets a
 * concrete name that will work instead of guessing again (2026-10-14).
 */
export const suggestLocalAgentName = async (requestedName: string, ownerUserId: unknown): Promise<string | null> => {
  const owner = await User.findById(ownerUserId) as { username?: string } | null;
  if (!owner) return null;
  // A username with no ASCII letters or digits (e.g. '中文') slugs to nothing;
  // fall back to the account id so a refusal always carries a working name.
  // Short on purpose: the name is the last word of the command the person
  // pastes, and repeats on the page (QA BYO walk 2 got a 37-character one).
  // "<first words of the username, at most 12>-<claude|codex|first words>",
  // then a counter only when that is taken: at most 12 + 1 + 12 + 2 = 27.
  const who = leadingWords(nameSlug(owner.username), 12) || `user-${String(ownerUserId).slice(-6).toLowerCase()}`;
  const what = toolWord(nameSlug(requestedName));
  const base = `${who}-${what}`;
  // A short name collides more often than the long one did, so after the
  // counters come two random three-hex tails (at most 25 + 4 = 29 characters).
  const tail = () => randomUUID().replace(/-/g, '').slice(0, 3);
  const candidates = [
    base, `${base}-2`, `${base}-3`, `${base}-4`, `${base}-5`, `${base}-${tail()}`, `${base}-${tail()}`,
  ];
  for (const candidate of candidates) {
    // "Free" means nobody holds it, the owner included: an existing seat of
    // theirs would make the new card reuse that identity instead of a new one.
    if (LOCAL_AGENT_NAME_RE.test(candidate)
      // eslint-disable-next-line no-await-in-loop
      && !(await reservedAgentNameRefusal(candidate))
      // eslint-disable-next-line no-await-in-loop
      && !(await AgentInstallation.findOne({ agentName: candidate, instanceId: 'default' }))
      // eslint-disable-next-line no-await-in-loop
      && !(await AgentRegistry.getByName(candidate))
      // eslint-disable-next-line no-await-in-loop
      && !(await User.findOne({ username: candidate, isBot: true }).select('_id').lean())) {
      return candidate;
    }
  }
  return null;
};

/**
 * The decider is the accountable HUMAN — not whoever happens to have created
 * the pod.
 *
 * `ownerUserId = pod.createdBy` was the original derivation and it is wrong at
 * scale: 63 of 261 production pods are bot-created, so a card proposed in one
 * was undecidable by construction. The owner-only resolve gate refused a
 * decider who could never exist, and the card sat on the WAITING face forever.
 * On a consent surface that fails silent, which is the one failure mode a
 * consent surface may not have.
 *
 * Candidates are tried in accountability order: whoever installed this agent
 * here answers for what it proposes; the pod's creator is the fallback.
 *
 * Each candidate must RESOLVE to a non-bot User, which is stricter than
 * testing the field for presence, and deliberately so — `installedBy` is not
 * reliably a human. `agentsRuntime`'s auto-install paths store a bot `_id`
 * (:2850, :2907, :2997), and `seed-native-agents` stores a hardcoded admin id
 * that simply does not exist on a self-hosted instance, where it is a dangling
 * ref rather than a bot. A presence check catches neither; resolution catches
 * both.
 *
 * Returning null means refuse to mint. That is the honest outcome: an
 * undecidable card is the exact failure this derivation exists to prevent, and
 * a refusal at propose time tells the agent something it can act on.
 */
const resolveHumanDecider = async (candidates: unknown[]): Promise<string | null> => {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate ? String(candidate) : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // eslint-disable-next-line no-await-in-loop
    const user = await User.findById(key);
    if (user && user.isBot !== true) return String(user._id);
  }
  return null;
};

/**
 * The runtime (HTTP) producer path, kept HERE rather than in the route so the
 * thing under test is the thing that runs.
 *
 * An earlier draft of the route's test re-declared the handler inside the test
 * file. It passed while proving nothing about the route — the exact
 * copy-drifts-from-its-source failure this repo has already paid for. The
 * novel rules of the HTTP surface (active-installation gate,
 * principal-from-token, refusal mapping) therefore live in the service, and
 * the route is a five-line adapter over this function.
 *
 * Returns an HTTP-shaped verdict rather than throwing: the route's only job is
 * to spread it onto `res`.
 */
export const proposeActionForRuntime = async (input: {
  podId: string;
  installations?: { podId?: unknown }[];
  installation: { agentName?: string; instanceId?: string; displayName?: string; config?: unknown; podId?: unknown };
  authorizedPodIds?: unknown[];
  body: { actionType?: string; params?: Record<string, unknown>; summary?: string };
}): Promise<{ status: number; body: Record<string, unknown> }> => {
  const {
    podId, installations, installation, authorizedPodIds, body,
  } = input;

  // The scope check runs HERE, not in the route, and takes the raw inputs.
  // An earlier draft accepted a pre-computed `podAuthorized` boolean, which
  // meant the test proved only that the service honours the flag — a route
  // returning true where it should return false passed untouched. That is the
  // same test-the-copy mistake this service placement was meant to fix, one
  // layer up (sprint-review, fleet review 2026-08-14).
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { ensurePodMatch } = require('./agentPodScope');
  if (!ensurePodMatch(installations || installation, podId, authorizedPodIds || [])) {
    return { status: 403, body: { message: 'Agent token not authorized for this pod' } };
  }

  // Token scope alone is not permission to act — the same gate the claim
  // route applies. An uninstalled agent must not keep proposing.
  //
  // `instanceId` is pinned deliberately (sprint-review). Without it the query
  // asks "is SOME install of this agentName active in this pod", not "is THIS
  // caller's" — and per-user Scout seats make sibling instances of one
  // agentName the normal shape, so a deactivated caller could ride a sibling's
  // active row. `findForeignLocalAgentOwner` above already pins it.
  const active = await AgentInstallation.findOne({
    agentName: installation.agentName,
    instanceId: installation.instanceId || 'default',
    podId,
    status: 'active',
  });
  if (!active) return { status: 403, body: { message: 'no active installation in this pod' } };

  // Principal comes from the token's installation, never from the body — a
  // caller must not be able to propose as somebody else by naming them.
  const result = await proposeAction({
    podId,
    agentName: String(installation.agentName || ''),
    instanceId: installation.instanceId || 'default',
    displayName: installation.displayName,
    actionType: String(body?.actionType || ''),
    params: body?.params || {},
    summary: String(body?.summary || ''),
    installationConfig: installation.config || null,
  });

  // Every service refusal is caller-fixable, so it is a 400 carrying the
  // service's own sentence: an agent told "no accountable human owns this
  // pod" can act on that, where a bare 400 teaches it nothing.
  if (!result?.ok) {
    return { status: 400, body: { message: result?.error || 'could not propose action' } };
  }
  return { status: 200, body: { ...result } };
};

type OpenToolCallRow = {
  _id: unknown;
  messageId?: string;
  status?: string;
  expiresAt?: Date;
  toolCall?: { callId?: string };
};
type WaitingRun = { runId: string; runPodId?: string };

/**
 * A lost race on a unique index. MongoDB answers E11000; FerretDB can answer a
 * code-1 constraint error instead (ADR-034 group 3), which carries no
 * keyPattern, so neither this nor its caller reads one.
 */
const isDuplicateKeyError = (error: unknown): boolean => {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e?.code === 11000) return true;
  return e?.code === 1 && /duplicate key|unique constraint/i.test(String(e?.message || ''));
};

const queueFull = (waiting: number): ProposeResult => ({
  ok: false,
  code: 'approval_queue_full',
  pending: waiting,
  error: `The owner has ${waiting} approvals waiting from this agent here, and a new one can't be added `
    + 'until they act on one. Nothing ran.',
});

/**
 * Park a later run on an approval that is already waiting (F180), and record
 * that run on it (F184) so the decision event names every run whose call it
 * decides, not only the run that happened to post the card.
 */
const reuseOpenToolCall = async (
  same: OpenToolCallRow,
  waitingRun: WaitingRun | null,
): Promise<ProposeResult | 'retry'> => {
  if (waitingRun) {
    const recorded = await ApprovalAction.updateOne(
      {
        _id: same._id,
        status: 'flagged',
        runId: { $ne: waitingRun.runId },
        'waitingRuns.runId': { $ne: waitingRun.runId },
        // Bounded, and never truncated: a run told it is parked must be in
        // the decision event, so a full list refuses the next run instead.
        [`waitingRuns.${MAX_WAITING_RUNS - 1}`]: { $exists: false },
      },
      { $push: { waitingRuns: waitingRun } },
    );
    if (recorded && recorded.matchedCount === 0) {
      const current = await ApprovalAction.findById(same._id).select('status runId waitingRuns').lean() as {
        status?: string; runId?: unknown; waitingRuns?: Array<{ runId?: unknown }>;
      } | null;
      // Closed after the lookup found it open: parking on it would wait for a
      // decision that has already happened, so the caller claims again.
      if (!current || current.status !== 'flagged') return 'retry';
      const known = String(current.runId || '') === String(waitingRun.runId)
        || (current.waitingRuns || []).some((run) => String(run.runId) === String(waitingRun.runId));
      if (!known) {
        return {
          ok: false,
          code: 'approval_queue_full',
          error: `Too many runs are already waiting on this approval (${MAX_WAITING_RUNS}), so this call `
            + 'was not parked on it. Nothing ran. Wait for the owner to decide it.',
        };
      }
    }
  }
  return {
    ok: true,
    reused: true,
    approvalId: String(same._id),
    messageId: String(same.messageId || ''),
    callId: String(same.toolCall?.callId || ''),
  };
};

/** Later runs one approval remembers for its decision event (F184). */
export const MAX_WAITING_RUNS = 20;

/** How long a racing identical call waits for the winner's card (F184). */
const TWIN_CARD_WAIT_MS = 2000;
const TWIN_CARD_POLL_MS = 50;
/** Create attempts per proposal before giving up as unavailable (F184). */
const MAX_SLOT_ATTEMPTS = MAX_OPEN_TOOL_CALL_APPROVALS * 3;

/**
 * The open identical row that won a race: once its card is posted, this call
 * parks on it. `retry` means the twin closed (its card failed, it was decided
 * or it lapsed) and the slot it held may be free; `unavailable` means its card
 * is still not posted after a short wait.
 */
const settleOnTwin = async (
  twinId: unknown,
  waitingRun: WaitingRun | null,
): Promise<{ result: ProposeResult } | 'retry' | 'unavailable'> => {
  const deadline = Date.now() + TWIN_CARD_WAIT_MS;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const twin = await ApprovalAction.findById(twinId).lean() as (OpenToolCallRow
      & { toolCall?: ApprovalToolCall }) | null;
    if (!twin || twin.status !== 'flagged') return 'retry';
    if (twin.expiresAt && new Date(twin.expiresAt).getTime() <= Date.now()) {
      // An unswept lapsed row still holds the identity; close it the way the
      // sweeper would, then take its place.
      // eslint-disable-next-line no-await-in-loop
      await expireToolCallApproval(twin, new Date());
      return 'retry';
    }
    if (twin.messageId) {
      // eslint-disable-next-line no-await-in-loop
      const reused = await reuseOpenToolCall(twin, waitingRun);
      return reused === 'retry' ? 'retry' : { result: reused };
    }
    if (Date.now() >= deadline) return 'unavailable';
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, TWIN_CARD_POLL_MS); });
  }
};

/**
 * F184: create a broker approval in one of the seat's open-card slots, with
 * the two partial unique indexes on ApprovalAction as the arbiter. A lost race
 * on the identity index means an identical call is already open, so this call
 * parks on it; a lost race on a slot means another call took that slot, so the
 * next is tried. When every slot is taken, lapsed rows that still hold one are
 * expired and the slots tried again once; otherwise the queue is full.
 *
 * Why slots and not a counter document: a counter has to be decremented on
 * every path that closes an approval (decide, expire in the decide path, the
 * sweeper, a failed card, the cardless sweep), and one missed decrement leaks
 * a slot for good. A slot is held by the open row itself and is freed by the
 * same write that closes the row, so there is nothing to release.
 */
const claimToolCallSlot = async (
  doc: Record<string, unknown>,
  identity: Record<string, unknown>,
  open: Record<string, unknown>,
  waitingRun: WaitingRun | null,
): Promise<{ row: IApprovalAction } | { result: ProposeResult }> => {
  let attempts = 0;
  let swept = false;
  let slot = 0;
  while (attempts < MAX_SLOT_ATTEMPTS) {
    if (slot >= MAX_OPEN_TOOL_CALL_APPROVALS) {
      if (swept) break;
      swept = true;
      // eslint-disable-next-line no-await-in-loop
      const lapsed = await ApprovalAction.find({
        podId: open.podId, agentUserId: open.agentUserId, actionType: 'tool_call',
        status: 'flagged', expiresAt: { $lte: new Date() },
      }).select('_id toolCall').lean() as Array<{ _id: unknown; toolCall?: ApprovalToolCall }>;
      if (!lapsed.length) break;
      for (const one of lapsed) {
        // eslint-disable-next-line no-await-in-loop
        await expireToolCallApproval(one, new Date());
      }
      slot = 0;
    }
    attempts += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      return { row: await ApprovalAction.create({ ...doc, toolCallSlot: slot }) };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
    // Which index refused is read from the data, not the error: FerretDB's
    // form names no key.
    // eslint-disable-next-line no-await-in-loop
    const twin = await ApprovalAction.findOne({ ...identity, toolCallSlot: { $exists: true } })
      .select('_id').lean() as { _id: unknown } | null;
    if (twin) {
      // eslint-disable-next-line no-await-in-loop
      const settled = await settleOnTwin(twin._id, waitingRun);
      if (settled === 'unavailable') {
        return {
          result: {
            ok: false,
            code: 'approval_unavailable',
            error: 'an identical call is already waiting for its approval card to post',
          },
        };
      }
      if (settled !== 'retry') return settled;
      continue;
    }
    slot += 1;
  }
  // eslint-disable-next-line no-await-in-loop
  return { result: queueFull(Math.max(await ApprovalAction.countDocuments(open), MAX_OPEN_TOOL_CALL_APPROVALS)) };
};

export const proposeAction = async (options: ProposeOptions): Promise<ProposeResult> => {
  const {
    podId, agentName, instanceId, displayName, actionType, params, summary, installationConfig,
    ownerUserId: requestedOwnerUserId, agentUserId, toolCall, noOutboundRelay, approvalExpiresAt,
  } = options;

  if (!KNOWN_ACTION_TYPES.has(actionType as ApprovalActionType)) {
    return {
      ok: false,
      error: `unknown actionType '${actionType}' — known: ${Array.from(KNOWN_ACTION_TYPES).join(', ')}`,
    };
  }
  if (actionType === 'tool_call' && (!toolCall
    || !toolCall.grantId || !toolCall.callId || !toolCall.tool || !toolCall.argsDigest
    || !toolCall.canonicalArgs || !agentUserId)) {
    return { ok: false, error: 'tool_call envelope is incomplete' };
  }
  if (actionType === 'tool_call' && toolCall) {
    // Bind the approval to the exact canonical payload at the trust boundary;
    // the broker repeats this check immediately before provider execution.
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { digestArgs } = require('../models/ToolCall');
    if (digestArgs(toolCall.canonicalArgs) !== toolCall.argsDigest) {
      return { ok: false, error: 'tool_call args digest does not match canonical args' };
    }
  }
  const paramsError = validateParams(actionType as ApprovalActionType, params || {});
  if (paramsError) return { ok: false, error: paramsError };
  const trimmedSummary = String(summary || '').trim();
  if (!trimmedSummary) return { ok: false, error: 'summary is required' };

  const pod = await Pod.findById(podId).select('createdBy').lean() as { createdBy?: unknown } | null;
  if (!pod) return { ok: false, error: 'pod not found' };

  // See resolveHumanDecider: installer first, pod creator as fallback, and the
  // winner must resolve to a real non-bot User.
  const install = await AgentInstallation.findOne({
    agentName: String(agentName).toLowerCase(),
    podId,
    instanceId: instanceId || 'default',
    status: 'active',
  });
  const ownerUserId = actionType === 'tool_call'
    ? await resolveHumanDecider([requestedOwnerUserId])
    : await resolveHumanDecider([install?.installedBy, pod.createdBy]);
  if (!ownerUserId) {
    return {
      ok: false,
      error: 'no accountable human owns this pod, so an approval card here would be undecidable — '
        + 'a human must install the agent or own the pod before it can propose actions',
    };
  }

  if (actionType === 'connect_local_agent') {
    const requestedName = String((params || {}).name || '').trim().toLowerCase();
    // Refused at proposal time so the proposing agent can pick another name
    // before a person is asked to approve one that cannot work.
    const reserved = await reservedAgentNameRefusal(requestedName);
    const taken = !reserved && await findForeignLocalAgentOwner(requestedName, ownerUserId);
    if (reserved || taken) {
      const suggestion = await suggestLocalAgentName(requestedName, ownerUserId);
      const why = reserved
        ? `the agent name "${requestedName}" belongs to a built-in agent`
        : `the agent name "${requestedName}" is already in use by another user`;
      return {
        ok: false,
        error: `${why} — pick a different name${suggestion ? `, such as "${suggestion}", which is free` : ''}`,
      };
    }
  }

  // The card proposes the name the connect page would land on (TASK-329): the
  // same allocator the page's suggestion uses, so the person approves the name
  // they get. A seat this owner already holds in this pod is a reconnect, and
  // keeps its name.
  let cardParams = params || {};
  let cardSummary = trimmedSummary;
  if (actionType === 'connect_local_agent') {
    const requestedName = String(cardParams.name || '').trim().toLowerCase();
    const reconnect = await AgentInstallation.findOne({
      agentName: requestedName, podId, instanceId: 'default', installedBy: ownerUserId, status: 'active',
    });
    const freeName = reconnect
      ? requestedName
      : await nextFreeByoName(ownerUserId, requestedName, { podId: String(podId) });
    if (freeName !== requestedName) {
      if (!LOCAL_AGENT_NAME_RE.test(freeName)) {
        return {
          ok: false,
          error: `no free name near "${requestedName}" fits the 40-character limit — pick a shorter name`,
        };
      }
      cardParams = { ...cardParams, name: freeName };
      // The summary is what the card prints, so it must name the same agent.
      // requestedName passed validateParams, but escape it anyway: it is user input.
      const escapedName = requestedName.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
      cardSummary = cardSummary.replace(
        new RegExp(`(?<![a-z0-9-])${escapedName}(?![a-z0-9-])`, 'g'),
        freeName,
      );
    }
  }

  // F180: the broker's cards skip the posting guards, so they get their own
  // bounds. An identical call already waiting is that call, not a new one; and
  // a seat may keep only so many waiting in one pod before the owner acts.
  // These reads are the fast path; the store enforces both (F184, below).
  const isBrokerCall = actionType === 'tool_call' && !!toolCall && !!agentUserId;
  const identity = isBrokerCall && toolCall ? {
    podId,
    agentUserId: String(agentUserId),
    ownerUserId,
    actionType: 'tool_call',
    status: 'flagged',
    'toolCall.grantId': toolCall.grantId,
    'toolCall.tool': toolCall.tool,
    'toolCall.argsDigest': toolCall.argsDigest,
    // null matches a missing digest as well as a stored null, as the index does.
    'toolCall.definitionDigest': toolCall.definitionDigest ?? null,
  } : null;
  const open = isBrokerCall ? {
    podId,
    agentUserId: String(agentUserId),
    actionType: 'tool_call',
    status: 'flagged',
    expiresAt: { $gt: new Date() },
  } : null;
  const waitingRun = options.runId
    ? { runId: options.runId, ...(options.runPodId ? { runPodId: options.runPodId } : {}) }
    : null;
  if (identity && open) {
    const same = await ApprovalAction.findOne({
      ...identity,
      expiresAt: { $gt: new Date() },
      messageId: { $exists: true, $ne: '' },
    }).sort({ createdAt: -1 }).lean() as OpenToolCallRow | null;
    if (same) {
      const reused = await reuseOpenToolCall(same, waitingRun);
      // A 'retry' falls through to the claim, which sees the store as it is now.
      if (reused !== 'retry') return reused;
    }
    const waiting = await ApprovalAction.countDocuments(open);
    // A full queue may hold this call's own twin whose card is still posting
    // (the lookup above sees only carded rows). Then this is not a new card:
    // the claim meets the twin on the identity index and settles on it.
    if (waiting >= MAX_OPEN_TOOL_CALL_APPROVALS && !await ApprovalAction.exists(identity)) {
      return queueFull(waiting);
    }
  }

  const doc = {
    ...(options.runId ? { runId: options.runId,
      ...(options.runPodId ? { runPodId: options.runPodId } : {}) } : {}),
    podId,
    ownerUserId,
    agentName: String(agentName).toLowerCase(),
    ...(actionType === 'tool_call' && agentUserId ? { agentUserId } : {}),
    instanceId: instanceId || 'default',
    actionType,
    params: actionType === 'tool_call' ? {} : cardParams,
    ...(actionType === 'tool_call' && toolCall ? { toolCall } : {}),
    ...(actionType === 'tool_call' && approvalExpiresAt
      ? { expiresAt: new Date(Math.min(Date.now() + 24 * 60 * 60 * 1000, approvalExpiresAt.getTime())) }
      : {}),
    summary: cardSummary.slice(0, 500),
  };
  let row: IApprovalAction;
  if (identity && open) {
    const claim = await claimToolCallSlot(doc, identity, open, waitingRun);
    if ('result' in claim) return claim.result;
    row = claim.row;
  } else {
    row = await ApprovalAction.create(doc);
  }

  // The card message. `content` is the plain-text fallback so legacy
  // surfaces (v1, digests, notifications) still show something meaningful.
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  let posted: { success?: boolean; message?: { _id?: unknown; id?: unknown }; reason?: string } | null = null;
  let postThrew = false;
  let thrownRefusal: string | null = null;
  try {
    posted = await AgentMessageService.postMessage({
    agentName,
    instanceId,
    displayName,
    podId: String(podId),
    messageType: 'card',
    // Server-set (F180): the broker's card is exempt from the duplicate guard
    // and the consecutive-run cap. Only a `tool_call` gets it: agents reach
    // proposeAction directly (propose-action route, commonly_propose_action,
    // connect auto-propose) with their own summary text, and cannot build a
    // tool_call (the envelope check above refuses one without `toolCall` and
    // `agentUserId`, which none of those paths pass).
    approvalCard: actionType === 'tool_call',
    payload: buildCardPayload(row),
    runId: options.runId,
    runPodId: options.runPodId,
    content: `[approval needed] ${trimmedSummary}`,
    metadata: { source: 'approval-card', approvalId: String(row._id) },
    installationConfig,
    noOutboundRelay,
    // A card is not a summary. `postMessage` otherwise runs every message
    // through `persistSummaryFromAgentMessage`, and once propose-action opened
    // an HTTP entry point CodeQL flagged the resulting flow into that path's
    // Mongo query (js/sql-injection, agentMessageService:775).
    //
    // The flow is unreachable in practice — `extractStructuredSummary` reads
    // `eventId` from METADATA, which is server-built here, and its content
    // parser returns null unless the text starts with `[BOT_MESSAGE]` while
    // ours starts with `[approval needed]`. But "unreachable today" is a
    // property of two guards in another service that nothing obliges to stay
    // put, and this is a consent surface reachable by any agent token. Not
    // running summary extraction on a card is correct on its own terms and
    // removes the question.
    skipSummaryPersistence: true,
    });
  } catch (error) {
    postThrew = true;
    // A thrown 4xx (pod_not_found, dm_membership_refused) is a refusal that
    // will repeat, not a store failure (F180).
    const thrown = error as Error & { code?: string; statusCode?: number };
    const status = Number(thrown?.statusCode);
    if (status >= 400 && status < 500) thrownRefusal = String(thrown.code || `http_${status}`);
    console.warn('[approval] card post failed:', thrown?.message);
  }

  if (!posted?.success || !posted?.message) {
    // Card without a render is a dead flag — mark it moot rather than leave
    // a phantom pending approval nothing can see. (ADR-017: moot is never a
    // default decision branch — this is a delivery failure, not a decision.)
    if (actionType === 'tool_call') {
      await ApprovalAction.updateOne(
        { _id: row._id, status: 'flagged' },
        { $set: { status: 'moot' }, $unset: { 'toolCall.canonicalArgs': 1 } },
      );
      row.status = 'moot';
      if (row.toolCall) delete row.toolCall.canonicalArgs;
    } else {
      row.status = 'moot';
      await row.save();
    }
    // A store failure may clear on retry; a refusal (or a skip) will not, so
    // it gets its own code and the message service's reason (F180).
    if (postThrew && !thrownRefusal) {
      return { ok: false, error: 'card message could not be posted', code: 'approval_unavailable' };
    }
    const reason = thrownRefusal
      || String(posted?.reason || (posted?.success ? 'not_posted' : 'refused'));
    return {
      ok: false,
      error: `approval card was not posted (${reason})`,
      code: 'approval_card_refused',
      reason,
    };
  }

  const messageId = String(posted.message._id || posted.message.id || '');
  row.messageId = messageId;
  if (actionType === 'tool_call') {
    // Guarded (F184): if the cardless sweep closed the row while the card was
    // posting, a plain save would attach the card to a closed row and leave
    // the posted card reading as pending. The row stays closed; the card is
    // rewritten from the closed row so it shows that, and the call did not
    // park. Legacy action rows are not swept, so they keep the plain save.
    const attached = await ApprovalAction.updateOne(
      { _id: row._id, status: 'flagged' },
      { $set: { messageId } },
    );
    if (attached && attached.matchedCount === 0) {
      const closed = await ApprovalAction.findById(row._id);
      if (closed) {
        closed.messageId = messageId;
        await updateCardEverywhere(closed);
      }
      return {
        ok: false,
        code: 'approval_unavailable',
        error: 'the approval closed before its card was posted; nothing ran',
      };
    }
  } else {
    await row.save();
  }
  // The card in the room is not enough: the inbox is where "what needs you"
  // lives, and its count is the ledger (#1650). Advisory — a projection
  // failure never turns a posted proposal into an error for the agent.
  // eslint-disable-next-line global-require
  const { recordActionApproval } = require('./attentionItemService');
  await recordActionApproval(row, displayName);
  return { ok: true, approvalId: String(row._id), messageId };
};

// ── resolution ──────────────────────────────────────────────────────────────

interface ResolveOptions {
  approvalId: string;
  callerUserId: string;
  decision: 'approved' | 'declined';
}

export interface ResolveResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Re-render the card wherever it lives. Writing the same payload twice is
 * harmless. `strict` rethrows a failed payload write so the sweep's retry
 * (F202) can try again; the socket push stays best-effort either way.
 */
const updateCardEverywhere = async (
  row: IApprovalAction,
  { strict = false }: { strict?: boolean } = {},
): Promise<void> => {
  const payload = buildCardPayload(row);
  const messageId = row.messageId;
  if (messageId) {
    try {
      if (process.env.PG_HOST && /^\d+$/.test(messageId)) {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const PGMessage = require('../models/pg/Message');
        await PGMessage.updatePayload(messageId, payload);
      } else {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const MongoMessage = require('../models/Message');
        await MongoMessage.updateOne({ _id: messageId }, { $set: { payload } });
      }
    } catch (err) {
      console.warn('[approval] card message payload update failed:', (err as Error).message);
      if (strict) throw err;
    }
  }
  // Same shape discipline as emitReactionChange: fire-and-forget, never fatal.
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const socketConfig = require('../config/socket');
    const io = socketConfig.getIO();
    if (io && messageId) {
      io.to(`pod_${String(row.podId)}`).emit('messageCardUpdated', {
        messageId: String(messageId),
        podId: String(row.podId),
        payload,
      });
    }
  } catch (err) {
    console.warn('[approval] socket emit failed:', (err as Error).message);
  }
};

/**
 * The trail id of an approval's own decision row, derived from the approval
 * and the reason (F202). An approval decides once per reason, so a second
 * write of the same decision (an expiry retried after a crash) hits the
 * table's primary key instead of adding a second row. UUID-shaped, so it
 * reads like every other `tool_call_` id.
 */
const decisionCallId = (approvalId: string, reason: string): string => {
  const hex = createHash('sha256').update(`approval-decision:${approvalId}:${reason}`).digest('hex');
  const uuid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)];
  return `tool_call_${uuid.join('-')}`;
};

/**
 * A broker code as the card, receipt and wake may show it. Anything that is not
 * a plain code could be vendor prose, so it never leaves the trail.
 */
const safeToolCallCode = (code: unknown): string => (
  typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'broker_error'
);

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string })?.code === '23505';

/**
 * Write the trail row a closing approval owes. The call id defaults to the
 * derived decision id; `brokerRow` is the row the broker ran the call under but
 * could not write. Safe to repeat either way: a second write hits the primary
 * key.
 */
const recordToolCallDecision = async (
  row: IApprovalAction,
  outcome: 'ok' | 'refused' | 'failed',
  reason: string | undefined,
  brokerRow?: { callId?: string; at?: Date } & IApprovalAction['toolCallTrailUnwritten'],
): Promise<string | undefined> => {
  const { toolCall } = row;
  if (!toolCall) return undefined;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const ToolCall = require('../models/ToolCall');
  const { digestArgs } = ToolCall;
  const callId = brokerRow?.callId || decisionCallId(String(row._id), String(reason));
  try {
    await ToolCall.create({
      podId: String(row.podId),
      credentialOwnerId: toolCall.credentialOwnerId,
      ...brokerRow,
      callId,
      grantId: toolCall.grantId,
      agentUserId: row.agentUserId || '',
      tool: toolCall.tool,
      argsDigest: toolCall.argsDigest || digestArgs({}),
      outcome,
      reason,
      approvalId: String(row._id),
    });
  } catch (error) {
    // Already written by an earlier attempt at this same decision.
    if (!isUniqueViolation(error)) throw error;
  }
  return callId;
};

/**
 * What happened, in one line the proposing agent can act on. The create_pod
 * success cue includes the exact reply so Scout cannot paraphrase the next step.
 */
const describeApprovedOutcome = (row: IApprovalAction): string => {
  if (row.executionError) {
    const error = String(row.executionError).slice(0, 300);
    return `But the action failed: ${error}. Tell them plainly and suggest what to try next.`;
  }
  const result = (row.executionResult || {}) as Record<string, unknown>;
  if (row.actionType === 'connect_local_agent') {
    const seat = String(result.agentName || (row.params as { name?: string } | undefined)?.name || '');
    const path = String(result.connectPath || '');
    const which = result.alreadyInstalled ? 'The seat' : 'The new seat';
    return `${which} "${seat}" exists, and the card now links to its connect page${path ? ` (${path})` : ''}. `
      + 'That page issues its token and shows the commands that connect their agent to it.';
  }
  if (row.actionType === 'create_pod') {
    const params = (row.params || {}) as { locale?: string };
    const locale = params.locale === 'zh-CN' || /\p{Script=Han}/u.test(row.summary || '') ? 'zh-CN' : 'en';
    const podName = String(result.podName || '');
    const joinNote = result.agentJoinError
      ? ` You could not be added to it: ${String(result.agentJoinError).slice(0, 200)}.`
      : '';
    const stepsNote = result.nextStepsPosted
      ? ` Reply with exactly this one line: ${locale === 'zh-CN'
        ? `${podName} 已建好。打开它，回答一个问题，就能拿到第一个任务。`
        : `${podName} is ready. Open it and answer one question to get your first task.`}`
      : '';
    const pod = `The pod "${podName}" now exists (${String(result.podId || '')}).`;
    return `${pod}${joinNote}${stepsNote}`;
  }
  return 'The action ran.';
};

/**
 * Tell the agent that proposed an action that a human approved it (#2160).
 * Without this the proposer never learns the human did what it asked, so the
 * next step never arrives: Scout proposed a seat, the user approved it, and
 * the room went quiet (fresh-signup acceptance run, 2026-10-14).
 *
 * Same shape as `decision.ruled`: a typed turn for the requester, enqueued
 * directly rather than through the ambient wake policy, because the human
 * acted on the agent's own request. `payload.content` carries the cue, which
 * the native runtime uses verbatim. The CLI wrapper does not know this type
 * yet and acks it as a no-op, so wrapper seats spend nothing until it learns it.
 *
 * Approve only: a decline needs no follow-up, and a turn spent on one invites a
 * re-ask. Parked tool calls are excluded: what their results tell the agent
 * belongs to the broker's contract, not this cue. Never fatal: the decision is
 * already durable, and a lost wake must not turn a 200 into a 500.
 */
const enqueueApprovalResolvedEvent = async (
  row: IApprovalAction,
  approvedBy: { userId: string; username: string },
): Promise<void> => {
  if (!row.agentName) return;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentEventService = require('./agentEventService');
    const summary = String(row.summary || row.actionType).trim().slice(0, 200);
    const exactPodReply = row.actionType === 'create_pod'
      && !row.executionError
      && Boolean((row.executionResult as { nextStepsPosted?: boolean } | undefined)?.nextStepsPosted);
    const content = [
      '[Your proposal was approved]',
      `${approvedBy.username} approved your proposal: ${summary}`,
      describeApprovedOutcome(row),
      '',
      exactPodReply
        ? 'Use only the exact line above. Do not add another question or repeat the card.'
        : 'Reply to them with the one next step, in a sentence or two. Do not repeat the card. '
          + 'Return NO_REPLY only if nothing is left for them to do.',
    ].join('\n');
    await AgentEventService.enqueue({
      agentName: String(row.agentName),
      instanceId: String(row.instanceId || 'default'),
      podId: String(row.podId),
      type: 'approval.resolved',
      payload: {
        approvalId: String(row._id),
        actionType: row.actionType,
        decision: 'approved',
        approvedBy,
        resolvedAt: (row.resolvedAt ? new Date(row.resolvedAt) : new Date()).toISOString(),
        podId: String(row.podId),
        content,
      },
    });
  } catch (err) {
    console.warn('[approval] proposer wake failed:', (err as Error).message);
  }
};

/**
 * Parked calls report only broker facts, never vendor result or error prose.
 *
 * Skips the wake when this approval's `approval.resolved` event already exists
 * for the seat, so a retry never wakes a run twice, and throws on a failed
 * enqueue so the retry runs.
 */
const enqueueToolCallResolvedEvent = async (
  row: IApprovalAction,
  approver?: { userId: string; username: string },
): Promise<void> => {
  if (!row.agentName || !row.toolCallEnding) return;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentEvent = require('../models/AgentEvent');
  const sent = await AgentEvent.exists({
    agentName: String(row.agentName).toLowerCase(),
    instanceId: String(row.instanceId || 'default'),
    podId: row.podId,
    type: 'approval.resolved',
    'payload.approvalId': String(row._id),
  });
  if (sent) return;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentEventService = require('./agentEventService');
  const tool = String(row.toolCall?.tool || 'the parked tool');
  const receipt = row.toolCallReceipt;
  const runIds = Array.from(new Set([
    ...(row.runId ? [String(row.runId)] : []),
    ...(row.waitingRuns || []).map((run) => String(run.runId)),
  ]));
  const content = [
    '[Parked tool call resolved]',
    `${tool}: ${row.toolCallEnding}${row.toolCallCode ? ` (${row.toolCallCode})` : ''}.`,
    ...(approver ? [`Decided by ${approver.username}.`] : []),
    ...(receipt ? [`Receipt: ${JSON.stringify(receipt)}`] : []),
    ...(row.toolCallCode === APPROVAL_OUTCOME_UNKNOWN
      ? ['This call may have run. Check the result before asking again.'] : []),
  ].join('\n');
  await AgentEventService.enqueue({
    agentName: String(row.agentName),
    instanceId: String(row.instanceId || 'default'),
    podId: String(row.podId),
    type: 'approval.resolved',
    payload: {
      approvalId: String(row._id),
      actionType: 'tool_call',
      decision: row.decision,
      ending: row.toolCallEnding,
      code: row.toolCallCode,
      callId: row.toolCallTrailId,
      // Every run whose call this decides (F184): the run that posted the
      // card and any later run an identical call parked on it.
      ...(runIds.length ? { runIds } : {}),
      ...(approver ? { approvedBy: approver } : {}),
      ...(receipt ? { receipt } : {}),
      resolvedAt: (row.resolvedAt ? new Date(row.resolvedAt) : new Date()).toISOString(),
      podId: String(row.podId),
      content,
    },
  });
};

/** Throws on a failed post so the sweep's retry runs. */
const postToolCallRoomReceipt = async (row: IApprovalAction, approverName: string): Promise<void> => {
  if (!row.toolCallEnding || !row.toolCall) return;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  const ending = row.toolCallCode === APPROVAL_OUTCOME_UNKNOWN
    ? `outcome unknown. ${OUTCOME_UNKNOWN_SENTENCE}`
    : `${row.toolCallEnding}${row.toolCallCode ? ` (${row.toolCallCode})` : ''}`;
  const content = `${approverName} approved ${row.agentName}'s ${row.toolCall.tool} · ${ending}`;
  const metadata = { source: 'approval-tool-call', approvalId: String(row._id) };
  if (typeof AgentMessageService._postToTarget === 'function' && row.agentUserId) {
    const agentUser = await User.findById(row.agentUserId);
    if (!agentUser) throw new Error('approved agent identity not found');
    await AgentMessageService._postToTarget({
      agentName: row.agentName,
      instanceId: row.instanceId || 'default',
      podId: String(row.podId),
      messageType: 'system', content, metadata, agentUser,
      skipDeliveryUpdate: true, skipSummaryPersistence: true,
    });
  } else {
    await AgentMessageService.postMessage({
      agentName: row.agentName,
      instanceId: row.instanceId || 'default',
      podId: String(row.podId),
      messageType: 'system', content, metadata, skipSummaryPersistence: true,
    });
  }
};

export const resolveApproval = async (options: ResolveOptions): Promise<ResolveResult> => {
  const { approvalId, callerUserId, decision } = options;

  const row = await ApprovalAction.findById(approvalId);
  if (!row) return { status: 404, body: { error: 'Approval not found' } };

  if (String(row.ownerUserId) !== String(callerUserId)) {
    // A parked call's owner is the connection owner (ADR-033 D5), not the
    // workspace owner that legacy action cards ask.
    const owner = row.actionType === 'tool_call' ? 'credential owner' : 'workspace owner';
    return { status: 403, body: { error: `Only the ${owner} can decide this` } };
  }
  // ADR-017 §Decision-authorization: no agent may decide, even one holding
  // the owner's pod. Route-level auth already excludes agent tokens; this is
  // defense in depth against a future dualAuth slip.
  const caller = await User.findById(callerUserId)
    .select('isBot username displayName')
    .lean() as { isBot?: boolean; username?: string; displayName?: string } | null;
  if (!caller || caller.isBot) {
    return { status: 403, body: { error: 'Only a human can decide an approval' } };
  }

  if (row.status !== 'flagged') {
    // Idempotent from the client's view: the authoritative state comes back,
    // but nothing re-executes.
    return {
      status: 409,
      body: { error: `Already ${row.status}`, approval: buildCardPayload(row) },
    };
  }

  // Copy the envelope before the terminal write. Some test doubles (and a
  // future ODM optimisation) may share nested object references between the
  // initial read and findOneAndUpdate's returned document; scrubbing the
  // returned row must never erase the private args the winner is about to
  // execute.
  const parkedCall = row.actionType === 'tool_call' && row.toolCall
    ? {
      ...row.toolCall,
      canonicalArgs: row.toolCall.canonicalArgs === undefined
        ? undefined
        : JSON.parse(JSON.stringify(row.toolCall.canonicalArgs)),
    }
    : undefined;
  // Unlike legacy action cards, a parked broker call expires closed. Check in
  // the decide path itself so a decision racing the sweeper cannot execute a
  // stale call or leave its canonical arguments behind.
  if (parkedCall && row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    const expired = await ApprovalAction.findOneAndUpdate(
      { _id: row._id, status: 'flagged' },
      {
        $set: {
          status: 'expired', resolvedAt: new Date(),
          decidedBy: 'policy', decidedByRole: 'policy',
          toolCallEnding: 'expired', toolCallCode: 'approval_expired',
          expiryRetryCount: 0,
        },
        $unset: { 'toolCall.canonicalArgs': 1 },
      },
      { new: true },
    );
    if (!expired) {
      const current = await ApprovalAction.findById(approvalId);
      return { status: 409, body: { error: 'Already decided', approval: current ? buildCardPayload(current) : null } };
    }
    if (expired.toolCall) expired.toolCall.canonicalArgs = undefined;
    await finishToolCallClosureOrLeaveForRetry(expired, 'expired');
    return { status: 409, body: { error: 'expired', approval: buildCardPayload(expired) } };
  }

  // ADR-017:201 — expired stays DECIDABLE. Refusing a late decision would
  // convert fail-closed into fail-silent: the owner's explicit intent
  // dropped because a timer won. `expiresAt` is advisory age the card
  // renders as a warning; a decision past it is honored and stamped
  // `decidedAfterExpiry` so the audit record carries the staleness fact.
  // (ADR-020's original no-op-on-expiry contradicted the ADR it implements
  // — caught by pod-architect in the 2026-08-13 fleet review.)
  const decidedAfterExpiry = !!(row.expiresAt && row.expiresAt.getTime() < Date.now());

  // Atomic transition — the status filter makes a concurrent double-resolve
  // lose cleanly instead of double-executing.
  const transitioned = await ApprovalAction.findOneAndUpdate(
    { _id: row._id, status: 'flagged' },
    {
      $set: {
        status: 'resolved',
        decision,
        resolvedBy: callerUserId,
        resolvedAt: new Date(),
        // The owner check above makes the caller the connection owner.
        ...(parkedCall ? { decidedBy: String(callerUserId), decidedByRole: 'credential-owner' } : {}),
        ...(parkedCall && decision === 'declined'
          ? { toolCallEnding: 'declined', toolCallCode: 'approval_declined' } : {}),
        // Opts the row into the sweep's retry (F202), in the write that closes it.
        ...(parkedCall ? { expiryRetryCount: 0 } : {}),
        ...(decidedAfterExpiry ? { decidedAfterExpiry: true } : {}),
      },
      ...(parkedCall ? { $unset: { 'toolCall.canonicalArgs': 1 } } : {}),
    },
    { new: true },
  );
  if (!transitioned) {
    const current = await ApprovalAction.findById(approvalId);
    return {
      status: 409,
      body: { error: 'Already decided', approval: current ? buildCardPayload(current) : null },
    };
  }
  if (parkedCall && transitioned.toolCall) transitioned.toolCall.canonicalArgs = undefined;
  // The ask is answered either way; the inbox row leaves with it.
  // eslint-disable-next-line global-require
  const { resolve: resolveAttention } = require('./attentionItemService');
  await resolveAttention('approval_action', transitioned._id);

  const approverName = caller.displayName?.trim() || caller.username?.trim();
  if (decision === 'approved') {
    try {
      // Keep a private in-memory copy captured before the terminal write. The
      // database copy is scrubbed atomically, so no later reader can recover
      // the raw arguments; only this winning resolver can execute them. That
      // is also why no retry can run the call again: this line is the only
      // caller, it runs once for the write above, and the arguments are gone.
      const result = parkedCall
        ? await executeApprovedToolCall(parkedCall, String(row._id), String(row.agentUserId || ''), {
          agentName: row.agentName ? String(row.agentName) : undefined,
          instanceId: row.instanceId ? String(row.instanceId) : undefined,
        })
        : await executeAction(transitioned);
      transitioned.executedAt = new Date();
      if (parkedCall) {
        const call = result as Awaited<ReturnType<typeof executeApprovedToolCall>>;
        transitioned.toolCallEnding = call.outcome === 'ok' ? 'ran' : 'failed';
        transitioned.toolCallCode = call.outcome === 'failed' ? 'upstream_tool_error' : undefined;
        transitioned.toolCallTrailId = call.callId;
        if (call.receipt) transitioned.toolCallReceipt = call.receipt;
        if (call.trailUnwritten) transitioned.toolCallTrailUnwritten = call.trailUnwritten;
      } else {
        transitioned.executionResult = result;
      }
    } catch (err) {
      // The decision stands. A broker failure carries its trailed code and id;
      // neither the vendor's error prose nor the arguments enter the card.
      if (parkedCall) {
        const failure = err as { code?: string; details?: { callId?: string; outcome?: string; recorded?: boolean } };
        const brokerRecord = failure.details?.recorded === true;
        // With no trail row from the broker, the one code it can still hand
        // over is that the call may have run.
        const unrecorded = failure.code === APPROVAL_OUTCOME_UNKNOWN ? APPROVAL_OUTCOME_UNKNOWN : 'broker_error';
        transitioned.toolCallEnding = brokerRecord && failure.details?.outcome === 'refused' ? 'refused' : 'failed';
        transitioned.toolCallCode = brokerRecord ? safeToolCallCode(failure.code) : unrecorded;
        // The trail step writes the derived row (`selfTrailedReason`).
        transitioned.toolCallTrailId = (brokerRecord && failure.details?.callId)
          || decisionCallId(String(transitioned._id), unrecorded);
      } else {
        transitioned.executionError = (err as Error).message?.slice(0, 500) || 'execution failed';
      }
    }
    if (parkedCall) {
      // A sweep that gave up on a slow call may have stored a code and a done
      // stamp this row never read. This save clears both: the real ending
      // replaces the guess, and the closure below stays retryable.
      transitioned.markModified?.('toolCallCode');
      transitioned.markModified?.('expirySideEffectsDoneAt');
      // The durable marker: the call's ending, on the row, before anything
      // else. If this write fails the call still ran, so the side effects go
      // on from memory, the trail step's save tries it again, and otherwise
      // the sweep reads the ending from the trail (`settleApprovedCall`).
      try {
        await transitioned.save();
      } catch (error) {
        console.error(`[approval] tool-call ending not saved approval=${String(transitioned._id)}; `
          + 'the sweep recovers it from the trail:', (error as Error).message);
      }
    } else {
      await transitioned.save();
    }
  }
  if (parkedCall) {
    const username = approverName || 'The workspace owner';
    await finishToolCallClosureOrLeaveForRetry(transitioned, decision, {
      approver: { userId: String(callerUserId), username },
      receiptName: approverName || String(callerUserId),
    });
    return { status: 200, body: { ok: true, approval: buildCardPayload(transitioned) } };
  }

  await updateCardEverywhere(transitioned);
  if (decision === 'approved') {
    await enqueueApprovalResolvedEvent(transitioned, {
      userId: String(callerUserId),
      username: approverName || 'The workspace owner',
    });
  }
  return { status: 200, body: { ok: true, approval: buildCardPayload(transitioned) } };
};

const executeApprovedToolCall = async (
  toolCall: ApprovalToolCall,
  approvalId: string,
  agentUserId: string,
  caller: { agentName?: string; instanceId?: string } = {},
): Promise<{
  result: unknown;
  callId: string;
  outcome: 'ok' | 'failed';
  receipt?: Record<string, number>;
  trailUnwritten?: IApprovalAction['toolCallTrailUnwritten'];
}> => {
  if (!toolCall.canonicalArgs) throw new Error('approval arguments unavailable');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  // Share the broker's argument type so a new required binding cannot be
  // forgotten by this approval-side call site.
  const broker = require('./toolBrokerService') as typeof import('./toolBrokerService');
  const response = await broker.executeApprovedToolCall({
    grantId: toolCall.grantId,
    agentUserId,
    tool: toolCall.tool,
    args: toolCall.canonicalArgs,
    expectedArgsDigest: toolCall.argsDigest,
    expectedDefinitionDigest: toolCall.definitionDigest,
    approvalId,
    callerConfinement: toolCall.callerConfinement,
    agentName: caller.agentName,
    instanceId: caller.instanceId,
  });
  return response;
};

/**
 * F202: the first wait before a closed row is retried, and the base of the
 * backoff. A live close finishes its side effects in well under a second.
 */
export const EXPIRY_RETRY_GRACE_MS = 60 * 1000;
/** F202: the longest wait between two retries of one row. */
export const EXPIRY_RETRY_MAX_DELAY_MS = 60 * 60 * 1000;
/**
 * How long an approved call with no ending may take before the sweep treats its
 * process as dead. Every provider request on the broker path has its own bound
 * (GitHub REST and hosted MCP 30 seconds, git 45). A commit is about ten of
 * them; the slowest path is `pushSeatBranch`, about 20 git steps of which about
 * seven touch the network, so a live call ends well inside this. What can outlast it is a stalled
 * event loop or a paused process; that call still saves its real ending over
 * the unknown one, but the wake, the receipt, the Record line and the sweep's
 * trail row stay as they were.
 */
export const APPROVED_CALL_SETTLE_MS = 15 * 60 * 1000;
/**
 * F202: retries per closed row before the sweep stops and logs it as stuck.
 * With the backoff (1, 2, 4, 8, 16, 32 minutes, then hourly) eleven retries
 * span about six hours. A row at the cap is put back by
 * `scripts/retry-capped-approval-expiries.ts`.
 */
export const MAX_EXPIRY_RETRIES = 11;

/**
 * When an incomplete closed row may next be retried: its last attempt (the
 * flip, or the latest retry claim) plus `grace * 2^retries`, at most an hour.
 * The wait is also the lease: a sweeper before it neither selects nor claims
 * the row. An approved call with no ending may still be running, so it also
 * waits out APPROVED_CALL_SETTLE_MS.
 */
export const expiryRetryDueAt = (row: {
  resolvedAt?: Date | null; expiryRetryClaimedAt?: Date | null; expiryRetryCount?: number | null;
  status?: string | null; decision?: string | null; toolCallEnding?: string | null;
}): Date => {
  const last = Math.max(
    row.resolvedAt ? new Date(row.resolvedAt).getTime() : 0,
    row.expiryRetryClaimedAt ? new Date(row.expiryRetryClaimedAt).getTime() : 0,
  );
  const delay = Math.min(EXPIRY_RETRY_GRACE_MS * 2 ** Number(row.expiryRetryCount || 0), EXPIRY_RETRY_MAX_DELAY_MS);
  const unsettled = row.status === 'resolved' && row.decision === 'approved' && !row.toolCallEnding;
  const settled = unsettled && row.resolvedAt ? new Date(row.resolvedAt).getTime() + APPROVED_CALL_SETTLE_MS : 0;
  return new Date(Math.max(last + delay, settled));
};

/** F202: how long one attempt's claim on a leased send holds before another may send it. */
export const EXPIRY_WAKE_CLAIM_LEASE_MS = 2 * 60 * 1000;

/** The stamp and lease fields of one send that must land at least once. */
const WAKE_SEND = { name: 'wake', sent: 'expiryEventSentAt', claimed: 'expiryEventClaimedAt' } as const;
const RECEIPT_SEND = { name: 'receipt', sent: 'toolCallReceiptPostedAt', claimed: 'toolCallReceiptClaimedAt' } as const;

/**
 * A send that must land at least once. An attempt first takes a lease on it
 * (`claimed`, only while unsent and unclaimed or claimed more than
 * EXPIRY_WAKE_CLAIM_LEASE_MS ago), then sends, then stamps `sent`. A failed
 * send clears the lease, only if it is still this attempt's. A crash after the
 * claim leaves a lease that expires, so a later retry sends. While another
 * attempt holds a fresh lease this one throws, so the row stays incomplete
 * until the send is known done.
 *
 * A crash after the send but before the stamp sends again, unless the send
 * checks for itself: the wake finds its `AgentEvent` row, and past that row's
 * retention the run can be woken twice. The room receipt has no such check, so
 * that crash can post a second receipt line. A duplicate there is the safe side
 * of a lost one.
 */
const sendUnderLease = async (
  row: IApprovalAction,
  fields: typeof WAKE_SEND | typeof RECEIPT_SEND,
  send: () => Promise<void>,
): Promise<void> => {
  const { name, sent, claimed } = fields;
  const claimedAt = new Date();
  const won = await ApprovalAction.findOneAndUpdate(
    {
      _id: row._id,
      [sent]: null,
      $or: [
        { [claimed]: null },
        { [claimed]: { $lte: new Date(claimedAt.getTime() - EXPIRY_WAKE_CLAIM_LEASE_MS) } },
      ],
    },
    { $set: { [claimed]: claimedAt } },
  );
  if (!won) {
    const current = await ApprovalAction.findById(row._id).select(sent).lean() as
      Partial<Record<typeof sent, Date>> | null;
    if (current?.[sent]) return;
    throw new Error(`another attempt holds the ${name} claim`);
  }
  try {
    await send();
  } catch (error) {
    await ApprovalAction.updateOne(
      { _id: row._id, [claimed]: claimedAt },
      { $unset: { [claimed]: 1 } },
    );
    throw error;
  }
  await ApprovalAction.updateOne(
    { _id: row._id, [sent]: null },
    { $set: { [sent]: new Date() } },
  );
};

type ToolCallClosure = 'expired' | 'approved' | 'declined';
/** What the deciding request already knows; a retry reads it back from the row. */
type LiveDecider = { approver: { userId: string; username: string }; receiptName: string };

/** The person who decided, for a retry that has no request to read them from. */
export const deciderOf = async (row: Pick<IApprovalAction, 'resolvedBy'>): Promise<LiveDecider> => {
  const user = await User.findById(row.resolvedBy).select('username displayName').lean() as
    { username?: string; displayName?: string } | null;
  const name = user?.displayName?.trim() || user?.username?.trim();
  return {
    approver: { userId: String(row.resolvedBy), username: name || 'The workspace owner' },
    // Never the raw id: this goes into chat text.
    receiptName: name || 'The workspace owner',
  };
};

/**
 * The reason of a trail row the approval writes itself, read off the derived
 * id. Undefined means the broker wrote (or owes) the row.
 */
const selfTrailedReason = (row: IApprovalAction): string | undefined => [
  'broker_error', APPROVAL_OUTCOME_UNKNOWN,
].find((reason) => row.toolCallTrailId === decisionCallId(String(row._id), reason));

const writeApprovedCallTrail = async (row: IApprovalAction): Promise<void> => {
  const reason = selfTrailedReason(row);
  if (reason) {
    await recordToolCallDecision(row, 'failed', reason);
  } else if (row.toolCallTrailUnwritten) {
    await recordToolCallDecision(row, row.toolCallEnding === 'ran' ? 'ok' : 'failed', row.toolCallCode, {
      ...row.toolCallTrailUnwritten, callId: row.toolCallTrailId, at: row.executedAt,
    });
    row.toolCallTrailUnwritten = undefined;
  }
};

/**
 * Everything a parked call owes once its row has closed: the inbox item, the
 * trail and stored ending, the record, the room receipt (approved only), the
 * wake to every parked run, and the card. Each step is safe to repeat (F202):
 * a trail id derives from the approval or is the broker's, the record dedupes
 * on its event key, the wake and receipt are leased on the row and stamped once
 * sent, and the card rewrites the same payload. The steps run independently, so
 * a failing card never holds back the wake the parked runs wait on. The marker
 * is written only when all of them succeeded; otherwise this throws one error
 * naming every failure, and the sweep retries the row.
 *
 * Nothing here runs the tool call. An approved call's ending is on the row
 * before this starts.
 */
const completeToolCallClosure = async (
  row: IApprovalAction,
  closure: ToolCallClosure,
  live?: LiveDecider,
): Promise<void> => {
  // The deciding request cleared the inbox item before it ran the call.
  if (!live) {
    // eslint-disable-next-line global-require
    const { resolve: resolveAttention } = require('./attentionItemService');
    await resolveAttention('approval_action', row._id);
  }
  const refusal = { expired: 'approval_expired', declined: 'approval_declined', approved: null }[closure];
  if (refusal) {
    row.toolCallEnding = closure === 'expired' ? 'expired' : 'declined';
    row.toolCallCode = refusal;
    // Derived, so the wake and the card can name the trail row even when its
    // write fails here and lands on a retry.
    row.toolCallTrailId = row.toolCall ? decisionCallId(String(row._id), refusal) : undefined;
  }
  const failures: Array<{ step: string; error: unknown }> = [];
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push({ step: name, error });
    }
  };
  let decider = live;
  const theDecider = async (): Promise<LiveDecider> => {
    if (!decider) decider = await deciderOf(row);
    return decider;
  };
  await step('trail', async () => {
    if (refusal) await recordToolCallDecision(row, 'refused', refusal);
    else await writeApprovedCallTrail(row);
    await row.save();
    recordApprovalOutcome(row, row.toolCall, { kind: closure });
  });
  if (closure === 'approved') {
    await step('receipt', () => sendUnderLease(row, RECEIPT_SEND, async () => {
      await postToolCallRoomReceipt(row, (await theDecider()).receiptName);
    }));
  }
  await step('wake', () => sendUnderLease(row, WAKE_SEND, async () => {
    await enqueueToolCallResolvedEvent(row, closure === 'expired' ? undefined : (await theDecider()).approver);
  }));
  await step('card', async () => {
    // A live ending may have landed while a retry ran. The card shows the row
    // as stored, never this attempt's copy.
    const current = closure === 'approved' && !live ? await ApprovalAction.findById(row._id) : null;
    await updateCardEverywhere(current || row, { strict: true });
  });
  if (failures.length) {
    throw new AggregateError(failures.map((f) => f.error), `${closure} steps failed: ${failures
      .map((f) => `${f.step} (${(f.error as Error)?.message || String(f.error)})`).join('; ')}`);
  }
  // A live save clears the stamp to keep its own closure retryable, so a stamp
  // only lands on the ending this attempt closed on. Two endings can share a
  // word; the trail id tells them apart.
  await ApprovalAction.updateOne(
    { _id: row._id, toolCallEnding: row.toolCallEnding, toolCallTrailId: row.toolCallTrailId },
    { $set: { expirySideEffectsDoneAt: new Date() } },
  );
};

/**
 * The row is already closed, which is the decision; a failed side effect must
 * not undo it or fail the caller. The sweep's retry picks the row up.
 */
const finishToolCallClosureOrLeaveForRetry = async (
  row: IApprovalAction,
  closure: ToolCallClosure,
  live?: LiveDecider,
): Promise<void> => {
  try {
    await completeToolCallClosure(row, closure, live);
  } catch (error) {
    console.warn(`[approval] ${closure} side effects failed approval=${String(row._id)}; the sweep retries:`,
      (error as Error).message);
  }
};

/**
 * Close one lapsed broker approval as `expired` (scrub, trail, outcome, card,
 * wake). False when it was no longer open: someone else closed it first.
 */
const expireToolCallApproval = async (
  row: { _id: unknown },
  now: Date,
): Promise<boolean> => {
  const result = await ApprovalAction.findOneAndUpdate(
    { _id: row._id, status: 'flagged' },
    {
      $set: {
        status: 'expired', resolvedAt: now,
        decidedBy: 'policy', decidedByRole: 'policy',
        toolCallEnding: 'expired', toolCallCode: 'approval_expired',
        expiryRetryCount: 0,
      },
      $unset: { 'toolCall.canonicalArgs': 1 },
    },
    { new: true },
  );
  if (!result) return false;
  if (result.toolCall) result.toolCall.canonicalArgs = undefined;
  await finishToolCallClosureOrLeaveForRetry(result, 'expired');
  return true;
};

/**
 * An approved call whose ending never reached the row: the process died after
 * the decision, or the marker write failed. The sweep has no arguments and no
 * way to run the call, so it only establishes what happened. The broker's trail
 * row is the answer when there is one. With no row the call may not have
 * started, or may have reached the provider and died before the trail write;
 * nothing can tell those apart, so the ending says it is unknown rather than
 * guessing, and the wake, receipt, card and Record all say so. A trail read that
 * fails settles nothing: it throws, and a later attempt reads again.
 *
 * The write applies only while the row has no ending, so it can't replace a
 * live one. Whoever loses carries on with the row as stored. Returns that row.
 */
const settleApprovedCall = async (row: IApprovalAction): Promise<IApprovalAction> => {
  if (row.toolCallEnding) return row;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const ToolCall = require('../models/ToolCall');
  const run = await ToolCall.findApprovedRun(String(row.toolCall?.grantId), String(row._id));
  // A provider that answered with an error still ran the call.
  const ran = run?.outcome === 'ok' || run?.reason === 'upstream_tool_error';
  let ending: Partial<IApprovalAction>;
  if (!run) {
    ending = {
      toolCallEnding: 'failed',
      toolCallCode: APPROVAL_OUTCOME_UNKNOWN,
      toolCallTrailId: decisionCallId(String(row._id), APPROVAL_OUTCOME_UNKNOWN),
    };
  } else {
    ending = {
      toolCallEnding: run.outcome === 'ok' ? 'ran' : (run.outcome === 'refused' ? 'refused' : 'failed'),
      ...(run.outcome === 'ok' ? {} : { toolCallCode: safeToolCallCode(run.reason) }),
      toolCallTrailId: run.callId,
      ...(ran ? { executedAt: run.at } : {}),
    };
  }
  const settled = await ApprovalAction.findOneAndUpdate(
    { _id: row._id, toolCallEnding: null },
    { $set: ending },
    { new: true },
  );
  if (settled) return settled;
  const current = await ApprovalAction.findById(row._id);
  if (!current) throw new Error('approval row is gone');
  return current;
};

/**
 * F202: re-run the side effects of closed rows that never finished (a crash or
 * a failed step after the closing write): expiries, declines and approvals.
 * Every other sweep selects `flagged`, so without this a parked run waits on
 * such a row forever. A row is due at `expiryRetryDueAt`, which backs off per
 * retry. Each attempt claims the row with one conditional write on the count
 * and the claim time it read, stamping a new `expiryRetryClaimedAt` and bumping
 * the count, so a second sweeper that read the same row loses the claim, and
 * one that reads it afterwards finds it not yet due. An attempt slower than its
 * wait can overlap the next one; every step is safe to repeat and the wake and
 * receipt have their own leases, so the overlap costs a repeated card write,
 * and a second send only when one stalls past its lease. The count caps the
 * retries, so a step that keeps failing stops being tried.
 */
const retryIncompleteToolCallClosures = async (now: Date): Promise<number> => {
  const incomplete = {
    status: { $in: ['expired', 'resolved'] },
    actionType: 'tool_call',
    expiryRetryCount: { $lt: MAX_EXPIRY_RETRIES },
    expirySideEffectsDoneAt: null,
  };
  // The first wait is the shortest, so nothing closed inside it can be due.
  const candidates = await ApprovalAction.find({
    ...incomplete, resolvedAt: { $lte: new Date(now.getTime() - EXPIRY_RETRY_GRACE_MS) },
  }).select('_id status decision toolCallEnding resolvedAt expiryRetryClaimedAt expiryRetryCount')
    .sort({ resolvedAt: 1 }).limit(500)
    .lean() as Array<{ _id: unknown; resolvedAt: Date; expiryRetryClaimedAt?: Date; expiryRetryCount: number }>;
  const rows = candidates.filter((one) => expiryRetryDueAt(one).getTime() <= now.getTime());
  let completed = 0;
  for (const one of rows) {
    // eslint-disable-next-line no-await-in-loop
    const claimed = await ApprovalAction.findOneAndUpdate(
      {
        ...incomplete,
        _id: one._id,
        expiryRetryCount: one.expiryRetryCount,
        expiryRetryClaimedAt: one.expiryRetryClaimedAt || null,
      },
      { $inc: { expiryRetryCount: 1 }, $set: { expiryRetryClaimedAt: now } },
      { new: true },
    );
    if (!claimed) continue;
    const closure = (claimed.status === 'expired' ? 'expired' : claimed.decision) as ToolCallClosure;
    try {
      // eslint-disable-next-line no-await-in-loop
      const settled = closure === 'approved' ? await settleApprovedCall(claimed) : claimed;
      // eslint-disable-next-line no-await-in-loop
      await completeToolCallClosure(settled, closure);
      completed += 1;
    } catch (error) {
      const attempts = Number(claimed.expiryRetryCount);
      const message = (error as Error).message;
      if (attempts >= MAX_EXPIRY_RETRIES) {
        console.error(`[approval] ${closure} side effects gave up approval=${String(claimed._id)} `
          + `after ${attempts} retries; its trail, receipt, card or wake may be missing. Once the cause is fixed, `
          + 'requeue it with backend/scripts/retry-capped-approval-expiries.ts --apply:', message);
      } else {
        console.warn(`[approval] ${closure} retry ${attempts} failed approval=${String(claimed._id)}:`, message);
      }
    }
  }
  return completed;
};

/** First-sweep hook for abandoned broker approvals, and F202's closure retry. */
export const sweepExpiredToolCallApprovals = async (now = new Date()): Promise<number> => {
  const rows = await ApprovalAction.find({
    actionType: 'tool_call',
    status: 'flagged',
    expiresAt: { $lte: now },
  });
  let expired = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await expireToolCallApproval(row, now)) expired += 1;
  }
  const retried = await retryIncompleteToolCallClosures(now);
  if (retried) console.log(`[approval] completed unfinished tool-call closures=${retried}`);
  return expired;
};

/**
 * How long an open broker approval may go without its card before the sweep
 * treats it as a crash between create and post (F184). proposeAction posts the
 * card right after the create, so minutes is far past any live post.
 */
export const CARDLESS_TOOL_CALL_GRACE_MS = 5 * 60 * 1000;

/**
 * F184: an open broker approval with no card is one whose process died between
 * the create and the post. Nobody can see or decide it, yet it holds one of
 * the seat's open-card slots and its call's identity for its whole deadline.
 * Mark it moot, as proposeAction does for a card that fails to post, which
 * frees both. No one is waiting on it: a later identical call parks on an open
 * row only once its card exists, and is told to retry until then.
 */
export const sweepCardlessToolCallApprovals = async (
  now = new Date(),
  graceMs = CARDLESS_TOOL_CALL_GRACE_MS,
): Promise<number> => {
  const cardless = { $in: [null, ''] };
  const rows = await ApprovalAction.find({
    actionType: 'tool_call',
    status: 'flagged',
    messageId: cardless,
    createdAt: { $lte: new Date(now.getTime() - graceMs) },
  }).select('_id').lean() as Array<{ _id: unknown }>;
  let mooted = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const result = await ApprovalAction.updateOne(
      { _id: row._id, status: 'flagged', messageId: cardless },
      { $set: { status: 'moot' }, $unset: { 'toolCall.canonicalArgs': 1 } },
    );
    if (result.modifiedCount) mooted += 1;
  }
  return mooted;
};

// ── executors (D2: user authority owns the result) ──────────────────────────

const executeAction = async (row: IApprovalAction): Promise<unknown> => {
  if (row.actionType === 'create_pod') return executeCreatePod(row);
  if (row.actionType === 'connect_local_agent') return executeConnectLocalAgent(row);
  throw new Error(`no executor for actionType '${row.actionType}'`);
};

/**
 * connect_local_agent — create a self-serve BYO seat (ADR-006 shape) owned
 * by the workspace owner, then hand off to the connect page.
 *
 * D1 boundary, deliberately drawn: this executor creates the SEAT only —
 * the registry row and the installation. The runtime token is never minted
 * here. Credentials are a human-in-browser act on the connect page (which
 * force-rotates on issue), and chat payloads must never carry one — pod
 * history is readable by every member and mirrored to two stores.
 *
 * Kept in sync with the registry install route's self-serve branch
 * (routes/registry/install.ts): synthetic ephemeral manifest, #609
 * foreign-owner guard, webhook runtimeType. An existing ACTIVE install by
 * the same owner is SUCCESS, not failure — identity continuity, the same
 * "already installed → fall through to the connect page" behavior the BYO
 * page implements.
 */
const executeConnectLocalAgent = async (row: IApprovalAction): Promise<unknown> => {
  const params = (row.params || {}) as { name?: string; adapter?: string };
  const agentName = String(params.name || '').trim().toLowerCase();
  const adapter = LOCAL_AGENT_ADAPTERS.has(String(params.adapter)) ? String(params.adapter) : '';
  if (!LOCAL_AGENT_NAME_RE.test(agentName)) throw new Error('invalid agent name');
  // Re-checked at execution: a name can become reserved between propose and approve.
  const reserved = await reservedAgentNameRefusal(agentName);
  if (reserved) throw new Error(reserved.error);

  // Re-check the #609 guard at execution time — another user may have
  // claimed the name between propose and approve.
  if (await findForeignLocalAgentOwner(agentName, row.ownerUserId)) {
    throw new Error(`the agent name "${agentName}" is now in use by another user`);
  }

  // Approval runs later than proposal. Check the live pod boundary before
  // creating either the ephemeral registry row or the webhook installation.
  await assertAgentRuntimeMayJoinPod(row.podId, 'webhook');

  // from=card: the person already chose to connect their own agent, under
  // this name, into this pod, so the page asks none of that again (QA BYO
  // walk 2: 127 words before the button, most of them re-asking it).
  const connectPath = `/v2/agents/byo?pod=${encodeURIComponent(String(row.podId))}`
    + `&name=${encodeURIComponent(agentName)}&from=card${adapter ? `&adapter=${adapter}` : ''}`;

  const existing = await AgentInstallation.findOne({
    agentName,
    podId: row.podId,
    instanceId: 'default',
    status: 'active',
  });
  if (existing) {
    const ownedBySelf = String(existing.installedBy || '') === String(row.ownerUserId);
    if (!ownedBySelf) throw new Error(`the agent name "${agentName}" is already installed in this pod by another user`);
    return {
      agentName, podId: String(row.podId), connectPath, alreadyInstalled: true,
    };
  }

  // Ephemeral registry row (ADR-006 self-serve): synthesized when no
  // published manifest exists; excluded from the marketplace catalog.
  let registryRow = await AgentRegistry.getByName(agentName);
  if (registryRow && registryRow.status === 'unpublished') {
    throw new Error('this agent name belongs to an unpublished manifest');
  }
  if (!registryRow) {
    const synthManifest = {
      name: agentName,
      version: '1.0.0',
      description: 'A connected agent.',
      capabilities: [],
      context: { required: [], optional: [] },
      runtime: { type: 'standalone', connection: 'rest' },
    };
    registryRow = await AgentRegistry.create({
      agentName,
      displayName: agentName,
      description: synthManifest.description,
      manifest: synthManifest,
      latestVersion: synthManifest.version,
      versions: [{ version: synthManifest.version, manifest: synthManifest, publishedAt: new Date() }],
      registry: 'private',
      publisher: { userId: row.ownerUserId },
      ephemeral: true,
    });
  }

  await AgentInstallation.findOneAndUpdate(
    { agentName, podId: row.podId, instanceId: 'default' },
    {
      $set: {
        status: 'active',
        version: registryRow?.latestVersion || '1.0.0',
        displayName: agentName,
        scopes: LOCAL_AGENT_SCOPES,
        config: { runtime: { runtimeType: 'webhook', host: 'byo' } },
      },
      $setOnInsert: {
        agentName,
        podId: row.podId,
        instanceId: 'default',
        installedBy: row.ownerUserId,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
  console.log('[cap approval-install]', {
    owner: String(row.ownerUserId),
    pod: String(row.podId),
    agent: agentName,
    runtime: 'webhook',
  });

  return { agentName, podId: String(row.podId), connectPath };
};

/**
 * The first outside project signup stopped at a prompt to put a task on the
 * board. Scout now asks for one repo or workflow and the owner's answer
 * produces a server-composed task proposal with two actionable buttons.
 * Never fatal: the pod exists either way, and the proposer's reply still lands.
 */
export const NEW_POD_NEXT_STEPS_TEXT = 'Which GitHub repo or weekly workflow should we start with?';

const postNewPodNextSteps = async (
  row: IApprovalAction,
  podId: string,
  displayName: string | undefined,
): Promise<boolean> => {
  try {
    const params = (row.params || {}) as { locale?: string };
    const locale = params.locale === 'zh-CN' || /\p{Script=Han}/u.test(row.summary || '') ? 'zh-CN' : 'en';
    const href = `/v2/agents/byo?pod=${encodeURIComponent(podId)}`;
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentMessageService = require('./agentMessageService');
    await AgentMessageService.postMessage({
      agentName: String(row.agentName),
      instanceId: String(row.instanceId || 'default'),
      podId,
      displayName,
      content: locale === 'zh-CN'
        ? '先从哪个 GitHub 仓库或每周工作流程开始？'
        : NEW_POD_NEXT_STEPS_TEXT,
      payload: { kind: 'starts', starts: [{
        id: 'bring-your-own', label: locale === 'zh-CN' ? '接入自己的智能体' : 'Bring your own', href,
      }] },
    });
    await Pod.updateOne({ _id: podId }, { $set: { firstTaskOnboarding: {
      stage: 'awaiting-input', agentName: String(row.agentName),
      instanceId: String(row.instanceId || 'default'), displayName, locale,
    } } });
    return true;
  } catch (err) {
    console.warn('[approval] create_pod next steps not posted:', (err as Error).message);
    return false;
  }
};

const executeCreatePod = async (row: IApprovalAction): Promise<unknown> => {
  const params = (row.params || {}) as { name?: string; description?: string; type?: string };
  const name = String(params.name || '').trim();
  const type = CREATABLE_POD_TYPES.has(String(params.type)) ? String(params.type) : 'chat';

  // D2: the USER owns the pod. The proposing agent joins as a member — with
  // an installation, because membership without an AgentInstallation cannot
  // post (the runtime 403s).
  const pod = await Pod.create({
    name,
    description: String(params.description || '').slice(0, 300),
    type,
    joinPolicy: 'invite-only',
    createdBy: row.ownerUserId,
    members: [row.ownerUserId],
  });

  // PG mirror, FK-safe order (the 2026-07-24 lesson): user first, then pod.
  try {
    if (process.env.PG_HOST) {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const AgentIdentityService = require('./agentIdentityService');
      const ownerDoc = await User.findById(row.ownerUserId);
      if (ownerDoc) await AgentIdentityService.syncUserToPostgreSQL(ownerDoc);
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const { syncPodFromMongo } = require('./pgPodSyncService');
      await syncPodFromMongo(String(pod._id), String(row.ownerUserId));
    }
  } catch (pgErr) {
    console.warn('[approval] create_pod PG mirror failed:', (pgErr as Error).message);
  }

  // Bring the proposing agent along: clone its origin-pod installation shape
  // into the new pod, then add its bot user to members. A join failure must
  // NOT be swallowed into a clean "done" — the pod is real (user owns it),
  // but a membership-without-installation agent 403s on every post, so the
  // card must carry the partial truth (sprint-review finding, 2026-08-13:
  // execution is at-most-once, so a lied face here is unrecoverable).
  let agentJoined = false;
  let agentJoinError: string | undefined;
  let agentDisplayName: string | undefined;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentIdentityService = require('./agentIdentityService');
    const originInstall = await AgentInstallation.findOne({
      agentName: row.agentName,
      instanceId: row.instanceId || 'default',
      podId: row.podId,
      status: 'active',
    }).lean();
    // D8's opt-in is per installation. A delegated create_pod produces a
    // different installation, so inherit the capability config but not the
    // source pod's every-message wake setting; the new owner may opt in.
    agentDisplayName = originInstall?.displayName;
    const originConfig = originInstall?.config;
    const clonedConfig = originConfig instanceof Map
      ? Object.fromEntries(originConfig.entries())
      : {
        ...((originConfig && typeof originConfig === 'object') ? originConfig : {}),
      };
    delete clonedConfig.wakeOnMessage;
    await AgentInstallation.findOneAndUpdate(
      { agentName: row.agentName, podId: pod._id, instanceId: row.instanceId || 'default' },
      {
        $set: {
          status: 'active',
          version: originInstall?.version || '1.0.0',
          displayName: originInstall?.displayName,
          scopes: originInstall?.scopes || ['context:read', 'messages:write'],
          config: clonedConfig,
        },
        $setOnInsert: {
          agentName: row.agentName,
          podId: pod._id,
          instanceId: row.instanceId || 'default',
          installedBy: row.ownerUserId,
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    const svc = AgentIdentityService.default || AgentIdentityService;
    const botUser = await svc.getOrCreateAgentUser(row.agentName, {
      instanceId: row.instanceId || 'default',
      displayName: originInstall?.displayName,
    });
    if (botUser?._id) {
      await Pod.updateOne(
        { _id: pod._id, members: { $ne: botUser._id } },
        { $push: { members: botUser._id } },
      );
      // F183: best-effort PG mirror write; never fails the approval.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      await require('./pgMirrorWrite').mirrorMemberAdded(String(pod._id), String(botUser._id));
      agentJoined = true;
    } else {
      agentJoinError = 'agent identity could not be resolved';
    }
  } catch (agentErr) {
    agentJoinError = (agentErr as Error).message?.slice(0, 200) || 'agent join failed';
    console.warn('[approval] create_pod agent-join failed:', agentJoinError);
  }

  const nextStepsPosted = agentJoined
    ? await postNewPodNextSteps(row, String(pod._id), agentDisplayName)
    : false;

  return {
    podId: String(pod._id),
    podName: pod.name,
    podType: type,
    agentJoined,
    ...(agentJoinError ? { agentJoinError } : {}),
    nextStepsPosted,
  };
};

export default {
  proposeAction,
  resolveApproval,
  buildCardPayload,
  buildOwnerCardPayload,
  sweepExpiredToolCallApprovals,
};
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
