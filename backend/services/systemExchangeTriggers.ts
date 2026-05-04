// ADR-012 §4: platform-side hooks that record system exchange entries onto
// agents' memory envelopes. Each trigger is fire-and-forget — failures are
// logged but never propagate, so the parent operation (postMessage,
// enqueueDmEvent, tasksApi complete) is unaffected by memory-write trouble.
//
// Trigger taxonomy (this module is the single source of truth for v1):
//   - agent-dm-conclusion : NO_REPLY post in an agent-dm pod
//   - agent-dm-loop-trip  : bot-loop guard tripped in an agent-dm pod
//   - task-completed      : task transitioned to `completed`
//
// Cross-pod-mention is reserved for v1.x (see ADR-012 §4 + §Open questions).

import mongoose from 'mongoose';

import Pod from '../models/Pod';
import User from '../models/User';
import { appendSystemExchange, truncateTakeaway } from './agentMemoryService';

interface AgentMember {
  agentName: string;
  instanceId: string;
}

// Resolve the bot members of a pod into (agentName, instanceId) tuples.
// Skips humans + bots without `botMetadata`. Used to identify the two peers
// of an agent-dm pod (or the assignee of a task).
async function resolveAgentMembers(podId: string): Promise<{
  podType?: string;
  podName?: string;
  agents: AgentMember[];
}> {
  const pod = await Pod.findById(podId)
    .select('type name members')
    .lean<{ type?: string; name?: string; members?: unknown[] } | null>();
  if (!pod) return { agents: [] };

  const memberIds = ((pod.members as unknown[]) || [])
    .map((m): string => {
      if (m && typeof m === 'object' && '_id' in (m as Record<string, unknown>)) {
        return String((m as { _id?: unknown })._id ?? '');
      }
      return String(m ?? '');
    })
    .filter(Boolean);
  if (memberIds.length === 0) return { podType: pod.type, podName: pod.name, agents: [] };

  const bots = await User.find({
    _id: { $in: memberIds },
    isBot: true,
  })
    .select('username botMetadata')
    .lean<Array<{ username?: string; botMetadata?: { agentName?: string; instanceId?: string } }>>();

  const agents = bots
    .map((u) => {
      const agentName = u.botMetadata?.agentName || u.username || '';
      const instanceId = u.botMetadata?.instanceId || 'default';
      return { agentName: String(agentName).toLowerCase(), instanceId };
    })
    .filter((a) => a.agentName);

  return { podType: pod.type, podName: pod.name, agents };
}

// Build a human-readable surfaceLabel for an entry. Format mirrors the design
// in ADR-012 §1: "<podType>:<podName>" when name is set, else "<podType>:<podId>".
function surfaceLabelFor(podType: string | undefined, podName: string | undefined, podId: string): string {
  const type = podType || 'pod';
  const tail = podName && podName.trim() ? podName.trim() : String(podId).slice(0, 8);
  return `${type}:${tail}`;
}

interface RecordAgentDmConclusionArgs {
  podId: string;
  senderAgentName: string;
  senderInstanceId: string;
  ts?: Date;
}

// Look up the most recent non-NO_REPLY message from a specific user in a pod.
// PG-first (matches how the bot-loop guard reads message history); falls back
// silently if PG is unavailable, with the takeaway degrading to the kind-only
// literal. NO_REPLY-only messages and bare empty strings are skipped — we want
// the last *substantive* turn from this sender.
async function findPreviousNonSilentMessage(podId: string, senderUserId: string): Promise<string | null> {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const PGMessage = require('../models/pg/Message') as {
      findByPodId?: (id: string, limit: number) => Promise<Array<{ user_id?: unknown; content?: unknown }>>;
    };
    if (!PGMessage || typeof PGMessage.findByPodId !== 'function') return null;
    // Limit: 30 — the NO_REPLY post itself is typically the last row, and we
    // want the last substantive turn from the sender. 30 covers ~10 back-and-
    // forths without scanning the whole pod.
    const recent = await PGMessage.findByPodId(podId, 30);
    if (!Array.isArray(recent) || recent.length === 0) return null;
    // findByPodId returns most-recent first (PG ORDER BY created_at DESC).
    // Skip the first row if it is the NO_REPLY post we just received — its
    // content reduces to empty under sanitizeAgentContent.
    for (const m of recent) {
      const uid = String(m?.user_id ?? '');
      if (uid !== senderUserId) continue;
      const raw = typeof m?.content === 'string' ? m.content : String(m?.content ?? '');
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // Skip pure NO_REPLY rows (matches sanitizeAgentContent's logic without
      // round-tripping the regex). A row that's NO_REPLY-only collapses to
      // empty after stripping the token.
      const stripped = trimmed.replace(/\bNO_REPLY\b/g, '').trim();
      if (!stripped) continue;
      return stripped;
    }
    return null;
  } catch (err) {
    console.warn('[system-exchange] findPreviousNonSilentMessage failed:', (err as Error).message);
    return null;
  }
}

