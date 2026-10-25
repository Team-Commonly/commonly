/** GitHub App activity projected into an explicitly bound pod. */
import { Types } from 'mongoose';
import Task from '../models/Task';
import { onTaskClosed } from './roomGrantService';
import GithubGigBinding from '../models/GithubGigBinding';
import { MERGE_EVIDENCE_TEXT } from './initiativeStatus';

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const AgentMessageService = require('./agentMessageService');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { emitTaskUpdated } = require('./taskEventService');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { recordTaskTransition } = require('./taskRecordService');

type Element =
  | { type: 'Text'; text: string }
  | { type: 'Badge'; text: string }
  | { type: 'KeyValue'; label: string; value: string }
  | { type: 'Link'; text: string; href: string }
  | { type: 'List'; rows: string[] }
  | { type: 'Stack'; children: Element[] };

const SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
const NUMBER = /^[1-9][0-9]{0,8}$/;

export const githubLocation = (payload: any): {
  installationId: string; owner: string; repo: string; number: string;
} | null => {
  const installationId = String(payload?.installation?.id ?? '');
  const owner = String(payload?.repository?.owner?.login ?? '');
  const repo = String(payload?.repository?.name ?? '');
  const number = String(payload?.pull_request?.number ?? payload?.issue?.number ?? payload?.check_run?.pull_requests?.[0]?.number ?? '');
  if (!NUMBER.test(installationId) || !SLUG.test(owner) || !SLUG.test(repo) || !NUMBER.test(number)) return null;
  return { installationId, owner, repo, number };
};

export const boundPodForGithubEvent = async (location: ReturnType<typeof githubLocation>): Promise<string | null> => {
  if (!location) return null;
  // One compound indexed read. A tool connection can cover one repository,
  // while the App webhook can deliver many; activity subscriptions are their
  // own explicit pod binding and do not change broker grant ownership.
  const row = await GithubGigBinding.findOne({
    installationId: location.installationId, owner: location.owner.toLowerCase(), repo: location.repo.toLowerCase(),
  }).select('podId').lean();
  const podId = row?.podId;
  return Types.ObjectId.isValid(String(podId || '')) ? String(podId) : null;
};

export const buildGithubGigCard = (eventType: string, payload: any, location: NonNullable<ReturnType<typeof githubLocation>>) => {
  const { owner, repo, number } = location;
  const issueEvent = eventType === 'issues';
  const pull = payload.pull_request;
  const review = payload.review;
  const merged = eventType === 'pull_request' && payload.action === 'closed' && pull?.merged === true;
  const eventLabel = merged ? 'Merged' : eventType === 'pull_request_review' ? 'Review submitted'
    : eventType === 'check_run' ? 'Check failed'
      : issueEvent ? (payload.action === 'closed' ? 'Issue closed' : 'Issue opened') : 'PR opened';
  const href = `https://github.com/${owner}/${repo}/${issueEvent ? 'issues' : 'pull'}/${number}`;
  const elements: Element[] = [
    { type: 'Stack', children: [
      { type: 'Badge', text: eventLabel },
      // Until Wren rules on outsider text, the card names the event and id;
      // it never copies a PR title, issue body, or review body from GitHub.
      { type: 'Text', text: `${issueEvent ? 'Issue' : 'Pull request'} #${number}` },
    ] },
    { type: 'KeyValue', label: 'Repository', value: `${owner}/${repo}` },
    { type: 'Link', text: `Open ${issueEvent ? 'issue' : 'pull request'} #${number}`, href },
  ];
  if (review?.state) {
    const state = String(review.state).toLowerCase();
    const label = ({ approved: 'Approved', changes_requested: 'Changes requested', commented: 'Commented', dismissed: 'Dismissed' } as Record<string, string>)[state];
    if (label) elements.push({ type: 'KeyValue', label: 'Review', value: label });
  }
  if (eventType === 'check_run') elements.push({ type: 'KeyValue', label: 'Check', value: 'Failure' });
  const card = { kind: 'gig-card', source: 'github', elements };
  // A closed catalog and a hard size bound keep the payload a small display
  // object. Freeform descriptions/bodies never enter it or the context text.
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > 32 * 1024) return null;
  return card;
};

export const completeTaskForMergedPull = async (podId: string, href: string): Promise<void> => {
  const at = new Date();
  // Every open task linked to the PR gets its own merge record: initiative
  // status requires one per done task (initiativeStatus.ts). One atomic update
  // per task, so each emits its own board event and a retry finishes the rest.
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const task = await Task.findOneAndUpdate(
      { podId: new Types.ObjectId(podId), prUrl: href, status: { $in: ['pending', 'claimed'] } },
      { $inc: { grantEpoch: 1 }, $set: { status: 'done', claimedByUserId: null, completedAt: at }, $push: { updates: {
        text: MERGE_EVIDENCE_TEXT, author: 'system', authorId: null, createdAt: at,
      } } },
      { new: true },
    );
    if (!task) return;
    // eslint-disable-next-line no-await-in-loop
    await onTaskClosed(task);
    emitTaskUpdated(podId, task, 'updated');
    recordTaskTransition({ podId, task, from: null, to: 'done', at });
  }
};

export const handleGithubGig = async ({ eventType, payload, podId, location }: {
  eventType: string; payload: any; podId: string; location: NonNullable<ReturnType<typeof githubLocation>>;
}): Promise<void> => {
  if (!location || !podId) return;
  const card = buildGithubGigCard(eventType, payload, location);
  if (!card) return;
  if (eventType === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged === true) {
    // Complete first: the update is idempotent on status, so a later card
    // failure can be retried without re-completing the task.
    await completeTaskForMergedPull(podId, `https://github.com/${location.owner}/${location.repo}/pull/${location.number}`);
  }
  const bot = await AgentIdentityService.getOrCreateAgentUser('commonly-bot');
  // `_postToTarget` is the system-card path: public agent posting applies a
  // consecutive-run cap and may suppress a stream of provider events. The
  // content deliberately contains no outsider-controlled title/body; agent
  // context reads content, whereas humans render the literal card payload.
  await AgentMessageService._postToTarget({
    agentName: 'commonly-bot', agentUser: bot, podId,
    displayName: 'GitHub', messageType: 'card', payload: card,
    content: '[GitHub activity]', metadata: { source: 'github-gig' },
    skipSummaryPersistence: true, noOutboundRelay: true,
  });
};

export default { githubLocation, boundPodForGithubEvent, buildGithubGigCard, completeTaskForMergedPull, handleGithubGig };
