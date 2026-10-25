/** Finish the fallible memory handoff before an install joins or greets a pod. */
const User = require('../models/User');
const AgentIdentityService = require('./agentIdentityService');
const AgentMemory = require('../models/AgentMemory');
const { AgentInstallation } = require('../models/AgentRegistry');
const { stampSectionsForWrite, decorateSectionsWithProvenance } = require('./agentMemoryService');

class HandoffRefusal extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function copyInstallHandoffMemory({
  source, agentName, instanceId, userId, registryOwner, runtime,
}: {
  source: any; agentName: string; instanceId: string; userId: string;
  registryOwner: unknown; runtime: any;
}) {
  if (source === undefined) return undefined;
  if (runtime?.host !== 'byo' || !runtime?.adapter
    || typeof source?.agentName !== 'string' || !source.agentName.trim()
    || typeof source?.instanceId !== 'string' || !source.instanceId.trim()) {
    throw new HandoffRefusal(400, 'A BYO adapter and source agent and instance are required for memory handoff');
  }
  const sourceIdentity = {
    agentName: source.agentName.trim().toLowerCase(), instanceId: source.instanceId.trim(),
  };
  const sourceInstalls = await AgentInstallation.find({
    ...sourceIdentity, status: { $ne: 'uninstalled' },
  }).select('installedBy').lean();
  const targetInstalls = await AgentInstallation.find({ agentName, instanceId })
    .select('installedBy').lean();
  // A new target has no installation yet. Its registry owner authorizes that
  // first copy; retained installations must all belong to the same person.
  if (!sourceInstalls.length
    || sourceInstalls.some((row: any) => String(row.installedBy) !== String(userId))
    || targetInstalls.some((row: any) => String(row.installedBy) !== String(userId))
    || (!targetInstalls.length && String(registryOwner) !== String(userId))) {
    throw new HandoffRefusal(403, 'Memory handoff requires ownership of the source and target');
  }
  const resolvedType = AgentIdentityService.resolveAgentType(agentName);
  const username = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
  const principal = await User.findOne({ username, isBot: true }).select('botMetadata').lean();
  if (principal && ((principal.botMetadata?.ownerUserId
      && String(principal.botMetadata.ownerUserId) !== String(userId))
    || (!principal.botMetadata?.ownerUserId && !targetInstalls.length)
    || (principal.botMetadata?.agentName && principal.botMetadata.agentName !== resolvedType)
    || (principal.botMetadata?.instanceId && principal.botMetadata.instanceId !== instanceId))) {
    throw new HandoffRefusal(403, 'Memory handoff target identity belongs to another owner');
  }
  const hosted = await AgentMemory.findOne(sourceIdentity).select('content sections.long_term').lean();
  const content = hosted?.sections?.long_term?.content ?? hosted?.content ?? '';
  if (!content) return { copied: false, reason: 'source-empty' };
  const identity = { agentName, instanceId };
  const target = await AgentMemory.findOne(identity).select('content sections').lean();
  const before = target?.sections?.long_term;
  const priorContent = before?.content ?? target?.content ?? '';
  if (before?.visibility && before.visibility !== 'private') {
    throw new HandoffRefusal(409, 'Local long-term memory must be private before copying hosted memory');
  }
  // Both mirrors must agree: a legacy writer can change content without
  // updating the section revision or section text.
  if (priorContent === content && (!target?.content || target.content === content)) {
    return { copied: false, reason: 'already-copied' };
  }
  if (priorContent || target?.content) {
    throw new HandoffRefusal(409, 'Local agent already has different memory; choose a new local name');
  }
  const incoming = stampSectionsForWrite({ long_term: { content, visibility: 'private' } });
  const decorated = decorateSectionsWithProvenance(target?.sections, incoming, { via: 'memory-owner' });
  try {
    const saved = await AgentMemory.findOneAndUpdate({
      ...identity,
      content: target?.content ?? null,
      'sections.long_term.content': before?.content ?? { $exists: false },
      'sections.long_term.visibility': before?.visibility ?? { $exists: false },
      'sections.long_term.updatedAt': before?.updatedAt ?? { $exists: false },
    }, {
      $set: { content, 'sections.long_term': decorated.long_term, schemaVersion: 2 },
      $unset: { lastSyncKey: 1, lastSyncAt: 1 },
    }, { new: true, upsert: !target, runValidators: true });
    if (!saved) throw new HandoffRefusal(409, 'Memory changed during handoff; retry attach');
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new HandoffRefusal(409, 'Memory changed during handoff; retry attach');
    }
    throw error;
  }
  return { copied: true };
}
