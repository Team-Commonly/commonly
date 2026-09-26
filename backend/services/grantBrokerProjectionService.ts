/**
 * One definition of "which live grants does this seat have, and what does it
 * receive from them", shared by the two delivery paths:
 *
 *  - the daemon's assignment projection (`routes/agentBinding.ts`), which hands
 *    a seat an MCP server per live grant, and
 *  - a hosted native run (`services/nativeRuntimeService.ts`), which hands the
 *    model the same grants as function tools dispatched in process.
 *
 * The selection lived inside `grantServersForIdentities` before this module,
 * and only the daemon could reach it: `nativeRuntimeService` never referenced
 * grants at all, so a hosted agent in a granted pod could not use GitHub
 * (eng lead 73723). The predicate is MOVED here, not rewritten — a second
 * implementation of "live, audience, target" is how the two paths drift apart,
 * and the drift would be invisible until a seat was handed a capability the
 * other path withholds.
 *
 * Revocation and expiry take effect on the next run or poll because they are in
 * the query, not in a stored projection. They are ALSO re-checked on every
 * single call by `toolBrokerService.callTool`, which re-reads the grant,
 * recomputes the live member set and re-runs `assertGrantUsable` with the
 * required write mode taken from the server-side definition map. That re-check
 * is the whole reason a caller may assemble this projection once per run
 * (vera 73751) — see the cache note on `hostedBrokerToolsForRun`.
 */

import { GRANT_BROKER_ID, GRANT_BROKER_URL } from './installable/toolInstallables';
import { GRANT_BROKER_AUTHORIZATION } from './seatEnvironmentProjection';
import { getToolDefinitions } from './toolBrokerService';
import Pod from '../models/Pod';
import RoomGrant from '../models/RoomGrant';

export type GrantTarget = { kind?: unknown; id?: unknown };

export interface LiveGrant {
  grantId: string;
  target: GrantTarget;
  audience?: unknown[];
  tools?: unknown[];
  writeMode?: string;
}

/**
 * The grammar an OpenAI-compatible function name must satisfy. LiteLLM passes
 * `tools[].function.name` straight through, so a name outside this set is a
 * rejected request, not a degraded tool — which is why the hosted path
 * sanitizes `github.list_issues` into `github_list_issues` rather than handing
 * the broker's dotted name to the model.
 */
export const GRANT_BROKER_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** The MCP server handed to a daemon seat: one URL per grant. */
export const grantBrokerServer = (grantId: string, name: string): Record<string, unknown> => ({
  name,
  transport: 'http',
  url: GRANT_BROKER_URL.replace('${COMMONLY_GRANT_ID}', encodeURIComponent(grantId)),
  headers: { Authorization: GRANT_BROKER_AUTHORIZATION },
});

/**
 * `github.list_issues` -> `github_list_issues`. Only the characters the
 * function-name grammar rejects are replaced, so the name stays recognizable to
 * both the model and a reader of an `AgentRun`.
 */
export const sanitizeGrantBrokerToolName = (tool: string): string => String(tool).replace(/[^a-zA-Z0-9_-]/g, '_');

export interface LiveGrantQuery {
  /** The seats' bot User `_id`s — the same ids grants carry in `audience`. */
  identityIds: string[];
  /**
   * The pods this caller is projecting for. A daemon passes the seat's
   * installed pods; a hosted run passes only the pod it is running in
   * (wren 73741), which is what keeps a run from reaching a grant minted for
   * another pod.
   */
  podIds: string[];
}

/**
 * Live, in-audience grants per seat, for seats whose target covers it:
 * seat-targeted grants match the identity, pod-targeted grants match the
 * identity's CURRENT membership of one of `podIds` (the grant's audience is a
 * mint-time snapshot, so membership is re-read here and again per call).
 *
 * Seats with nothing live are absent from the map rather than mapped to `[]`,
 * so a caller cannot mistake "no grant" for "a grant that projected nothing".
 */
