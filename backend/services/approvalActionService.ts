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
import ApprovalAction, { IApprovalAction, ApprovalActionType } from '../models/ApprovalAction';
import Pod from '../models/Pod';
import User from '../models/User';
import { resolveWakePolicy } from './wakePolicyService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');

const CARD_KIND = 'approval-card';

// Pod types an approved create_pod may mint. DM-shaped types are excluded for
// the same reason podController's DM guard exists: minting a 1:1-typed pod
// with arbitrary membership breaks the §3.10 invariant.
const CREATABLE_POD_TYPES = new Set(['chat', 'team']);

const KNOWN_ACTION_TYPES = new Set<ApprovalActionType>(['create_pod', 'connect_local_agent']);

// Same shape the registry install route enforces for self-serve names (no
// scoped @publisher/ names for local seats). Mirrors the BYO page's
// sanitizeAgentName output alphabet.
const LOCAL_AGENT_NAME_RE = /^[a-z0-9-]{2,40}$/;

// Scopes the BYO connect page grants a self-serve seat (V2AgentBYO
// DEFAULT_SCOPES) — the approved seat must be interchangeable with a
// hand-connected one, or the connect page's token step behaves differently
// depending on who created the seat.
const LOCAL_AGENT_SCOPES = [
  'context:read', 'summaries:read', 'messages:write', 'messages:read',
  'posts:write', 'posts:read', 'memory:read', 'memory:write',
];

export interface CardPayload {
  kind: typeof CARD_KIND;
  approvalId: string;
  actionType: ApprovalActionType;
  summary: string;
  params: Record<string, unknown>;
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
}

export const buildCardPayload = (row: IApprovalAction): CardPayload => ({
  kind: CARD_KIND,
  approvalId: String(row._id),
  actionType: row.actionType,
  summary: row.summary,
  params: (row.params || {}) as Record<string, unknown>,
  status: row.status,
  ...(row.decision ? { decision: row.decision } : {}),
  ownerUserId: String(row.ownerUserId),
  agentName: row.agentName,
  instanceId: row.instanceId || 'default',
  expiresAt: row.expiresAt?.toISOString?.() || new Date(row.expiresAt).toISOString(),
  ...(row.executionResult !== undefined ? { executionResult: row.executionResult } : {}),
  ...(row.executionError ? { executionError: row.executionError } : {}),
});

interface ProposeOptions {
  podId: string;
  agentName: string;
  instanceId: string;
  displayName?: string;
  actionType: string;
  params: Record<string, unknown>;
  summary: string;
  installationConfig?: unknown;
}

interface ProposeResult {
  ok: boolean;
  error?: string;
  approvalId?: string;
  messageId?: string;
}

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
    return null;
  }
  return `unknown actionType '${actionType}'`;
};

