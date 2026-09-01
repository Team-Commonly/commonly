import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPageDefinitions, renderStaticPage } from './generate-seo-pages.mjs';

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('emits a canonical crawlable page for every public route', async () => {
  const [translationText, useCaseText, guideText, indexHtml] = await Promise.all([
    readFile(resolve(frontendDir, 'src/i18n/locales/en.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/use-cases.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/guides.json'), 'utf8'),
    readFile(resolve(frontendDir, 'index.html'), 'utf8'),
  ]);
  const translations = JSON.parse(translationText);
  const useCases = JSON.parse(useCaseText);
  const guides = JSON.parse(guideText);
  const pages = buildPageDefinitions({ landing: translations.landing, compare: translations.compare, useCases, guides });

  assert.equal(pages.length, 49);
  assert.deepEqual(pages.map((page) => page.path), [
    '/',
    '/compare/',
    '/use-cases/team-chat/',
    '/use-cases/agent-collab/',
    '/use-cases/research-desk/',
    '/use-cases/daily-digest/',
    '/use-cases/community/',
    '/use-cases/pod-browser/',
    '/use-cases/app-marketplace/',
    '/guides/',
    '/guides/multi-agent-collaboration-platform/',
    '/guides/ai-agent-workspace/',
    '/guides/ai-agent-task-management/',
    '/guides/connect-claude-codex-shared-workspace/',
    '/guides/ai-agent-memory/',
    '/guides/human-in-the-loop-ai-agents/',
    '/guides/ai-agent-handoffs/',
    '/guides/how-to-build-an-ai-agent-team/',
    '/guides/agent-to-agent-messaging/',
    '/guides/self-hosted-ai-agent-platform/',
    '/guides/ai-agent-permissions-and-tokens/',
    '/guides/connect-cursor-shared-workspace/',
    '/guides/ai-agent-observability/',
    '/guides/ai-agent-events/',
    '/guides/multi-agent-vs-single-agent/',
    '/guides/ai-agent-collaboration-patterns/',
    '/guides/onboarding-an-ai-agent-to-your-team/',
    '/guides/ai-agent-discord-integration/',
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/ai-agent-heartbeats-and-scheduled-work/',
    '/guides/ai-agent-marketplace-roles/',
    '/guides/connect-a-custom-agent-http-api/',
    '/guides/what-is-an-agent-pod/',
    '/guides/connect-openclaw-agent/',
    '/guides/ai-agent-security-best-practices/',
    '/guides/ai-agent-cli/',
    '/guides/ai-agent-orchestration/',
    '/guides/ai-agent-skills/',
    '/guides/autonomous-ai-agents/',
    '/guides/ai-agent-sandboxing/',
    '/guides/ai-agent-tools/',
    '/guides/prompt-injection-defense-for-ai-agents/',
    '/guides/mcp-for-ai-agent-teams/',
    '/guides/what-is-agentic-ai/',
    '/guides/what-is-an-ai-agent/',
    '/guides/context-engineering-for-ai-agents/',
    '/guides/how-to-evaluate-ai-agents/',
    '/guides/ai-agent-vs-chatbot/',
    '/guides/ai-agent-use-cases/',
  ]);
  assert.deepEqual(pages[0].schema['@graph'].map((item) => item['@type']), [
    'Organization',
    'WebSite',
    'SoftwareApplication',
    'WebPage',
  ]);
  const organization = pages[0].schema['@graph'].find((item) => item['@type'] === 'Organization');
  const website = pages[0].schema['@graph'].find((item) => item['@type'] === 'WebSite');
  const softwareApplication = pages[0].schema['@graph'].find((item) => item['@type'] === 'SoftwareApplication');
  assert.equal(organization['@id'], 'https://commonly.me/#organization');
  assert.deepEqual(organization.alternateName, ['Commonly.me', 'commonly.me', 'Commonly AI']);
  assert.deepEqual(organization.sameAs, [
    'https://github.com/Team-Commonly/commonly',
    'https://www.npmjs.com/package/@commonlyai/mcp',
    'https://discord.gg/NsS3fzsJDw',
  ]);
  assert.equal(website['@id'], 'https://commonly.me/#website');
  assert.deepEqual(website.publisher, { '@id': organization['@id'] });
  assert.deepEqual(softwareApplication.publisher, { '@id': organization['@id'] });
  const landingWebPage = pages[0].schema['@graph'].find((item) => item['@type'] === 'WebPage');
  assert.equal(landingWebPage.name, pages[0].title);
  assert.equal(landingWebPage.description, pages[0].description);
  for (const page of pages) {
    const graph = page.schema['@graph'] || [page.schema];
    const webPage = graph.find((item) => item['@type'] === 'WebPage');
    assert.deepEqual(webPage.isPartOf, { '@id': website['@id'] });
  }
  const guidePages = pages.filter((page) => page.path.startsWith('/guides/') && page.path !== '/guides/');
  const refreshedGuidePaths = new Set([
    '/guides/multi-agent-collaboration-platform/',
    '/guides/ai-agent-workspace/',
    '/guides/ai-agent-task-management/',
    '/guides/connect-claude-codex-shared-workspace/',
  ]);
  assert.equal(guidePages.length, 39);
  for (const guide of guidePages) {
    assert.equal(guide.ogType, 'article');
    const article = guide.schema['@graph'].find((item) => item['@type'] === 'Article');
    const webPage = guide.schema['@graph'].find((item) => item['@type'] === 'WebPage');
    assert.equal(article.author['@type'], 'Organization');
    assert.equal(webPage.reviewedBy['@type'], 'Organization');
    assert.match(article.datePublished, /^2026-(?:08|09)-\d{2}$/);
    assert.match(article.dateModified, /^2026-(?:08|09)-\d{2}$/);
    if (refreshedGuidePaths.has(guide.path)) {
      assert.equal(article.dateModified, '2026-08-30');
    }
  }
  const taskManagementGuide = guidePages.find((page) => page.path === '/guides/ai-agent-task-management/');
  assert.equal(taskManagementGuide.title, 'AI Agent Task Management: Humans + Agents | Commonly');
  const taskManagementArticle = taskManagementGuide.schema['@graph'].find((item) => item['@type'] === 'Article');
  assert.equal(taskManagementArticle.datePublished, '2026-08-25');
  assert.equal(taskManagementArticle.dateModified, '2026-08-30');
  const guideTemplate = '<head><!-- SEO_METADATA_START --><!-- SEO_METADATA_END --><!-- SEO_GATE_START --><script>document.documentElement.className += \' js\';</script><!-- SEO_GATE_END --><style>#seo-page { color: #fff; }</style><!-- SEO_NAVIGATION_RUNTIME_START --><script>window.addEventListener(\'popstate\', () => {});</script><!-- SEO_NAVIGATION_RUNTIME_END --><link rel="modulepreload" href="/assets/chunk.js"><script type="module" crossorigin src="/assets/index-abcd.js"></script></head><body><div id="root"><!-- SEO_PAGE_CONTENT --></div></body>';
  const sharedWorkspaceGuide = guidePages.find((page) => page.path === '/guides/connect-claude-codex-shared-workspace/');
  assert.equal(sharedWorkspaceGuide.title, 'Connect Claude Code and Codex to a Shared Workspace | Commonly');
  const sharedWorkspaceArticle = sharedWorkspaceGuide.schema['@graph'].find((item) => item['@type'] === 'Article');
  assert.equal(sharedWorkspaceArticle.datePublished, '2026-08-26');
  assert.equal(sharedWorkspaceArticle.dateModified, '2026-08-30');
  const taskManagementHtml = renderStaticPage(guideTemplate, taskManagementGuide);
  assert.match(taskManagementHtml, /By Commonly · Reviewed by Commonly SEO team/);
  assert.match(taskManagementHtml, /article:published_time" content="2026-08-25"/);
  assert.match(taskManagementHtml, /article:modified_time" content="2026-08-30"/);
  assert.match(taskManagementHtml, /href="\/guides\/multi-agent-collaboration-platform\/"/);
  assert.match(taskManagementHtml, /href="\/guides\/ai-agent-workspace\/"/);
  assert.doesNotMatch(taskManagementHtml, /document\.documentElement/);
  assert.doesNotMatch(taskManagementHtml, /popstate/);
  assert.doesNotMatch(taskManagementHtml, /modulepreload/);
  assert.doesNotMatch(taskManagementHtml, /type="module"/);
  assert.doesNotMatch(taskManagementHtml, /src="\/assets\/index-/);
  assert.match(taskManagementHtml, /#seo-page \{ display: block !important; \}/);
  assert.match(taskManagementHtml, /#seo-page \{ color: #fff; \}/);
  const sharedWorkspaceHtml = renderStaticPage(guideTemplate, sharedWorkspaceGuide);
  assert.match(sharedWorkspaceHtml, /codex mcp add commonly/);
  assert.match(sharedWorkspaceHtml, /class="language-bash"/);
  const memoryGuide = guidePages.find((page) => page.path === '/guides/ai-agent-memory/');
  assert.equal(memoryGuide.title, 'Shared Memory for AI Agents: Private, Shared, Durable | Commonly');
  const memoryHtml = renderStaticPage(guideTemplate, memoryGuide);
  assert.match(memoryHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(memoryHtml, /<table class="seo-table">/);
  assert.match(memoryHtml, /https:\/\/docs\.langchain\.com\/oss\/python\/deepagents\/memory/);
  assert.match(memoryHtml, /href="\/guides\/connect-claude-codex-shared-workspace\//);
  assert.match(memoryHtml, /href="\/guides\/human-in-the-loop-ai-agents\//);
  assert.match(memoryHtml, /href="\/guides\/agent-to-agent-messaging\//);
  const humanReviewGuide = guidePages.find((page) => page.path === '/guides/human-in-the-loop-ai-agents/');
  assert.equal(humanReviewGuide.title, 'Human-in-the-Loop Review for AI Agent Teams | Commonly');
  const humanReviewHtml = renderStaticPage(guideTemplate, humanReviewGuide);
  assert.match(humanReviewHtml, /Human-in-the-loop review is a deliberate pause at a meaningful handoff/);
  assert.match(humanReviewHtml, /It is not a person reading every token an agent produces\./);
  assert.match(humanReviewHtml, /href="\/guides\/ai-agent-memory\//);
  assert.match(humanReviewHtml, /https:\/\/learn\.microsoft\.com\/en-us\/agent-framework\/workflows\/human-in-the-loop/);
  assert.match(humanReviewHtml, /href="\/guides\/ai-agent-handoffs\//);
  assert.match(humanReviewHtml, /href="\/guides\/agent-to-agent-messaging\//);
  const handoffsGuide = guidePages.find((page) => page.path === '/guides/ai-agent-handoffs/');
  assert.equal(handoffsGuide.title, 'AI Agent Handoffs: Transfer Work Without Losing Context | Commonly');
  const handoffsHtml = renderStaticPage(guideTemplate, handoffsGuide);
  assert.match(handoffsHtml, /An AI agent handoff is the transfer of a piece of work to a new owner/);
  assert.match(handoffsHtml, /href="\/guides\/ai-agent-memory\//);
  assert.match(handoffsHtml, /href="\/guides\/human-in-the-loop-ai-agents\//);
  assert.match(handoffsHtml, /https:\/\/openai\.com\/business\/guides-and-resources\/a-practical-guide-to-building-ai-agents\//);
  assert.match(handoffsHtml, /https:\/\/learn\.microsoft\.com\/en-us\/agent-framework\/workflows\/orchestrations\/handoff/);
  assert.match(handoffsHtml, /href="\/guides\/how-to-build-an-ai-agent-team\//);
  assert.match(handoffsHtml, /href="\/guides\/agent-to-agent-messaging\//);
  const teamGuide = guidePages.find((page) => page.path === '/guides/how-to-build-an-ai-agent-team/');
  assert.equal(teamGuide.title, 'How to Build an AI Agent Team: Roles, Handoffs, and Review | Commonly');
  const teamHtml = renderStaticPage(guideTemplate, teamGuide);
  assert.match(teamHtml, /An AI agent team is a small group of people and agents with distinct responsibilities/);
  assert.match(teamHtml, /href="\/guides\/ai-agent-memory\//);
  assert.match(teamHtml, /href="\/guides\/human-in-the-loop-ai-agents\//);
  assert.match(teamHtml, /href="\/guides\/ai-agent-handoffs\//);
  assert.match(teamHtml, /https:\/\/openai\.com\/business\/guides-and-resources\/a-practical-guide-to-building-ai-agents\//);
  assert.match(teamHtml, /href="\/guides\/agent-to-agent-messaging\//);
  const messagingGuide = guidePages.find((page) => page.path === '/guides/agent-to-agent-messaging/');
  assert.equal(messagingGuide.title, 'Agent-to-Agent Messaging: How AI Agents DM | Commonly');
  const messagingHtml = renderStaticPage(guideTemplate, messagingGuide);
  assert.match(messagingHtml, /An agent-to-agent message is a focused, one-to-one request or response/);
  assert.match(messagingHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(messagingHtml, /commonly_dm_agent/);
  assert.match(messagingHtml, /href="\/guides\/multi-agent-collaboration-platform\//);
  assert.match(messagingHtml, /href="\/guides\/connect-claude-codex-shared-workspace\//);
  assert.match(messagingHtml, /href="\/guides\/ai-agent-handoffs\//);
  assert.match(messagingHtml, /href="\/guides\/human-in-the-loop-ai-agents\//);
  assert.match(messagingHtml, /https:\/\/a2a-protocol\.org\//);
  assert.match(messagingHtml, /Conceptually, the tool flow looks like this:<\/p>\s*<ol>/);
  assert.match(messagingHtml, /Use this pattern:<\/p>\s*<pre class="seo-code">/);
  assert.match(messagingHtml, /<h2>When a shared thread is better than a DM<\/h2>\s*<p>Choose a thread[^<]*<\/p>\s*<ul>/);
  assert.match(messagingHtml, /<h2>When a DM is the better choice<\/h2>\s*<p>Choose a DM[^<]*<\/p>\s*<ul>/);
  const selfHostedGuide = guidePages.find((page) => page.path === '/guides/self-hosted-ai-agent-platform/');
  assert.equal(selfHostedGuide.title, 'Self-Hosted AI Agent Platform: What to Look For | Commonly');
  const selfHostedHtml = renderStaticPage(guideTemplate, selfHostedGuide);
  assert.match(selfHostedHtml, /A self-hosted AI agent platform is software you deploy and operate/);
  assert.match(selfHostedHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(selfHostedHtml, /https:\/\/csrc\.nist\.gov\/pubs\/sp\/800\/190\/final/);
  assert.match(selfHostedHtml, /https:\/\/docs\.docker\.com\/compose\/trust-model\//);
  assert.match(selfHostedHtml, /https:\/\/docs\.docker\.com\/compose\/how-tos\/use-secrets\//);
  assert.match(selfHostedHtml, /https:\/\/docs\.docker\.com\/compose\/how-tos\/production\//);
  assert.match(selfHostedHtml, /<h2>Step 1: Map the architecture you are about to run<\/h2>/);
  assert.match(selfHostedHtml, /You still need to decide:<\/p>\s*<ul>/);
  assert.match(selfHostedHtml, /The local path is intentionally short:<\/p>\s*<pre class="seo-code">/);
  assert.match(selfHostedHtml, /Before installing a public instance[^<]*:<\/p>\s*<ul>/);
  assert.match(selfHostedHtml, /Self-hosting Commonly can give[^<]*does not, by itself:<\/p>\s*<ul>/);
  assert.match(selfHostedHtml, /<h2>Choose the responsibility you are ready to operate<\/h2><p>These gaps are not reasons to avoid self-hosting\./);
  assert.match(selfHostedHtml, /href="\/guides\/connect-claude-codex-shared-workspace\//);
  assert.match(selfHostedHtml, /href="\/guides\/ai-agent-memory\//);
  const permissionsGuide = guidePages.find((page) => page.path === '/guides/ai-agent-permissions-and-tokens/');
  assert.equal(permissionsGuide.title, 'AI Agent Permissions and Tokens: Scope Runtime Access Safely | Commonly');
  const permissionsHtml = renderStaticPage(guideTemplate, permissionsGuide);
  assert.match(permissionsHtml, /An AI agent runtime token is a bearer credential that identifies a specific agent installation/);
  assert.match(permissionsHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(permissionsHtml, /<h2>Separate authentication, authorization, and tool permissions<\/h2>\s*<p>These three ideas[^<]*They are different layers:<\/p>\s*<div class="seo-table-wrap">/);
  assert.match(permissionsHtml, /<h2>Why the layers must stay separate<\/h2>/);
  assert.match(permissionsHtml, /https:\/\/csrc\.nist\.gov\/glossary\/term\/least_privilege/);
  assert.match(permissionsHtml, /https:\/\/cheatsheetseries\.owasp\.org\/cheatsheets\/Secrets_Management_Cheat_Sheet\.html/);
  assert.match(permissionsHtml, /It does authorize meaningful work[^<]*<\/p>\s*<p>Commonly documents two agent-related token categories[^<]*<\/p>\s*<div class="seo-table-wrap">/);
  assert.match(permissionsHtml, /<strong>Adding an agent to a pod is also an access decision for its runtime token\.<\/strong>/);
  assert.match(permissionsHtml, /Before adding an existing agent[^<]*questions:<\/p>\s*<ul>/);
  assert.match(permissionsHtml, /Once issued, a runtime request uses the token in the authorization header:<\/p>\s*<pre class="seo-code">/);
  assert.match(permissionsHtml, /Commonly’s documentation recommends an environment variable[^<]*:<\/p>\s*<pre class="seo-code">/);
  assert.match(permissionsHtml, /Use a controlled test sequence:<\/p>\s*<ol>/);
  assert.match(permissionsHtml, /A practical response sequence is:<\/p>\s*<ol>/);
  assert.match(permissionsHtml, /<h2>Sharing a token between installations<\/h2>/);
  assert.match(permissionsHtml, /<h2>Assuming token scope governs local tools<\/h2>/);
  assert.match(permissionsHtml, /href="\/guides\/connect-claude-codex-shared-workspace\//);
  assert.match(permissionsHtml, /href="\/guides\/ai-agent-task-management\//);
  const cursorGuide = guidePages.find((page) => page.path === '/guides/connect-cursor-shared-workspace/');
  assert.equal(cursorGuide.title, 'How to Connect Cursor to a Shared Workspace | Commonly');
  const cursorHtml = renderStaticPage(guideTemplate, cursorGuide);
  assert.match(cursorHtml, /Connecting Cursor to a shared workspace gives the agent you use in Cursor/);
  assert.match(cursorHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(cursorHtml, /~\/\.cursor\/mcp\.json/);
  assert.match(cursorHtml, /@commonlyai\/mcp/);
  assert.match(cursorHtml, /cm_agent_\.\.\./);
  assert.match(cursorHtml, /It is not a bundled development environment\.<\/p>\s*<div class="seo-table-wrap">/);
  assert.match(cursorHtml, /In Cursor, invoke the agent with a request like this:<\/p>\s*<pre class="seo-code">/);
  assert.match(cursorHtml, /<h2>Verify both sides of the access boundary<\/h2>\s*<p>[^<]*<\/p>\s*<p>Confirm all four:<\/p>\s*<ol>/);
  assert.match(cursorHtml, /<h2>Give the first task a boundary<\/h2>/);
  const observabilityGuide = guidePages.find((page) => page.path === '/guides/ai-agent-observability/');
  assert.equal(observabilityGuide.title, 'AI Agent Observability: Make Work, Handoffs, and Decisions Visible | Commonly');
  const observabilityHtml = renderStaticPage(guideTemplate, observabilityGuide);
  assert.match(observabilityHtml, /AI agent observability is the ability to answer a practical set of questions/);
  assert.match(observabilityHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(observabilityHtml, /pending, claimed, blocked, and done/);
  assert.match(observabilityHtml, /A strong thread update has five parts:<\/p>\s*<pre class="seo-code">/);
  assert.match(observabilityHtml, /Objective: The outcome this work is intended to produce\.[\s\S]*Owner: The person or agent responsible for that action\./);
  assert.match(observabilityHtml, /The right response is to connect the signals:<\/p>\s*<div class="seo-table-wrap">/);
  const eventsGuide = guidePages.find((page) => page.path === '/guides/ai-agent-events/');
  assert.equal(eventsGuide.title, 'AI Agent Events: Mentions, Tasks, Heartbeats, and Safe Handling | Commonly');
  const eventsHtml = renderStaticPage(guideTemplate, eventsGuide);
  assert.match(eventsHtml, /An AI agent event is a structured signal/);
  assert.match(eventsHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  for (const eventType of ['chat\\.mention', 'thread\\.mention', 'task\\.assigned', 'heartbeat', 'integration\\.event']) {
    assert.match(eventsHtml, new RegExp(eventType));
  }
  assert.match(eventsHtml, /When a polled event includes payload\.deliveryId, the acknowledgement must echo that exact value\.[^<]*For example:<\/p>\s*<pre class="seo-code">/);
  assert.match(eventsHtml, /cm_agent_\.\.\./);
  assert.doesNotMatch(eventsHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const comparisonGuide = guidePages.find((page) => page.path === '/guides/multi-agent-vs-single-agent/');
  assert.equal(comparisonGuide.title, 'Multi-Agent vs. Single-Agent Systems: How to Choose | Commonly');
  const comparisonHtml = renderStaticPage(guideTemplate, comparisonGuide);
  assert.match(comparisonHtml, /A single-agent system gives one named agent responsibility/);
  assert.match(comparisonHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(comparisonHtml, /A useful contract includes:<\/p>\s*<pre class="seo-code">/);
  assert.match(comparisonHtml, /pending, claimed, blocked, and done/);
  assert.match(comparisonHtml, /A task claim is a visible coordination signal/);
  assert.doesNotMatch(comparisonHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const patternsGuide = guidePages.find((page) => page.path === '/guides/ai-agent-collaboration-patterns/');
  assert.equal(patternsGuide.title, 'AI Agent Collaboration Patterns: Leads, Reviewers, Claims, and Races | Commonly');
  const patternsHtml = renderStaticPage(guideTemplate, patternsGuide);
  assert.match(patternsHtml, /AI agent collaboration patterns are repeatable ways/);
  assert.match(patternsHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(patternsHtml, /Use this task contract:<\/p>\s*<pre class="seo-code">/);
  assert.match(patternsHtml, /returns the existing task rather than creating another one/);
  assert.match(patternsHtml, /A claim is a coordination signal/);
  assert.doesNotMatch(patternsHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const onboardingGuide = guidePages.find((page) => page.path === '/guides/onboarding-an-ai-agent-to-your-team/');
  assert.equal(onboardingGuide.title, 'How to Onboard an AI Agent to Your Team | Commonly');
  const onboardingHtml = renderStaticPage(guideTemplate, onboardingGuide);
  assert.match(onboardingHtml, /Onboarding an AI agent to a team is the process of/);
  assert.match(onboardingHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(onboardingHtml, /<pre class="seo-code">[\s\S]*codex mcp add commonly/);
  assert.match(onboardingHtml, /pending, claimed, blocked, and done/);
  assert.match(onboardingHtml, /cm_agent_…/);
  assert.doesNotMatch(onboardingHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const discordGuide = guidePages.find((page) => page.path === '/guides/ai-agent-discord-integration/');
  assert.equal(discordGuide.title, 'AI Agent Discord Integration: Reviewable Work Signals | Commonly');
  const discordHtml = renderStaticPage(guideTemplate, discordGuide);
  assert.match(discordHtml, /An AI agent Discord integration connects a Discord conversation/);
  assert.match(discordHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(discordHtml, /\/discord-push/);
  assert.match(discordHtml, /every hour/);
  assert.match(discordHtml, /@commonly-bot/);
  assert.match(discordHtml, /pending, claimed, blocked, and done/);
  assert.match(discordHtml, /<pre class="seo-code">[\s\S]*DISCORD_BOT_TOKEN=\.\.\./);
  assert.doesNotMatch(discordHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(discordHtml, /DISCORD_(?:BOT_TOKEN|CLIENT_ID|CLIENT_SECRET)=(?!\.\.\.)[^\s<]+/);
  const runtimeGuide = guidePages.find((page) => page.path === '/guides/what-is-an-ai-agent-runtime/');
  assert.equal(runtimeGuide.title, 'What Is an AI Agent Runtime? | Commonly');
  const runtimeHtml = renderStaticPage(guideTemplate, runtimeGuide);
  assert.match(runtimeHtml, /An AI agent runtime is the process that receives a trigger/);
  assert.match(runtimeHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(runtimeHtml, /commonly agent run/);
  assert.match(runtimeHtml, /<pre class="seo-code">[\s\S]*GET \/api\/agents\/runtime\/events/);
  assert.match(runtimeHtml, /cannot discover or join pods/);
  assert.match(runtimeHtml, /cm_agent_…/);
  assert.doesNotMatch(runtimeHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const heartbeatsGuide = guidePages.find((page) => page.path === '/guides/ai-agent-heartbeats-and-scheduled-work/');
  assert.equal(heartbeatsGuide.title, 'AI Agent Heartbeats and Scheduled Work | Commonly');
  const heartbeatsHtml = renderStaticPage(guideTemplate, heartbeatsGuide);
  assert.match(heartbeatsHtml, /An AI agent heartbeat is a scheduled trigger/);
  assert.match(heartbeatsHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(heartbeatsHtml, /everyMinutes/);
  assert.match(heartbeatsHtml, /HEARTBEAT_OK/);
  assert.match(heartbeatsHtml, /pending, claimed, blocked, and done/);
  assert.match(heartbeatsHtml, /crash-loops the gateway/);
  assert.doesNotMatch(heartbeatsHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const marketplaceRolesGuide = guidePages.find((page) => page.path === '/guides/ai-agent-marketplace-roles/');
  assert.equal(marketplaceRolesGuide.title, 'AI Agent Marketplace Roles: Build a Clear Team | Commonly');
  const marketplaceRolesHtml = renderStaticPage(guideTemplate, marketplaceRolesGuide);
  assert.match(marketplaceRolesHtml, /AI agent marketplace roles are reusable starting points/);
  assert.match(marketplaceRolesHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(marketplaceRolesHtml, /Theo/);
  assert.match(marketplaceRolesHtml, /X-Curator/);
  assert.match(marketplaceRolesHtml, /coordinates tasks, reviews/);
  assert.match(marketplaceRolesHtml, /pending, claimed, blocked, and done/);
  assert.match(marketplaceRolesHtml, /AgentInstallation/);
  assert.doesNotMatch(marketplaceRolesHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const customHttpGuide = guidePages.find((page) => page.path === '/guides/connect-a-custom-agent-http-api/');
  assert.equal(customHttpGuide.title, 'Connect a Custom AI Agent with the HTTP API | Commonly');
  const customHttpHtml = renderStaticPage(guideTemplate, customHttpGuide);
  assert.match(customHttpHtml, /Connecting a custom AI agent over HTTP means/);
  assert.match(customHttpHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(customHttpHtml, /x-commonly-agent-token/);
  assert.match(customHttpHtml, /deliveryId/);
  assert.match(customHttpHtml, /sourceRef/);
  assert.match(customHttpHtml, /runtime\/pods/);
  assert.match(customHttpHtml, /pending, claimed, blocked, and done/);
  assert.doesNotMatch(customHttpHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const agentPodGuide = guidePages.find((page) => page.path === '/guides/what-is-an-agent-pod/');
  assert.equal(agentPodGuide.title, 'What Is an Agent Pod? Shared Workspace for AI Teams | Commonly');
  const agentPodHtml = renderStaticPage(guideTemplate, agentPodGuide);
  assert.match(agentPodHtml, /An agent pod is a shared workspace/);
  assert.match(agentPodHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(agentPodHtml, /agent-admin/);
  assert.match(agentPodHtml, /invite-only/);
  assert.match(agentPodHtml, /pending, claimed, blocked, and done/);
  assert.match(agentPodHtml, /AgentInstallation/);
  assert.match(agentPodHtml, /capped at 10 versions/);
  assert.doesNotMatch(agentPodHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const openClawGuide = guidePages.find((page) => page.path === '/guides/connect-openclaw-agent/');
  const openClawHtml = renderStaticPage(guideTemplate, openClawGuide);
  assert.match(openClawHtml, /Connecting an OpenClaw agent means/);
  assert.match(openClawHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(openClawHtml, /moltbot\.json/);
  assert.match(openClawHtml, /heartbeat\.global/);
  assert.match(openClawHtml, /HEARTBEAT\.md/);
  assert.match(openClawHtml, /AgentsHub/);
  assert.doesNotMatch(openClawHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const securityGuide = guidePages.find((page) => page.path === '/guides/ai-agent-security-best-practices/');
  const securityHtml = renderStaticPage(guideTemplate, securityGuide);
  assert.match(securityHtml, /AI agent security is the practice of/);
  assert.match(securityHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(securityHtml, /least privilege/);
  assert.match(securityHtml, /excessive agency/);
  assert.match(securityHtml, /installation-scoped/);
  assert.doesNotMatch(securityHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const cliGuide = guidePages.find((page) => page.path === '/guides/ai-agent-cli/');
  assert.equal(cliGuide.title, 'AI Agent CLI: Run a Local Agent as a Pod Member | Commonly');
  const cliHtml = renderStaticPage(guideTemplate, cliGuide);
  assert.match(cliHtml, /href="https:\/\/commonly\.me\/guides\/ai-agent-cli\/"/);
  assert.match(cliHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(cliHtml, /commonly agent run/);
  assert.doesNotMatch(cliHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/connect-a-custom-agent-http-api/',
    '/guides/ai-agent-heartbeats-and-scheduled-work/',
    '/guides/ai-agent-security-best-practices/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-cli\//);
  }
  const orchestrationGuide = guidePages.find((page) => page.path === '/guides/ai-agent-orchestration/');
  assert.equal(orchestrationGuide.title, 'AI Agent Orchestration: Coordinate Work Through Shared State | Commonly');
  const orchestrationHtml = renderStaticPage(guideTemplate, orchestrationGuide);
  assert.match(orchestrationHtml, /href="https:\/\/commonly\.me\/guides\/ai-agent-orchestration\/"/);
  assert.match(orchestrationHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.match(orchestrationHtml, /shared state/);
  assert.doesNotMatch(orchestrationHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  const skillsGuide = guidePages.find((page) => page.path === '/guides/ai-agent-skills/');
  assert.equal(skillsGuide.title, 'AI Agent Skills: Reusable Workflows for Reliable Agents | Commonly');
  const skillsHtml = renderStaticPage(guideTemplate, skillsGuide);
  assert.match(skillsHtml, /href="https:\/\/commonly\.me\/guides\/ai-agent-skills\/"/);
  assert.match(skillsHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(skillsHtml, /seo-page-dark/);
  assert.match(skillsHtml, /source-backed-review/);
  assert.doesNotMatch(skillsHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/ai-agent-task-management/',
    '/guides/ai-agent-memory/',
    '/guides/ai-agent-handoffs/',
    '/guides/ai-agent-heartbeats-and-scheduled-work/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-skills\//);
  }
  const autonomousGuide = guidePages.find((page) => page.path === '/guides/autonomous-ai-agents/');
  assert.equal(autonomousGuide.title, 'Autonomous AI Agents: A Practical Operating Model for Teams | Commonly');
  const autonomousHtml = renderStaticPage(guideTemplate, autonomousGuide);
  assert.match(autonomousHtml, /href="https:\/\/commonly\.me\/guides\/autonomous-ai-agents\/"/);
  assert.match(autonomousHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(autonomousHtml, /seo-page-dark/);
  assert.match(autonomousHtml, /role contract/);
  assert.doesNotMatch(autonomousHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/ai-agent-heartbeats-and-scheduled-work/',
    '/guides/ai-agent-task-management/',
    '/guides/ai-agent-security-best-practices/',
    '/guides/human-in-the-loop-ai-agents/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/autonomous-ai-agents\//);
  }
  const sandboxingGuide = guidePages.find((page) => page.path === '/guides/ai-agent-sandboxing/');
  assert.equal(sandboxingGuide.title, 'AI Agent Sandboxing: Reduce the Blast Radius of Untrusted Input | Commonly');
  const sandboxingHtml = renderStaticPage(guideTemplate, sandboxingGuide);
  assert.match(sandboxingHtml, /href="https:\/\/commonly\.me\/guides\/ai-agent-sandboxing\/"/);
  assert.match(sandboxingHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(sandboxingHtml, /seo-page-dark/);
  assert.match(sandboxingHtml, /blast radius/);
  assert.doesNotMatch(sandboxingHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/ai-agent-permissions-and-tokens/',
    '/guides/ai-agent-security-best-practices/',
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/autonomous-ai-agents/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-sandboxing\//);
  }
  const toolsGuide = guidePages.find((page) => page.path === '/guides/ai-agent-tools/');
  assert.equal(toolsGuide.title, 'AI Agent Tools: What They Are and How to Choose Them | Commonly');
  const toolsHtml = renderStaticPage(guideTemplate, toolsGuide);
  assert.match(toolsHtml, /href="https:\/\/commonly\.me\/guides\/ai-agent-tools\/"/);
  assert.match(toolsHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(toolsHtml, /seo-page-dark/);
  assert.match(toolsHtml, /toolset/);
  assert.doesNotMatch(toolsHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/ai-agent-skills/',
    '/guides/ai-agent-task-management/',
    '/guides/ai-agent-memory/',
    '/guides/ai-agent-cli/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-tools\//);
  }
  const promptInjectionGuide = guidePages.find((page) => page.path === '/guides/prompt-injection-defense-for-ai-agents/');
  assert.equal(promptInjectionGuide.title, 'Prompt Injection Defense for AI Agents: Contain the Capability | Commonly');
  const promptInjectionHtml = renderStaticPage(guideTemplate, promptInjectionGuide);
  assert.match(promptInjectionHtml, /href="https:\/\/commonly\.me\/guides\/prompt-injection-defense-for-ai-agents\/"/);
  assert.match(promptInjectionHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(promptInjectionHtml, /seo-page-dark/);
  assert.match(promptInjectionHtml, /capability boundaries/);
  assert.doesNotMatch(promptInjectionHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/ai-agent-sandboxing/',
    '/guides/ai-agent-security-best-practices/',
    '/guides/ai-agent-permissions-and-tokens/',
    '/guides/human-in-the-loop-ai-agents/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/prompt-injection-defense-for-ai-agents\//);
  }
  const mcpGuide = guidePages.find((page) => page.path === '/guides/mcp-for-ai-agent-teams/');
  assert.equal(mcpGuide.title, 'MCP for AI Agent Teams: Connect Tools Without Losing Context | Commonly');
  const mcpHtml = renderStaticPage(guideTemplate, mcpGuide);
  assert.match(mcpHtml, /href="https:\/\/commonly\.me\/guides\/mcp-for-ai-agent-teams\/"/);
  assert.match(mcpHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(mcpHtml, /seo-page-dark/);
  assert.match(mcpHtml, /connection path/);
  assert.doesNotMatch(mcpHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/connect-a-custom-agent-http-api/',
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/ai-agent-permissions-and-tokens/',
    '/guides/ai-agent-tools/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/mcp-for-ai-agent-teams\//);
  }
  const agenticAiGuide = guidePages.find((page) => page.path === '/guides/what-is-agentic-ai/');
  assert.equal(agenticAiGuide.title, 'What Is Agentic AI? A Practical Definition for Teams | Commonly');
  const agenticAiHtml = renderStaticPage(guideTemplate, agenticAiGuide);
  assert.match(agenticAiHtml, /href="https:\/\/commonly\.me\/guides\/what-is-agentic-ai\/"/);
  assert.match(agenticAiHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(agenticAiHtml, /seo-page-dark/);
  assert.match(agenticAiHtml, /work loop/);
  assert.doesNotMatch(agenticAiHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/autonomous-ai-agents/',
    '/guides/ai-agent-tools/',
    '/guides/ai-agent-task-management/',
    '/guides/human-in-the-loop-ai-agents/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/what-is-agentic-ai\//);
  }
  const aiAgentGuide = guidePages.find((page) => page.path === '/guides/what-is-an-ai-agent/');
  assert.equal(aiAgentGuide.title, 'What Is an AI Agent? A Practical Definition for Teams | Commonly');
  const aiAgentHtml = renderStaticPage(guideTemplate, aiAgentGuide);
  assert.match(aiAgentHtml, /href="https:\/\/commonly\.me\/guides\/what-is-an-ai-agent\/"/);
  assert.match(aiAgentHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(aiAgentHtml, /seo-page-dark/);
  assert.match(aiAgentHtml, /participant/);
  assert.doesNotMatch(aiAgentHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/what-is-agentic-ai/',
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/what-is-an-agent-pod/',
    '/guides/ai-agent-task-management/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/what-is-an-ai-agent\/"/);
  }
  const contextEngineeringGuide = guidePages.find((page) => page.path === '/guides/context-engineering-for-ai-agents/');
  assert.equal(contextEngineeringGuide.title, 'Context Engineering for AI Agents: Give Each Decision the Right State | Commonly');
  const contextEngineeringHtml = renderStaticPage(guideTemplate, contextEngineeringGuide);
  assert.match(contextEngineeringHtml, /href="https:\/\/commonly\.me\/guides\/context-engineering-for-ai-agents\/"/);
  assert.match(contextEngineeringHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(contextEngineeringHtml, /seo-page-dark/);
  assert.match(contextEngineeringHtml, /context packet/);
  assert.doesNotMatch(contextEngineeringHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/ai-agent-memory/',
    '/guides/ai-agent-task-management/',
    '/guides/prompt-injection-defense-for-ai-agents/',
    '/guides/what-is-agentic-ai/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/context-engineering-for-ai-agents\//);
  }
  const evaluationGuide = guidePages.find((page) => page.path === '/guides/how-to-evaluate-ai-agents/');
  assert.equal(evaluationGuide.title, 'How to Evaluate AI Agents: Test the Work, Not Just the Answer | Commonly');
  const evaluationHtml = renderStaticPage(guideTemplate, evaluationGuide);
  assert.match(evaluationHtml, /href="https:\/\/commonly\.me\/guides\/how-to-evaluate-ai-agents\/"/);
  assert.match(evaluationHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(evaluationHtml, /seo-page-dark/);
  assert.match(evaluationHtml, /acceptance criteria/);
  assert.doesNotMatch(evaluationHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/ai-agent-task-management/',
    '/guides/context-engineering-for-ai-agents/',
    '/guides/human-in-the-loop-ai-agents/',
    '/guides/prompt-injection-defense-for-ai-agents/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/how-to-evaluate-ai-agents\//);
  }
  const chatbotGuide = guidePages.find((page) => page.path === '/guides/ai-agent-vs-chatbot/');
  assert.equal(chatbotGuide.title, 'AI Agent vs. Chatbot: What Is the Difference? | Commonly');
  const chatbotHtml = renderStaticPage(guideTemplate, chatbotGuide);
  assert.match(chatbotHtml, /href="https:\/\/commonly\.me\/guides\/ai-agent-vs-chatbot\/"/);
  assert.match(chatbotHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(chatbotHtml, /seo-page-dark/);
  assert.match(chatbotHtml, /bounded contribution/);
  assert.doesNotMatch(chatbotHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/what-is-an-ai-agent/',
    '/guides/what-is-agentic-ai/',
    '/guides/multi-agent-vs-single-agent/',
    '/guides/ai-agent-tools/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-vs-chatbot\//);
  }
  const useCasesGuide = guidePages.find((page) => page.path === '/guides/ai-agent-use-cases/');
  assert.equal(useCasesGuide.title, 'AI Agent Use Cases: Eight Roles Teams Can Start Safely | Commonly');
  const useCasesHtml = renderStaticPage(guideTemplate, useCasesGuide);
  assert.match(useCasesHtml, /href="https:\/\/commonly\.me\/guides\/ai-agent-use-cases\/"/);
  assert.match(useCasesHtml, /Commonly \(commonly\.me\), the shared workspace where humans and AI agents work together/);
  assert.doesNotMatch(useCasesHtml, /seo-page-dark/);
  assert.match(useCasesHtml, /reviewable result/);
  assert.doesNotMatch(useCasesHtml, /cm_agent_[A-Za-z0-9]{8,}/);
  for (const guidePath of [
    '/guides/what-is-an-ai-agent/',
    '/guides/ai-agent-orchestration/',
    '/guides/human-in-the-loop-ai-agents/',
    '/guides/how-to-evaluate-ai-agents/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-use-cases\//);
  }
  for (const guidePath of [
    '/guides/what-is-an-agent-pod/',
    '/guides/ai-agent-handoffs/',
    '/guides/ai-agent-collaboration-patterns/',
    '/guides/multi-agent-vs-single-agent/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-orchestration\//);
  }
  for (const guidePath of [
    '/guides/ai-agent-heartbeats-and-scheduled-work/',
    '/guides/connect-a-custom-agent-http-api/',
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/connect-claude-codex-shared-workspace/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/connect-openclaw-agent\//);
  }
  for (const guidePath of [
    '/guides/ai-agent-permissions-and-tokens/',
    '/guides/ai-agent-memory/',
    '/guides/ai-agent-handoffs/',
    '/guides/connect-openclaw-agent/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-security-best-practices\//);
  }
  for (const guidePath of [
    '/guides/multi-agent-collaboration-platform/',
    '/guides/ai-agent-workspace/',
    '/guides/ai-agent-task-management/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/connect-claude-codex-shared-workspace\//);
  }
  for (const guidePath of [
    '/guides/multi-agent-collaboration-platform/',
    '/guides/ai-agent-workspace/',
    '/guides/ai-agent-task-management/',
    '/guides/connect-claude-codex-shared-workspace/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-memory\//);
  }
  for (const guidePath of [
    '/guides/multi-agent-collaboration-platform/',
    '/guides/ai-agent-workspace/',
    '/guides/connect-claude-codex-shared-workspace/',
    '/guides/ai-agent-memory/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/self-hosted-ai-agent-platform\//);
  }
  for (const guidePath of [
    '/guides/connect-claude-codex-shared-workspace/',
    '/guides/ai-agent-task-management/',
    '/guides/how-to-build-an-ai-agent-team/',
    '/guides/self-hosted-ai-agent-platform/',
    '/guides/agent-to-agent-messaging/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-permissions-and-tokens\//);
  }
  for (const guidePath of [
    '/guides/ai-agent-workspace/',
    '/guides/connect-claude-codex-shared-workspace/',
    '/guides/ai-agent-permissions-and-tokens/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/connect-cursor-shared-workspace\//);
  }
  for (const guidePath of [
    '/guides/ai-agent-task-management/',
    '/guides/ai-agent-memory/',
    '/guides/how-to-build-an-ai-agent-team/',
    '/guides/agent-to-agent-messaging/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-observability\//);
  }
  for (const guidePath of [
    '/guides/agent-to-agent-messaging/',
    '/guides/ai-agent-observability/',
    '/guides/connect-claude-codex-shared-workspace/',
    '/guides/connect-cursor-shared-workspace/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-events\//);
  }
  for (const guidePath of [
    '/guides/multi-agent-collaboration-platform/',
    '/guides/how-to-build-an-ai-agent-team/',
    '/guides/ai-agent-handoffs/',
    '/guides/agent-to-agent-messaging/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/multi-agent-vs-single-agent\//);
  }
  for (const guidePath of [
    '/guides/multi-agent-vs-single-agent/',
    '/guides/how-to-build-an-ai-agent-team/',
    '/guides/ai-agent-handoffs/',
    '/guides/human-in-the-loop-ai-agents/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-collaboration-patterns\//);
  }
  for (const guidePath of [
    '/guides/connect-claude-codex-shared-workspace/',
    '/guides/ai-agent-permissions-and-tokens/',
    '/guides/how-to-build-an-ai-agent-team/',
    '/guides/ai-agent-collaboration-patterns/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/onboarding-an-ai-agent-to-your-team\//);
  }
  for (const guidePath of [
    '/guides/ai-agent-events/',
    '/guides/onboarding-an-ai-agent-to-your-team/',
    '/guides/ai-agent-task-management/',
    '/guides/ai-agent-collaboration-patterns/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-discord-integration\//);
  }
  for (const guidePath of [
    '/guides/ai-agent-events/',
    '/guides/connect-claude-codex-shared-workspace/',
    '/guides/ai-agent-permissions-and-tokens/',
    '/guides/multi-agent-vs-single-agent/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/what-is-an-ai-agent-runtime\//);
  }
  for (const guidePath of [
    '/guides/ai-agent-events/',
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/ai-agent-memory/',
    '/guides/ai-agent-task-management/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-heartbeats-and-scheduled-work\//);
  }
  for (const guidePath of [
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/onboarding-an-ai-agent-to-your-team/',
    '/guides/how-to-build-an-ai-agent-team/',
    '/guides/ai-agent-collaboration-patterns/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/ai-agent-marketplace-roles\//);
  }
  for (const guidePath of [
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/connect-claude-codex-shared-workspace/',
    '/guides/ai-agent-events/',
    '/guides/ai-agent-permissions-and-tokens/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/connect-a-custom-agent-http-api\//);
  }
  for (const guidePath of [
    '/guides/ai-agent-workspace/',
    '/guides/what-is-an-ai-agent-runtime/',
    '/guides/ai-agent-memory/',
    '/guides/ai-agent-collaboration-patterns/',
  ]) {
    const html = renderStaticPage(guideTemplate, pages.find((page) => page.path === guidePath));
    assert.match(html, /href="\/guides\/what-is-an-agent-pod\//);
  }
  const guidesIndex = pages.find((page) => page.path === '/guides/');
  assert.equal(guidesIndex.title, 'Guides for teams working with AI agents | Commonly');
  assert.equal(guidesIndex.schema['@graph'].find((item) => item['@type'] === 'WebPage').name, 'Guides for teams working with AI agents');
  assert.match(indexHtml, /#seo-page \{[^}]*color: #111827; background: #f8f8fb;/);
  assert.match(indexHtml, /#seo-page \.seo-code \{[^}]*color: #111827; background: #f4f3f8;/);
});

test('puts route content, canonical metadata, and structured data in the document', () => {
  const page = {
    path: '/example/',
    title: 'Example page | Commonly',
    description: 'An example description.',
    content: '<main><h1>Example page</h1><a href="/">Home</a></main>',
    schema: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Example page' },
  };
  const template = '<head><!-- SEO_METADATA_START --><!-- SEO_METADATA_END --><!-- SEO_GATE_START --><script>document.documentElement.className += \' js\';</script><!-- SEO_GATE_END --><!-- SEO_NAVIGATION_RUNTIME_START --><script>window.addEventListener(\'popstate\', () => {});</script><!-- SEO_NAVIGATION_RUNTIME_END --><script type="module" src="/assets/index-abcd.js"></script></head><body><div id="root"><!-- SEO_PAGE_CONTENT --></div></body>';
  const rendered = renderStaticPage(template, page);

  assert.match(rendered, /<h1>Example page<\/h1>/);
  assert.match(rendered, /<link rel="canonical" href="https:\/\/commonly\.me\/example\/"/);
  assert.match(rendered, /application\/ld\+json/);
  assert.match(rendered, /document\.documentElement/);
  assert.match(rendered, /type="module"/);
});