// ADR-012 §4: agent-dm-conclusion — fired when an agent's reply is NO_REPLY
// (the entire reply) in an agent-dm pod. Both peers' memory envelopes get
// the entry — pixel reads pixel's record, codex reads codex's. Same event,
// two private records (ADR-012 §6).
export async function recordAgentDmConclusion(args: RecordAgentDmConclusionArgs): Promise<void> {
  const { podId, senderAgentName, senderInstanceId, ts = new Date() } = args;
  try {
    if (!podId || !mongoose.isValidObjectId(podId)) return;
    const { podType, podName, agents } = await resolveAgentMembers(String(podId));
    if (podType !== 'agent-dm') return; // belt-and-suspenders; caller already checked
    if (agents.length < 2) return; // not a 1:1 yet — skip

    const senderKey = `${String(senderAgentName).toLowerCase()}|${senderInstanceId}`;
    if (!agents.some((a) => `${a.agentName}|${a.instanceId}` === senderKey)) {
      // Sender isn't a recognized agent member of this pod — skip rather
      // than fabricate an entry (e.g. an external integration posting NO_REPLY).
      return;
    }

    const surfaceLabel = surfaceLabelFor(podType, podName, podId);

    // Find the sender's User._id so we can locate their previous message.
    // We deliberately don't accept senderUserId from the caller — postMessage
    // resolves agentUser AFTER the silent_or_empty early-return, so that
    // value isn't available at the trigger fire-point.
    let previousContent: string | null = null;
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const User = require('../models/User');
      const senderUser = await User.findOne({
        'botMetadata.agentName': String(senderAgentName).toLowerCase(),
        'botMetadata.instanceId': senderInstanceId,
        isBot: true,
      })
        .select('_id')
        .lean<{ _id: unknown } | null>();
      if (senderUser?._id) {
        previousContent = await findPreviousNonSilentMessage(String(podId), String(senderUser._id));
      }
    } catch (err) {
      console.warn('[system-exchange] sender lookup failed:', (err as Error).message);
    }

    // Takeaway derivation — verbatim previous content, head-truncated. v1
    // skips multi-turn condensation (see ADR-012 §4). When no prior content
    // exists (fresh DM, PG unavailable), fall back to a kind-only literal.
    const takeaway = previousContent && previousContent.trim()
      ? truncateTakeaway(previousContent.trim())
      : 'agent-dm concluded (no prior content captured)';

    // Write to BOTH peers. Each peer's `peers` field lists the OTHER agents.
    const writes = agents.map((a) => {
      const peers = agents
        .filter((p) => !(p.agentName === a.agentName && p.instanceId === a.instanceId))
        .map((p) => p.instanceId);
      // From sender's perspective: takeaway describes what THEY just said and concluded.
      // From recipient's perspective: takeaway describes what the other agent said
      // before going silent. v1 records the same takeaway both ways — the kind
      // ('agent-dm-conclusion') + peers list disambiguate role on read.
      return appendSystemExchange({
        agentName: a.agentName,
        instanceId: a.instanceId,
        kind: 'agent-dm-conclusion',
        surfacePodId: String(podId),
        surfaceLabel,
        peers,
        takeaway,
        ts,
      });
    });
    await Promise.all(writes);
  } catch (err) {
    console.warn('[system-exchange] recordAgentDmConclusion failed:', (err as Error).message);
  }
}

interface RecordAgentDmLoopTripArgs {
  podId: string;
  ts?: Date;
}

