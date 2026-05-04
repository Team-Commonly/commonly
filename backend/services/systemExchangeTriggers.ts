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

// Cheap pre-flight gate. The hot path on `postMessage` is heartbeat-NO_REPLY
// posts in non-DM pods (community agents posting an empty heartbeat reply
// every cycle), so we want to bail out without paying the User.find round-trip.
// One projected Pod.findById on `type` is the minimum cost we can pay before
// deciding to proceed; if not an agent-dm, we return false and the caller
// returns immediately. This is also belt-and-suspenders for the type guard
// in resolveAgentMembers below.
async function podIsAgentDm(podId: string): Promise<boolean> {
  try {
    const pod = await Pod.findById(podId)
      .select('type')
      .lean<{ type?: string } | null>();
    return pod?.type === 'agent-dm';
  } catch {
    return false;
  }
}

// Resolve the bot members of a pod into (agentName, instanceId) tuples.
// Skips humans + bots without `botMetadata`. Used to identify the two peers
// of an agent-dm pod (or the assignee of a task).
//
// IDENTITY NOTE: for OpenClaw-driven peers, `botMetadata.agentName` is the
// RUNTIME label ('openclaw'), not the per-instance identity. The
// (agentName, instanceId) **tuple** is what gives a unique identity — two
// openclaw agents in a pod share `agentName='openclaw'` but have different
// `instanceId`s ('aria' vs 'pixel'). The senderKey check below relies on the
// tuple, not on agentName alone, for that reason. See CLAUDE.md DM display-
// label rule for the broader shape.
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
//
// Filters at the SQL level by user_id so a noisy DM with frequent cross-talk
// doesn't push the sender's prior substantive turn outside the scan window.
async function findPreviousNonSilentMessage(podId: string, senderUserId: string): Promise<string | null> {
  try {
    // Lazy require to avoid pulling pg config at module-load time in unit tests.
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg') as {
      pool?: {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
      };
    };
    if (!pool || typeof pool.query !== 'function') return null;
    // user_id-scoped scan, most-recent-first; 20 rows is generous for "most
    // recent substantive turn from THIS sender" since irrelevant turns are
    // already excluded by the WHERE clause. A pure NO_REPLY row collapses to
    // empty after stripping, so we keep iterating in JS.
    const result = await pool.query(
      `SELECT content FROM messages
       WHERE pod_id = $1 AND user_id = $2
       ORDER BY created_at DESC
       LIMIT 20`,
      [podId, senderUserId],
    );
    if (!result?.rows || result.rows.length === 0) return null;
    // Lazy require AgentMessageService for sanitizeAgentContent — single source
    // of truth for "is this a substantive reply?" Keeps NO_REPLY semantics in
    // sync with the swallow logic in postMessage.
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AMS = require('./agentMessageService') as {
      AgentMessageService?: { sanitizeAgentContent?: (s: unknown) => string };
      default?: { sanitizeAgentContent?: (s: unknown) => string };
    };
    const sanitize = (
      AMS.AgentMessageService?.sanitizeAgentContent
      ?? AMS.default?.sanitizeAgentContent
    );
    for (const m of result.rows) {
      const raw = typeof m?.content === 'string' ? (m.content as string) : String(m?.content ?? '');
      const cleaned = typeof sanitize === 'function' ? sanitize(raw) : raw.trim().replace(/\bNO_REPLY\b/g, '').trim();
      if (cleaned) return cleaned;
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
//
// Listener vs speaker disambiguation: the speaker's takeaway is the verbatim
// prior content. The listener's takeaway is prefixed with `@<peer>:` so that
// reading the entry later doesn't suggest the listener spoke those words.
// Splitting into two kinds was an alternative; keeping one kind + role-shaped
// takeaway lets the digest builder render uniformly without a kind-table.
export async function recordAgentDmConclusion(args: RecordAgentDmConclusionArgs): Promise<void> {
  const { podId, senderAgentName, senderInstanceId, ts = new Date() } = args;
  try {
    if (!podId || typeof podId !== 'string' || !mongoose.isValidObjectId(podId)) return;
    // Hot-path gate: bail before User.find for non-DM pods. Heartbeats in team
    // pods regularly emit NO_REPLY-only posts; this short-circuit keeps that
    // path cheap (one $type-projected findById vs full member resolution).
    if (!(await podIsAgentDm(podId))) return;

    const { podType, podName, agents } = await resolveAgentMembers(String(podId));
    if (podType !== 'agent-dm') return; // belt-and-suspenders; podIsAgentDm already filtered
    if (agents.length < 2) return; // not a 1:1 yet — skip

    const senderName = String(senderAgentName || '').toLowerCase();
    const senderInst = String(senderInstanceId || 'default');
    const senderKey = `${senderName}|${senderInst}`;
    if (!agents.some((a) => `${a.agentName}|${a.instanceId}` === senderKey)) {
      // Sender isn't a recognized agent member of this pod — skip rather
      // than fabricate an entry (e.g. an external integration posting NO_REPLY).
      return;
    }

    const surfaceLabel = surfaceLabelFor(podType, podName, podId);

    // Find the sender's User._id so we can locate their previous message.
    // Use the top-level User import (Mongoose model is properly typed) rather
    // than re-requiring it lazily — avoids the TS2347 "untyped function calls
    // may not accept type arguments" warning on .lean<...>().
    let previousContent: string | null = null;
    try {
      const senderUser = await User.findOne({
        'botMetadata.agentName': senderName,
        'botMetadata.instanceId': senderInst,
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
    const speakerTakeaway = previousContent && previousContent.trim()
      ? truncateTakeaway(previousContent.trim())
      : 'agent-dm concluded (no prior content captured)';

    // Write to BOTH peers. Each peer's `peers` field lists the OTHER agents.
    // Speaker gets the verbatim takeaway; listener(s) get a `@peer:`-prefixed
    // version so the entry reads as "what the other side said" — eliminates
    // the "why does my memory say I shipped X when I didn't?" failure mode.
    const writes = agents.map((a) => {
      const isSpeaker = a.agentName === senderName && a.instanceId === senderInst;
      const peers = agents
        .filter((p) => !(p.agentName === a.agentName && p.instanceId === a.instanceId))
        .map((p) => p.instanceId);
      const speakerLabel = senderInst && senderInst !== 'default' ? senderInst : senderName;
      const takeaway = isSpeaker
        ? speakerTakeaway
        : truncateTakeaway(`@${speakerLabel}: ${speakerTakeaway}`);
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
    if (!podId || typeof podId !== 'string' || !mongoose.isValidObjectId(podId)) return;
    if (!(await podIsAgentDm(podId))) return;
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
    if (!podId || typeof podId !== 'string' || !mongoose.isValidObjectId(podId)) return;

    const { podType, podName, agents } = await resolveAgentMembers(String(podId));
    // Skip if the assignee isn't a recognized agent member of this pod —
    // human assignees don't have a memory envelope. NOTE: matching on
    // agentName alone is correct here because Task.assignee stores the agent
    // identifier the runtime owns (one assignee → one agent). For OpenClaw
    // agents the matching peer in `agents[]` has agentName='openclaw' and a
    // distinguishing instanceId; we resolve the right instanceId below.
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
