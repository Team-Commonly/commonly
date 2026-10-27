import User from '../models/User';
import { PodInvite, INVITE_SOURCES } from '../models/PodInvite';
import { HUMAN_FILTER, internalAccountExclusion } from './userClassification';

/** Aggregate counts only: token material and people never leave this service. */
export async function readInviteFunnel(days: number) {
  const since = new Date(Date.now() - days * 86400000);
  const invites = await PodInvite.find({ createdAt: { $gte: since } })
    .select('createdBy source inviterFirstSessionAt firstTeammateJoinedAt').lean();
  const people = await User.find({
    _id: { $in: [...new Set(invites.map((invite) => String(invite.createdBy)))] },
    ...HUMAN_FILTER, ...internalAccountExclusion(),
  }).select('_id').lean();
  const outside = new Set(people.map((person) => String(person._id)));
  const cohorts = new Map<string, { firstSessionDay: string | null; created: number; used: number;
    inviters: Set<string>; convertedInviters: Set<string> }>();
  const sources: Record<string, { created: number; used: number }> = {};
  for (const invite of invites) {
    const inviterId = String(invite.createdBy);
    if (!outside.has(inviterId)) continue;
    const day = invite.inviterFirstSessionAt?.toISOString().slice(0, 10) || null;
    const key = day || 'unobserved';
    const cohort = cohorts.get(key) || { firstSessionDay: day, created: 0, used: 0,
      inviters: new Set<string>(), convertedInviters: new Set<string>() };
    cohort.created += 1;
    cohort.inviters.add(inviterId);
    if (invite.firstTeammateJoinedAt) { cohort.used += 1; cohort.convertedInviters.add(inviterId); }
    cohorts.set(key, cohort);
    const source = INVITE_SOURCES.find((candidate) => candidate === invite.source) || 'unattributed';
    sources[source] ||= { created: 0, used: 0 };
    sources[source].created += 1;
    if (invite.firstTeammateJoinedAt) sources[source].used += 1;
  }
  return {
    days, createdSince: since.toISOString(), cohortBasis: 'inviter-first-observed-pod-open',
    // Legacy useCount counts even an existing member's repeated redemption.
    // The new marker measures new outside-human joins, forward from deploy.
    usageMeasuredFromDeploy: true,
    cohorts: [...cohorts.values()].sort((a, b) => (a.firstSessionDay || '').localeCompare(b.firstSessionDay || ''))
      .map(({ inviters, convertedInviters, ...cohort }) => ({ ...cohort,
        inviters: inviters.size, convertedInviters: convertedInviters.size })),
    sources,
  };
}