// ADR-012 §4: agent-dm-loop-trip — bot-loop guard tripped (8 consecutive bot
// turns in 30 min). Both peers' memory envelopes get a literal takeaway
// describing the trip. The guard itself is in agentMentionService; this hook
// runs alongside the existing console.warn.
export async function recordAgentDmLoopTrip(args: RecordAgentDmLoopTripArgs): Promise<void> {
  const { podId, ts = new Date() } = args;
  try {
    if (!podId || !mongoose.isValidObjectId(podId)) return;
    const { podType, podName, agents } = await resolveAgentMembers(String(podId));
    if (podType !== 'agent-dm') return;
    if (agents.length < 2) return;

    const surfaceLabel = surfaceLabelFor(podType, podName, podId);
    const takeaway = '8 consecutive bot turns within 30 min — guard tripped';

    const writes = agents.map((a) => {
      const peers = agents
        .filter((p) => !(p.agentName === a.agentName && p.instanceId === a.instanceId))
        .map((p) => p.instanceId);
      return appendSystemExchange({
        agentName: a.agentName,
        instanceId: a.instanceId,
        kind: 'agent-dm-loop-trip',
        surfacePodId: String(podId),
        surfaceLabel,
        peers,
        takeaway,
        ts,
      });
    });
    await Promise.all(writes);
  } catch (err) {
    console.warn('[system-exchange] recordAgentDmLoopTrip failed:', (err as Error).message);
  }
}

interface RecordTaskCompletedArgs {
  podId: string;
  // Assignee agent name (Task.assignee). If null/missing, the task wasn't
  // claimed by an agent and we skip.
  assignee?: string | null;
  taskTitle: string;
  // PR URL or terminal status string (e.g. "shipped", "no-pr"). Caller picks.
  prUrlOrStatus?: string | null;
  ts?: Date;
}

// Resolve an agent's instanceId for a given pod via their AgentInstallation.
// An agent installed at instance scope across multiple pods can have one row
// per pod; the row scoped to THIS pod gives us the right instanceId. If no
// row exists, fall back to 'default' (matches the convention used elsewhere
// in the codebase for unclaimed identity).
async function resolveAgentInstanceForPod(
  agentName: string,
  podId: string,
): Promise<string> {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { AgentInstallation } = require('../models/AgentRegistry') as {
      AgentInstallation: {
        findOne: (q: Record<string, unknown>) => {
          select: (fields: string) => {
            lean: () => Promise<{ instanceId?: string } | null>;
          };
        };
      };
    };
    const inst = await AgentInstallation
      .findOne({ agentName: agentName.toLowerCase(), podId, status: 'active' })
      .select('instanceId')
      .lean();
    return inst?.instanceId || 'default';
  } catch {
    return 'default';
  }
}

// ADR-012 §4: task-completed — fired when a task transitions to `done`. Only
// the assignee gets the entry. Takeaway format: "<title> → <prUrl|status>",
// head-truncated to 280 chars.
export async function recordTaskCompleted(args: RecordTaskCompletedArgs): Promise<void> {
  const {
    podId,
    assignee,
    taskTitle,
    prUrlOrStatus,
    ts = new Date(),
  } = args;
  try {
    if (!assignee || typeof assignee !== 'string') return;
    if (!podId || !mongoose.isValidObjectId(podId)) return;

    const { podType, podName, agents } = await resolveAgentMembers(String(podId));
    // Skip if the assignee isn't a recognized agent member of this pod —
    // human assignees don't have a memory envelope.
    const assigneeLower = assignee.toLowerCase();
    const isAgentInPod = agents.some((a) => a.agentName === assigneeLower);
    if (!isAgentInPod) return;

    const instanceId = await resolveAgentInstanceForPod(assigneeLower, String(podId));
    const surfaceLabel = surfaceLabelFor(podType, podName, podId);

    const titlePart = taskTitle ? String(taskTitle).trim() : '(untitled task)';
    const tailPart = prUrlOrStatus && String(prUrlOrStatus).trim()
      ? ` → ${String(prUrlOrStatus).trim()}`
      : '';
    const takeaway = truncateTakeaway(`${titlePart}${tailPart}`);

    await appendSystemExchange({
      agentName: assigneeLower,
      instanceId,
      kind: 'task-completed',
      surfacePodId: String(podId),
      surfaceLabel,
      peers: [],
      takeaway,
      ts,
    });
  } catch (err) {
    console.warn('[system-exchange] recordTaskCompleted failed:', (err as Error).message);
  }
}
