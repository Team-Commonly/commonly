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

  assert.equal(pages.length, 18);
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
  assert.equal(guidePages.length, 8);
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
  const humanReviewGuide = guidePages.find((page) => page.path === '/guides/human-in-the-loop-ai-agents/');
  assert.equal(humanReviewGuide.title, 'Human-in-the-Loop Review for AI Agent Teams | Commonly');
  const humanReviewHtml = renderStaticPage(guideTemplate, humanReviewGuide);
  assert.match(humanReviewHtml, /Human-in-the-loop review is a deliberate pause at a meaningful handoff/);
  assert.match(humanReviewHtml, /It is not a person reading every token an agent produces\./);
  assert.match(humanReviewHtml, /href="\/guides\/ai-agent-memory\//);
  assert.match(humanReviewHtml, /https:\/\/learn\.microsoft\.com\/en-us\/agent-framework\/workflows\/human-in-the-loop/);
  assert.match(humanReviewHtml, /href="\/guides\/ai-agent-handoffs\//);
  const handoffsGuide = guidePages.find((page) => page.path === '/guides/ai-agent-handoffs/');
  assert.equal(handoffsGuide.title, 'AI Agent Handoffs: Transfer Work Without Losing Context | Commonly');
  const handoffsHtml = renderStaticPage(guideTemplate, handoffsGuide);
  assert.match(handoffsHtml, /An AI agent handoff is the transfer of a piece of work to a new owner/);
  assert.match(handoffsHtml, /href="\/guides\/ai-agent-memory\//);
  assert.match(handoffsHtml, /href="\/guides\/human-in-the-loop-ai-agents\//);
  assert.match(handoffsHtml, /https:\/\/openai\.com\/business\/guides-and-resources\/a-practical-guide-to-building-ai-agents\//);
  assert.match(handoffsHtml, /https:\/\/learn\.microsoft\.com\/en-us\/agent-framework\/workflows\/orchestrations\/handoff/);
  assert.match(handoffsHtml, /href="\/guides\/how-to-build-an-ai-agent-team\//);
  const teamGuide = guidePages.find((page) => page.path === '/guides/how-to-build-an-ai-agent-team/');
  assert.equal(teamGuide.title, 'How to Build an AI Agent Team: Roles, Handoffs, and Review | Commonly');
  const teamHtml = renderStaticPage(guideTemplate, teamGuide);
  assert.match(teamHtml, /An AI agent team is a small group of people and agents with distinct responsibilities/);
  assert.match(teamHtml, /href="\/guides\/ai-agent-memory\//);
  assert.match(teamHtml, /href="\/guides\/human-in-the-loop-ai-agents\//);
  assert.match(teamHtml, /href="\/guides\/ai-agent-handoffs\//);
  assert.match(teamHtml, /https:\/\/openai\.com\/business\/guides-and-resources\/a-practical-guide-to-building-ai-agents\//);
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