// #609 cross-owner identity guard, propose-time edition: agent identity +
// memory key on (agentName, instanceId) with no owner dimension, so binding
// a name any OTHER user already owns would reuse their bot User + memory.
// Checking at propose time lets the agent pick a new name immediately
// instead of minting a card doomed to fail; executeConnectLocalAgent
// re-checks at approval time (state can change in between). Keep both in
// sync with the registry install route's foreignInstall guard.
const findForeignLocalAgentOwner = async (
  agentName: string,
  ownerUserId: unknown,
): Promise<boolean> => {
  const foreign = await AgentInstallation.findOne({
    agentName,
    instanceId: 'default',
    installedBy: { $ne: ownerUserId },
  });
  return !!foreign;
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

export const proposeAction = async (options: ProposeOptions): Promise<ProposeResult> => {
  const {
    podId, agentName, instanceId, displayName, actionType, params, summary, installationConfig,
  } = options;

  if (!KNOWN_ACTION_TYPES.has(actionType as ApprovalActionType)) {
    return {
      ok: false,
      error: `unknown actionType '${actionType}' — known: ${Array.from(KNOWN_ACTION_TYPES).join(', ')}`,
    };
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
  const ownerUserId = await resolveHumanDecider([install?.installedBy, pod.createdBy]);
  if (!ownerUserId) {
    return {
      ok: false,
      error: 'no accountable human owns this pod, so an approval card here would be undecidable — '
        + 'a human must install the agent or own the pod before it can propose actions',
    };
  }

  if (actionType === 'connect_local_agent') {
    const requestedName = String((params || {}).name || '').trim().toLowerCase();
    if (await findForeignLocalAgentOwner(requestedName, ownerUserId)) {
      return {
        ok: false,
        error: `the agent name "${requestedName}" is already in use by another user — pick a different name`,
      };
    }
  }

  const row = await ApprovalAction.create({
    podId,
    ownerUserId,
    agentName: String(agentName).toLowerCase(),
    instanceId: instanceId || 'default',
    actionType,
    params: params || {},
    summary: trimmedSummary.slice(0, 500),
  });

  // The card message. `content` is the plain-text fallback so legacy
  // surfaces (v1, digests, notifications) still show something meaningful.
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  const posted = await AgentMessageService.postMessage({
    agentName,
    instanceId,
    displayName,
    podId: String(podId),
    messageType: 'card',
    payload: buildCardPayload(row),
    content: `[approval needed] ${trimmedSummary}`,
    metadata: { source: 'approval-card', approvalId: String(row._id) },
    installationConfig,
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

  if (!posted?.success || !posted?.message) {
    // Card without a render is a dead flag — mark it moot rather than leave
    // a phantom pending approval nothing can see. (ADR-017: moot is never a
    // default decision branch — this is a delivery failure, not a decision.)
    row.status = 'moot';
    await row.save();
    return { ok: false, error: 'card message could not be posted' };
  }

  const messageId = String(posted.message._id || posted.message.id || '');
  row.messageId = messageId;
  await row.save();
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

const updateCardEverywhere = async (row: IApprovalAction): Promise<void> => {
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

export const resolveApproval = async (options: ResolveOptions): Promise<ResolveResult> => {
  const { approvalId, callerUserId, decision } = options;

  const row = await ApprovalAction.findById(approvalId);
  if (!row) return { status: 404, body: { error: 'Approval not found' } };

  if (String(row.ownerUserId) !== String(callerUserId)) {
    return { status: 403, body: { error: 'Only the workspace owner can decide this' } };
  }
  // ADR-017 §Decision-authorization: no agent may decide, even one holding
  // the owner's pod. Route-level auth already excludes agent tokens; this is
  // defense in depth against a future dualAuth slip.
  const caller = await User.findById(callerUserId).select('isBot').lean() as { isBot?: boolean } | null;
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
        ...(decidedAfterExpiry ? { decidedAfterExpiry: true } : {}),
      },
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

  if (decision === 'approved') {
    try {
      const result = await executeAction(transitioned);
      transitioned.executedAt = new Date();
      transitioned.executionResult = result;
    } catch (err) {
      // Honest failure face: resolved + approved + executionError. Never
      // roll back the decision — the user DID approve; the execution failed.
      transitioned.executionError = (err as Error).message?.slice(0, 500) || 'execution failed';
    }
    await transitioned.save();
  }

  await updateCardEverywhere(transitioned);
  return { status: 200, body: { ok: true, approval: buildCardPayload(transitioned) } };
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
  const params = (row.params || {}) as { name?: string };
  const agentName = String(params.name || '').trim().toLowerCase();
  if (!LOCAL_AGENT_NAME_RE.test(agentName)) throw new Error('invalid agent name');

  // Re-check the #609 guard at execution time — another user may have
  // claimed the name between propose and approve.
  if (await findForeignLocalAgentOwner(agentName, row.ownerUserId)) {
    throw new Error(`the agent name "${agentName}" is now in use by another user`);
  }

  const connectPath = `/v2/agents/byo?pod=${encodeURIComponent(String(row.podId))}&name=${encodeURIComponent(agentName)}`;

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
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentRegistry } = require('../models/AgentRegistry');
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
        config: { runtime: { runtimeType: 'webhook' } },
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
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentIdentityService = require('./agentIdentityService');
    const originInstall = await AgentInstallation.findOne({
      agentName: row.agentName,
      instanceId: row.instanceId || 'default',
      podId: row.podId,
      status: 'active',
    }).lean();
    await AgentInstallation.findOneAndUpdate(
      { agentName: row.agentName, podId: pod._id, instanceId: row.instanceId || 'default' },
      {
        $set: {
          status: 'active',
          version: originInstall?.version || '1.0.0',
          displayName: originInstall?.displayName,
          scopes: originInstall?.scopes || ['context:read', 'messages:write'],
          config: resolveWakePolicy(originInstall?.config || {}, pod),
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
      agentJoined = true;
    } else {
      agentJoinError = 'agent identity could not be resolved';
    }
  } catch (agentErr) {
    agentJoinError = (agentErr as Error).message?.slice(0, 200) || 'agent join failed';
    console.warn('[approval] create_pod agent-join failed:', agentJoinError);
  }

  return {
    podId: String(pod._id),
    podName: pod.name,
    podType: type,
    agentJoined,
    ...(agentJoinError ? { agentJoinError } : {}),
  };
};

export default { proposeAction, resolveApproval, buildCardPayload };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
