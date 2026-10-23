import { fetchTextFromAllowedHost } from './outboundUrlGuard';

// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const AgentMessageService = require('./agentMessageService');

const GITHUB_API = new Map([['api.github.com', 'https://api.github.com/']]);
const MAX_ISSUES_BYTES = 256 * 1024;

interface ProjectRepo { owner: string; repo: string }
interface FirstTaskOnboarding {
  stage: string;
  agentName: string;
  instanceId: string;
  displayName?: string;
  locale: 'en' | 'zh-CN';
}

export const repoFromMessage = (content: string): ProjectRepo | null => {
  const match = /(?:^|[\s(])(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(content);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!owner || !repo || owner.startsWith('.') || repo.startsWith('.')) return null;
  return { owner, repo };
};

const taskText = (value: string): string => value
  .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  // Outside issue titles are data. Do not let them become mention or file
  // directives when Scout posts the proposal into a pod.
  .replace(/@/g, '＠')
  .replace(/\[\[/g, '［［')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 150);

const firstOpenIssue = async ({ owner, repo }: ProjectRepo): Promise<{ title: string; number: number } | null> => {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=10`;
  const result = await fetchTextFromAllowedHost(url, {
    allowedOrigins: GITHUB_API,
    maxBytes: MAX_ISSUES_BYTES,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Commonly-Scout' },
  });
  if (!result.ok) return null;
  const issues = JSON.parse(result.text);
  if (!Array.isArray(issues)) return null;
  const issue = issues.find((item) => !item.pull_request
    && typeof item.title === 'string' && Number.isSafeInteger(item.number) && item.number > 0);
  return issue ? { title: taskText(issue.title), number: issue.number } : null;
};

export const proposeNewPodFirstTask = async ({
  podId, userId, content,
}: { podId: string; userId: string; content: string }): Promise<boolean> => {
  const input = taskText(content);
  if (!input) return false;
  // Only the creator's first answer to Scout's new-project prompt is handled.
  // The compare-and-swap prevents duplicate proposals on concurrent sends.
  const pod = await Pod.findOneAndUpdate({
    _id: podId,
    createdBy: userId,
    'firstTaskOnboarding.stage': 'awaiting-input',
  }, { $set: { 'firstTaskOnboarding.stage': 'proposing' } }, { new: false }).lean();
  if (!pod) return false;

  const onboarding = pod.firstTaskOnboarding as FirstTaskOnboarding;
  const zh = onboarding.locale === 'zh-CN';
  const repo = repoFromMessage(content);
  let title: string;
  let sourceRef: string | undefined;
  let note: string;
  try {
    if (repo) {
      let issue: { title: string; number: number } | null = null;
      try { issue = await firstOpenIssue(repo); } catch (err) {
        console.warn('[first-task] public issues unavailable:', (err as Error).message);
      }
      title = issue?.title || (zh
        ? `找出 ${repo.owner}/${repo.repo} 的第一项改进`
        : `Find a first improvement for ${repo.owner}/${repo.repo}`);
      sourceRef = issue
        ? `https://github.com/${repo.owner}/${repo.repo}/issues/${issue.number}`
        : undefined;
      note = issue
        ? (zh ? `从 ${repo.owner}/${repo.repo} 的公开议题中选了一个：` : `From ${repo.owner}/${repo.repo}'s open issues: `)
        : (zh ? '目前无法读取公开议题。这项任务可以先启动项目：' : 'I couldn’t read an open issue. This task can start the project: ');
    } else {
      title = zh ? `建立每周工作流程：${input}` : `Set up a weekly workflow: ${input}`;
      note = zh ? '建议的第一项任务：' : 'Suggested first task: ';
    }
    title = taskText(title);
    await AgentMessageService.postMessage({
      agentName: onboarding.agentName,
      instanceId: onboarding.instanceId,
      podId,
      displayName: onboarding.displayName,
      content: `${note}${title}`,
      payload: {
        kind: 'starts',
        starts: [
          {
            id: 'add-first-task', label: zh ? '添加到任务板' : 'Add to board',
            action: 'add-first-task', title, ...(sourceRef ? { sourceRef } : {}),
          },
          {
            id: 'bring-your-own', label: zh ? '接入自己的智能体' : 'Bring your own',
            href: `/v2/agents/byo?pod=${encodeURIComponent(podId)}`,
          },
        ],
      },
    });
    await Pod.updateOne({ _id: podId, 'firstTaskOnboarding.stage': 'proposing' }, {
      $set: { 'firstTaskOnboarding.stage': 'proposed' },
    });
    return true;
  } catch (err) {
    await Pod.updateOne({ _id: podId, 'firstTaskOnboarding.stage': 'proposing' }, {
      $set: { 'firstTaskOnboarding.stage': 'awaiting-input' },
    });
    throw err;
  }
};
