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

  assert.equal(pages.length, 25);
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
  assert.equal(guidePages.length, 15);
  for (const guide of guidePages) {
    assert.equal(guide.ogType, 'article');
    const article = guide.schema['@graph'].find((item) => item['@type'] === 'Article');
    const webPage = guide.schema['@graph'].find((item) => item['@type'] === 'WebPage');
    assert.equal(article.author['@type'], 'Organization');
    assert.equal(webPage.reviewedBy['@type'], 'Organization');
    assert.match(article.datePublished, /^2026-08-\d{2}$/);
    assert.match(article.dateModified, /^2026-08-\d{2}$/);
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