export const selectLiveGrantsForIdentities = async (
  { identityIds, podIds }: LiveGrantQuery,
): Promise<Map<string, LiveGrant[]>> => {
  const ids = Array.from(new Set((identityIds || []).map(String).filter(Boolean)));
  const output = new Map<string, LiveGrant[]>();
  if (!ids.length) return output;

  const scopedPodIds = Array.from(new Set((podIds || []).map(String)))
    .filter((podId) => /^[a-f\d]{24}$/i.test(podId));

  const grants = await RoomGrant.find({
    brokerId: GRANT_BROKER_ID,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
    audience: { $in: ids },
  }).select('grantId target audience tools writeMode').lean() as LiveGrant[];
  if (!grants.length) return output;

  const pods = scopedPodIds.length
    ? await Pod.find({ _id: { $in: scopedPodIds } }).select('_id members').lean()
    : [];
  const podMembers = new Map<string, Set<string>>(
    pods.map((pod: { _id: unknown; members?: unknown[] }) => [
      String(pod._id),
      new Set((pod.members || []).map((member) => String(member))),
    ]),
  );

  for (const id of ids) {
    const selected = grants.filter((grant) => {
      const grantId = typeof grant.grantId === 'string' ? grant.grantId : '';
      if (!grantId) return false;
      const inAudience = (grant.audience || []).map(String).includes(id);
      if (!inAudience) return false;
      const target = grant.target || {};
      const targetId = String(target.id || '');
      if (target.kind === 'seat') return targetId === id;
      if (target.kind === 'pod') {
        return scopedPodIds.includes(targetId) && Boolean(podMembers.get(targetId)?.has(id));
      }
      return false;
    });
    if (selected.length) output.set(id, selected);
  }
  return output;
};

export interface HostedBrokerProjection {
  /** OpenAI-compatible function tools, ready to append to a turn's tool list. */
  tools: Record<string, unknown>[];
  /**
   * The ONLY thing a run may cache: exposed tool name -> the grant and the
   * broker tool it resolves to. Never the grant document, the member set, or
   * the result of `assertGrantUsable` (vera 73751).
   */
  dispatch: Map<string, { grantId: string; tool: string }>;
}

/**
 * Assemble the broker surface for one hosted run. Called once per run at turn
 * assembly, never per turn.
 *
 * Two deliberate narrowings, both fail-closed:
 *
 *  - **Reads only** (wren 73743). Only definitions whose `requiredWriteMode` is
 *    `read` are offered, even when the grant's own mode would allow a write: a
 *    hosted write's unattended path is not reconciled with ADR-020 D1 yet.
 *    `callTool` re-checks the mode on every call regardless — this is the
 *    surface, not the gate.
 *  - **The grant's `tools` list is authoritative** (`assertGrantUsable` refuses
 *    a tool the grant does not name). Filtering here keeps the model from
 *    seeing a tool that would only be refused; it is not what enforces it.
 *
 * If two live grants in the pod cover the same tool, the deterministically
 * first one (by `grantId`) supplies the plain name and the others are skipped
 * with a warning: the capability is still reachable, and silently overwriting
 * the map would hand the call to whichever grant happened to load last.
 */
