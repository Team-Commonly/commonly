import { Types } from 'mongoose';
import Pod from '../../models/Pod';
import User from '../../models/User';
import AgentIdentityService from '../agentIdentityService';
import { PlaybookError } from './definition';
import { loadPlaybookContext } from './context';
import { DraftInput, validatePlaybookDraft, requirePlaybookHuman } from './store';

/** Validate the draft against current pod facts, without installing or binding it. */
export const validatePlaybookProposal = async (
  params: Record<string, unknown>, cardPodId: string, agentName: string, instanceId: string,
): Promise<DraftInput & { podId: string }> => {
  const { podId: requestedPodId, ...draft } = params;
  const podId = String(requestedPodId || cardPodId).toLowerCase();
  if (!Types.ObjectId.isValid(podId)) throw new PlaybookError('invalid_pod', 'Choose a pod you belong to', 400);
  if (podId !== cardPodId.toLowerCase()) {
    throw new PlaybookError('proposal_pod_mismatch', 'Propose this draft from the target pod', 403);
  }
  const { book, schedule } = validatePlaybookDraft(draft as unknown as DraftInput);
  const username = AgentIdentityService.buildAgentUsername(AgentIdentityService.resolveAgentType(agentName), instanceId);
  const actor = await User.findOne({ username, isBot: true }).select('_id').lean();
  const context = await loadPlaybookContext(podId);
  if (!actor || !context.members.some((member) => member.userId === String(actor._id))) {
    throw new PlaybookError('pod_membership_required', 'Join this pod before proposing its playbook', 403);
  }
  for (const step of book.steps) {
    if (step.reads?.length && context.grantPodRefusal) {
      throw new PlaybookError('grant_pod_refused', context.grantPodRefusal, 400);
    }
    for (const tool of step.reads || []) {
      if (!context.tools.some((entry) => entry.name === tool && entry.mode === 'read')) {
        throw new PlaybookError('tool_not_granted', `${tool} is not a live pinned read in this pod`, 400);
      }
    }
  }
  return { podId, title: String(draft.title).trim(), definition: book,
    ...(draft.sourceText !== undefined ? { sourceText: String(draft.sourceText).slice(0, 8000) } : {}),
    ...(draft.bindings !== undefined ? { bindings: draft.bindings as Record<string, string> } : {}),
    ...(schedule ? { schedule } : {}) };
};

/** Prefer the proposer's human installer only while they are a member of the target pod. */
export const playbookProposalOwner = async (podId: string, installer: unknown): Promise<string | null> => {
  const pod = await Pod.findById(podId).select('createdBy').lean();
  for (const candidate of [installer, pod?.createdBy]) {
    if (!candidate) continue;
    try {
      await requirePlaybookHuman(podId, String(candidate));
      return String(candidate);
    } catch (error) {
      if (!(error instanceof PlaybookError)) throw error;
    }
  }
  return null;
};
