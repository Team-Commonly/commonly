import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GuidePage from './GuidePage';

// Every live guide gets its revised pass in time, so the unrevised case is a fixture:
// a real guide with `revised` and `answer` taken off, served next to the real ones.
jest.mock('../../content/guides.json', () => {
  const real = jest.requireActual('../../content/guides.json');
  const { revised, answer, ...unrevised } = real['ai-agent-memory'];
  return { ...real, 'unrevised-fixture': unrevised };
});

test('guide related links no longer offer the unlisted compare page', () => {
  render(
    <MemoryRouter initialEntries={['/guides/multi-agent-collaboration-platform']}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.getByRole('button', { name: 'Explore agent collaboration' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Compare Commonly' })).not.toBeInTheDocument();
  expect(document.querySelector('a[href="/compare/"]')).toBeNull();
});

test('a guide with no FAQ entries shows no FAQ heading', () => {
  const renderGuide = (id: string) => render(
    <MemoryRouter initialEntries={[`/guides/${id}`]}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );

  const { unmount } = renderGuide('claude-code-team-chat-mentions');
  expect(screen.queryByRole('heading', { name: 'Frequently asked questions' })).not.toBeInTheDocument();
  unmount();
  renderGuide('ai-agent-collaboration-platforms');
  expect(screen.getByRole('heading', { name: 'Frequently asked questions' })).toBeInTheDocument();
});

const renderGuideAt = (id: string) => render(
  <MemoryRouter initialEntries={[`/guides/${id}`]}>
    <Routes>
      <Route path="/guides/:guideId" element={<GuidePage />} />
    </Routes>
  </MemoryRouter>,
);

test('a revised guide shows its short answer, Sam as author and its revised date, as the static page does', () => {
  renderGuideAt('multi-agent-collaboration-platform');
  const answer = screen.getByText('Short answer.').parentElement as HTMLElement;
  expect(answer.textContent).toMatch(/^Short answer\. A multi-agent collaboration platform gives people and agents/);
  // The answer sits between the byline and the intro, as on the static page.
  expect(answer.previousElementSibling?.textContent).toMatch(/^By Sam Xu · Reviewed by/);
  expect(answer.nextElementSibling?.firstElementChild?.tagName).toBe('P');
  const author = screen.getByRole('link', { name: 'Sam Xu' });
  expect(author).toHaveAttribute('href', 'https://x.com/sam_commonly');
  expect(author).toHaveAttribute('rel', 'author');
  expect(answer.previousElementSibling?.textContent).toContain('Published August 24, 2026 · Updated November 11, 2026');
});

test('a revised guide whose original dates match still shows its revised date as Updated', () => {
  renderGuideAt('ai-agent-memory');
  const byline = screen.getByText('Short answer.').parentElement?.previousElementSibling as HTMLElement;
  expect(byline.textContent).toContain('Published August 30, 2026 · Updated November 11, 2026');
  expect(byline.textContent).not.toContain('Published and updated');
});

test('a guide without a revised pass renders as before: no short answer, the provenance author and dates', () => {
  renderGuideAt('unrevised-fixture');
  expect(screen.queryByText('Short answer.')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Sam Xu' })).not.toBeInTheDocument();
  const byline = screen.getByText(/By Commonly · Reviewed by Commonly SEO team/);
  expect(byline.textContent).toContain('Published and updated August 30, 2026');
});

test('the three question guides render, and the Slack one says it does not replace Slack', () => {
  const renderGuide = (id: string) => render(
    <MemoryRouter initialEntries={[`/guides/${id}`]}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );

  const slack = renderGuide('open-source-slack-alternative-ai-agents');
  expect(screen.getByRole('heading', { level: 1, name: 'Open source Slack alternative with AI agents built in' })).toBeInTheDocument();
  // The answer in the same FAQ box as the question, not the connector line elsewhere on the page.
  const faqItem = screen.getByRole('heading', { level: 3, name: 'Does Commonly replace Slack?' }).parentElement as HTMLElement;
  expect(within(faqItem).getByText(/^No\. Teams use Commonly alongside their chat\./)).toBeInTheDocument();
  expect(screen.queryByText(/full (Slack )?replacement/)).toBeNull();
  expect(screen.getByText('Some external chat channels can be brought into a Commonly pod through a connector.')).toBeInTheDocument();
  slack.unmount();
  const seeing = renderGuide('see-what-your-coding-agent-is-doing');
  expect(screen.getByRole('heading', { level: 1, name: 'How can my teammates see what my coding agent is doing?' })).toBeInTheDocument();
  expect(document.querySelector('a[href="/guides/ai-agent-observability/"]')).not.toBeNull();
  seeing.unmount();
  renderGuide('share-context-between-claude-code-sessions');
  expect(screen.getByRole('heading', { level: 1, name: 'How do I share context between Claude Code sessions across my team?' })).toBeInTheDocument();
  expect(document.querySelector('a[href="https://code.claude.com/docs/en/memory"]')).not.toBeNull();
});

test('the duplicate-work guide renders, says a second claim is refused, and says a claim does not lock the repo', () => {
  render(
    <MemoryRouter initialEntries={['/guides/coding-agents-one-repo-no-duplicate-work']}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', {
    level: 1,
    name: "How can a few people's coding agents work on one repo without doing the same task twice?",
  })).toBeInTheDocument();
  // Each answer read in the same FAQ box as its question.
  const twoClaims = screen.getByRole('heading', { level: 3, name: 'What happens if two agents try to take the same task?' }).parentElement as HTMLElement;
  expect(within(twoClaims).getByText(/^The first claim holds\. The second agent's claim is refused/)).toBeInTheDocument();
  const lock = screen.getByRole('heading', { level: 3, name: 'Does a claim stop another agent from editing the same files?' }).parentElement as HTMLElement;
  expect(within(lock).getByText(/^No\. .*It doesn't lock the repo/)).toBeInTheDocument();
  expect(screen.getAllByText(/Codex on a Mac/).length).toBeGreaterThan(0);
  expect(document.querySelector('a[href="/guides/run-claude-code-and-codex-together/"]')).not.toBeNull();
});

test('the Claude Code team guide renders, says an agent team cannot be shared across sessions, and links the chat guide', () => {
  render(
    <MemoryRouter initialEntries={['/guides/claude-code-team-collaboration']}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { level: 1, name: 'What tool lets a team collaborate with Claude Code?' })).toBeInTheDocument();
  // Each answer read in the same FAQ box as its question.
  const share = screen.getByRole('heading', { level: 3, name: 'Can two people share one Claude Code agent team?' }).parentElement as HTMLElement;
  expect(within(share).getByText(/^No\. .*can't share a team across sessions/)).toBeInTheDocument();
  expect(screen.getAllByText(/Codex on a Mac/).length).toBeGreaterThan(0);
  expect(screen.getByText(/CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1/)).toBeInTheDocument();
  expect(screen.getByText(/^Agent teams are experimental and off by default\./)).toBeInTheDocument();
  expect(screen.getByText(/one team per session as a limitation, and you can't share a team across sessions/)).toBeInTheDocument();
  expect(screen.getByText(/add --allow write the first time you run it\. Grant that only in a pod where you trust everyone/)).toBeInTheDocument();
  // Commonly steps cite Commonly sources ([6]-[10]); [1]-[5] are Anthropic's docs.
  expect(screen.getByText(/^Ask your agent in the pod to take the next open task\. It claims the task before it starts\. \[7\] \[8\]$/)).toBeInTheDocument();
  expect(screen.getByText(/The folder access above is for Claude Code only\. \[6\] \[10\]$/)).toBeInTheDocument();
  expect(document.querySelector('a[href="/guides/claude-code-team-chat-mentions/"]')).not.toBeNull();
});

test('the multi-agent workspace guide renders, says an agent team is one person\'s, and that a second claim is refused', () => {
  render(
    <MemoryRouter initialEntries={['/guides/multi-agent-workspace-software-teams']}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { level: 1, name: 'What is a multi-agent workspace for software teams?' })).toBeInTheDocument();
  // Each answer read in the same FAQ box as its question.
  const same = screen.getByRole('heading', { level: 3, name: "Is this the same as Claude Code's agent teams?" }).parentElement as HTMLElement;
  expect(within(same).getByText(/^No\. An agent team is one person's sessions working together, and it can't be shared across sessions\./)).toBeInTheDocument();
  const twice = screen.getByRole('heading', { level: 3, name: 'Can two agents end up on the same task?' }).parentElement as HTMLElement;
  expect(within(twice).getByText(/^Not through the board\. The second claim is refused, and the agent is told who has the task\. \[4\]$/)).toBeInTheDocument();
  expect(screen.getAllByText(/Codex on a Mac/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/Codex on Windows|Codex \(Mac or Linux\)/)).toBeNull();
  // No 'any agent' claim: you @ your own agent or a teammate's.
  expect(screen.queryByText(/@ any agent|anyone's coding agent/)).toBeNull();
  expect(screen.getByText(/add --allow write the first time you run it\. Grant that only in a pod where you trust everyone/)).toBeInTheDocument();
  // The steps sit above the command, so they point down to it.
  expect(screen.getByText(/^Each person connects their own agent with the command below\. For Codex on a Mac, use --adapter codex\. The folder access above is for Claude Code only\. \[2\] \[6\]$/)).toBeInTheDocument();
  expect(document.querySelector('a[href="/guides/run-claude-code-and-codex-together/"]')).not.toBeNull();
  expect(document.querySelector('a[href="/guides/claude-code-team-collaboration/"]')).not.toBeNull();
});

test('the Claude Code and Codex team chat guide renders both ways, keeps Codex on a Mac, and says how an agent-to-agent loop is cut off', () => {
  render(
    <MemoryRouter initialEntries={['/guides/claude-code-and-codex-in-one-team-chat']}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { level: 1, name: 'How do you get Claude Code and Codex agents working in the same team chat?' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: "Both vendors' apps in Slack" })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: "Each teammate's own agent, in one pod (Commonly)" })).toBeInTheDocument();
  expect(screen.getByText(/ChatGPT can send repository work to a separate Codex Cloud task and bring the result back to the thread\. \[4\]$/)).toBeInTheDocument();
  expect(screen.getByText(/^On native Windows, Codex answers only when every pod it answers in is invite-only, and only with the --unsandboxed flag\. There's no sandbox there/)).toBeInTheDocument();
  expect(screen.getByText(/A person's @mention always goes through\. If agents keep @mentioning one agent, the pod stops passing their @mentions to it after more than three in that pod in five minutes\. \[7\]$/)).toBeInTheDocument();
  const each = screen.getByRole('heading', { level: 3, name: 'Can Claude Code and Codex @mention each other?' }).parentElement as HTMLElement;
  expect(within(each).getByText(/^In a Commonly pod, yes\./)).toBeInTheDocument();
  expect(screen.getAllByText(/Codex on a Mac/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/Codex on Windows|Codex \(Mac or Linux\)|@ any agent|anyone's coding agent/)).toBeNull();
  expect(document.querySelector('a[href="/guides/claude-code-team-chat-mentions/"]')).not.toBeNull();
  expect(document.querySelector('a[href="/guides/run-claude-code-and-codex-together/"]')).not.toBeNull();
  expect(document.querySelector('a[href="https://developers.openai.com/codex/integrations/slack"]')).not.toBeNull();
});
