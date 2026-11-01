/** Addressed cues for ambient messages. A match only counts for the seat that owns it. */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const Task = require('../models/Task');
const { threadAuthorIds } = require('./threadWakeScopeService');
const MessageClaimService = require('./messageClaimService');
const { assigneeNamesSeat } = require('./taskAssigneeService');

interface Target {
  agentName?: unknown;
  instanceId?: unknown;
}

const key = (target: Target): string => `${String(target.agentName || '').toLowerCase()}:${String(target.instanceId || 'default').toLowerCase()}`;

const taskRefs = (content: string): string[] => [...new Set(
  [...content.matchAll(/(?:^|[^a-z0-9])TASK-(\d+)(?![a-z0-9])/gi)]
    .map((match) => `TASK-${match[1]}`),
)];

const prRefs = (content: string): Set<string> => new Set(
  [...content.matchAll(/(?:^|[^a-z0-9])#(\d+)(?![a-z0-9])/gi)]
    .map((match) => match[1]),
);

const prNumber = (url: unknown): string | null => {
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#]|$)/i.exec(url);
  return match?.[1] || null;
};

export async function addressedMessageTargets({
  podId, content, threadRootId, targets, botUserIds,
}: {
  podId: string;
  content: string;
  threadRootId: number | null;
  targets: Target[];
  botUserIds: Map<string, string>;
}): Promise<Set<string>> {
  const addressed = new Set<string>();
  if (threadRootId) {
    const [authors, claimants] = await Promise.all([
      threadAuthorIds(threadRootId) as Promise<Set<string>>,
      MessageClaimService.liveClaimantsInThread(podId, threadRootId) as Promise<Set<string>>,
    ]);
    for (const target of targets) {
      const targetKey = key(target);
      if (authors.has(botUserIds.get(targetKey) || '') || claimants.has(targetKey)) {
        addressed.add(targetKey);
      }
    }
  }

  const ids = taskRefs(content);
  const prs = prRefs(content);
  if (ids.length === 0 && prs.size === 0) return addressed;
  const selectors: Array<Record<string, unknown>> = [];
  if (ids.length) selectors.push({ taskId: { $in: ids } });
  if (prs.size) selectors.push({
    prUrl: { $regex: `/pull/(?:${[...prs].join('|')})(?:[/?#]|$)` },
  });
  const rows = await Task.find({
    podId,
    $or: selectors,
  }).select('taskId assignee claimedBy claimExpiresAt status prUrl').lean() as Array<{
    taskId: string; assignee?: string | null; claimedBy?: string | null;
    claimExpiresAt?: Date | null; status: string; prUrl?: string | null;
  }>;
  const now = Date.now();
  for (const row of rows) {
    if (!ids.includes(row.taskId) && !prs.has(prNumber(row.prUrl) || '')) continue;
    for (const target of targets) {
      const targetKey = key(target);
      const liveClaim = row.status === 'claimed'
        && (!row.claimExpiresAt || new Date(row.claimExpiresAt).getTime() >= now)
        && String(row.claimedBy || '') === (botUserIds.get(targetKey) || '');
      if (assigneeNamesSeat(target, row.assignee) || liveClaim) addressed.add(targetKey);
    }
  }
  return addressed;
}

export const messageReferenceMatchers = { taskRefs, prRefs, prNumber };
