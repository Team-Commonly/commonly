import Pod from '../models/Pod';

/**
 * The pods an events poll (`GET /api/agents/runtime/events`) may claim from:
 * the agent's active installations plus the agent-admin DM pods it is a member
 * of. `fallbackPodId` is the single installation pod used when that set is
 * empty, as before.
 *
 * One function so a long-poll (F597) rebuilds the scope after a wake exactly
 * as the request built it at its start: an installation removed mid-hold must
 * drop out of what the claim can take.
 */
export async function resolveEventPodScope({
  installations,
  installation,
  agentUserId,
}: {
  installations: Array<{ podId?: unknown } | null | undefined>;
  installation?: { podId?: unknown } | null;
  agentUserId?: unknown;
}): Promise<{ podIds: string[]; fallbackPodId: unknown }> {
  const installationPodIds = (installations || [])
    .map((item) => item?.podId)
    .filter(Boolean);
  const dmPods = await Pod.find({
    type: 'agent-admin',
    members: agentUserId,
  }).select('_id').lean() as Array<{ _id: unknown }>;
  const dmPodIds = dmPods.map((pod) => pod._id);
  const podIds = Array.from(
    new Set(
      [...installationPodIds, ...dmPodIds]
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  );
  const fallbackPodId = podIds.length === 0 && installation?.podId
    ? installation.podId
    : undefined;
  return { podIds, fallbackPodId };
}