export const hostedBrokerToolsForRun = async (
  { identityId, podId }: { identityId: string; podId: string },
): Promise<HostedBrokerProjection> => {
  const tools: Record<string, unknown>[] = [];
  const dispatch = new Map<string, { grantId: string; tool: string }>();
  if (!identityId || !podId) return { tools, dispatch };

  const byIdentity = await selectLiveGrantsForIdentities({
    identityIds: [String(identityId)],
    podIds: [String(podId)],
  });
  const grants = byIdentity.get(String(identityId)) || [];
  if (!grants.length) return { tools, dispatch };

  const readable = getToolDefinitions().filter((definition) => definition.requiredWriteMode === 'read');
  const ordered = [...grants].sort((a, b) => String(a.grantId).localeCompare(String(b.grantId)));

  for (const grant of ordered) {
    const allowed = new Set((grant.tools || []).map(String));
    for (const definition of readable) {
      if (!allowed.has(definition.name)) continue;
      const exposed = sanitizeGrantBrokerToolName(definition.name);
      if (!GRANT_BROKER_TOOL_NAME_PATTERN.test(exposed)) {
        // Unreachable for the definitions that ship today; fail closed rather
        // than send LiteLLM a tool list it will reject wholesale.
        console.warn(`[grant-broker] tool name ${definition.name} has no usable function name; not offered`);
        continue;
      }
      const claimed = dispatch.get(exposed);
      if (claimed) {
        if (claimed.grantId !== grant.grantId || claimed.tool !== definition.name) {
          console.warn(
            `[grant-broker] ${grant.grantId} also covers ${definition.name}; `
            + `${claimed.grantId} supplies the name. One tool, one grant, chosen deterministically.`,
          );
        }
        continue;
      }
      dispatch.set(exposed, { grantId: grant.grantId, tool: definition.name });
      tools.push({
        type: 'function',
        function: {
          name: exposed,
          description: definition.description,
          parameters: definition.inputSchema,
        },
      });
    }
  }

  return { tools, dispatch };
};

export type HostedBrokerOutcome = 'ok' | 'refused' | 'failed' | 'pending_approval';

export interface HostedBrokerCall {
  /** The same payload `routes/mcpGrants.ts` sends as its tool text. */
  content: unknown;
  callId?: string;
  outcome: HostedBrokerOutcome;
}

/**
 * Dispatch one broker tool call in process. Returns `null` when `name` is not a
 * broker tool, so the caller falls through to its own dispatcher.
 *
 * The grant id and the broker tool name come from the run's projection map, NOT
 * from `args` or from the model's tool name: pod content is untrusted, so a
 * `grantId` inside the arguments is ignored by construction (there is nothing
 * here that reads one) and the audit row is attributed to `agentUserId`, which
 * the caller takes from the run record.
 *
 * The payload shapes mirror `routes/mcpGrants.ts` exactly — an agent reaching
 * the broker through a hosted run and one reaching it through MCP see the same
 * JSON for the same outcome.
 */
export const dispatchHostedBrokerTool = async (
  { projection, name, args, agentUserId, agentName, instanceId }: {
    projection: HostedBrokerProjection;
    name: string;
    args: unknown;
    agentUserId: string;
    agentName?: string;
    instanceId?: string;
  },
): Promise<HostedBrokerCall | null> => {
  const mapped = projection.dispatch.get(name);
  if (!mapped) return null;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { callTool } = require('./toolBrokerService');
  try {
    const result = await callTool({
      grantId: mapped.grantId,
      agentUserId,
      agentName,
      instanceId,
      tool: mapped.tool,
      args,
    });
    return { content: result.result, callId: result.callId, outcome: 'ok' };
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    const callId = typeof e.details?.callId === 'string' ? e.details.callId : undefined;
    if (e.code === 'approval_required') {
      return {
        content: {
          status: 'pending_approval',
          approvalId: (e.details?.approvalId as string | undefined) || null,
        },
        callId,
        outcome: 'pending_approval',
      };
    }
    return {
      content: {
        error: e.code || 'broker_error',
        message: e.message || 'Tool call refused',
        ...(e.details ? { details: e.details } : {}),
      },
      callId,
      outcome: e.code ? 'refused' : 'failed',
    };
  }
};

export default {
  GRANT_BROKER_TOOL_NAME_PATTERN,
  grantBrokerServer,
  sanitizeGrantBrokerToolName,
  selectLiveGrantsForIdentities,
  hostedBrokerToolsForRun,
  dispatchHostedBrokerTool,
};

// CJS compat: let require() return the default export directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default;
Object.assign(module.exports, exports);
