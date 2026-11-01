import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, '..');
const buildDir = resolve(frontendDir, 'build');
const siteUrl = 'https://commonly.me';
const metadataStart = '<!-- SEO_METADATA_START -->';
const metadataEnd = '<!-- SEO_METADATA_END -->';
const pageContentMarker = '<!-- SEO_PAGE_CONTENT -->';
const gateRuntimeStart = '<!-- SEO_GATE_START -->';
const gateRuntimeEnd = '<!-- SEO_GATE_END -->';
const navigationRuntimeStart = '<!-- SEO_NAVIGATION_RUNTIME_START -->';
const navigationRuntimeEnd = '<!-- SEO_NAVIGATION_RUNTIME_END -->';
const viteEntryAssetPrefix = 'src="/assets/index-';

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const list = (items) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;

const renderGuideTable = (table) => `
  <div class="seo-table-wrap"><table class="seo-table">
    <thead><tr>${table.headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('')}</tr></thead>
    <tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;

const replaceMarkedSection = (template, start, end, content) => {
  const startIndex = template.indexOf(start);
  const endIndex = template.indexOf(end);

  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(`Missing or malformed ${start} marker in the Vite output.`);
  }

  return `${template.slice(0, startIndex)}${start}\n${content}\n${end}${template.slice(endIndex + end.length)}`;
};

const removeMarkedSection = (template, start, end) => {
  const startIndex = template.indexOf(start);
  const endIndex = template.indexOf(end);

  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(`Missing or malformed ${start} marker in the Vite output.`);
  }

  return `${template.slice(0, startIndex)}${template.slice(endIndex + end.length)}`;
};

const removeRuntimeEntryScript = (template) => {
  const entryIndex = template.indexOf(viteEntryAssetPrefix);
  const tagStart = template.lastIndexOf('<', entryIndex);
  const tagEnd = template.indexOf('>', entryIndex);

  if (
    entryIndex < 0
    || tagStart < 0
    || tagEnd < entryIndex
    || !template.startsWith('<script', tagStart)
  ) {
    throw new Error('Missing or malformed SEO runtime entry script in the Vite output.');
  }

  return `${template.slice(0, tagStart)}${template.slice(tagEnd + 1)}`;
};

const removeModulePreloads = (template) => {
  let document = template;
  let preloadIndex = document.indexOf('rel="modulepreload"');

  while (preloadIndex >= 0) {
    const tagStart = document.lastIndexOf('<', preloadIndex);
    const tagEnd = document.indexOf('>', preloadIndex);

    if (
      tagStart < 0
      || tagEnd < preloadIndex
      || !document.startsWith('<link', tagStart)
    ) {
      throw new Error('Missing or malformed module preload in the Vite output.');
    }

    document = `${document.slice(0, tagStart)}${document.slice(tagEnd + 1)}`;
    preloadIndex = document.indexOf('rel="modulepreload"');
  }

  return document;
};

const staticDocument = (template) => {
  const withoutGateRuntime = removeMarkedSection(template, gateRuntimeStart, gateRuntimeEnd);
  const withoutNavigationRuntime = removeMarkedSection(
    withoutGateRuntime,
    navigationRuntimeStart,
    navigationRuntimeEnd,
  );

  const withoutRuntime = removeModulePreloads(removeRuntimeEntryScript(withoutNavigationRuntime));
  const headEnd = withoutRuntime.indexOf('</head>');
  if (headEnd < 0) {
    throw new Error('Missing closing head tag in the static SEO page template.');
  }

  // Static-only pages deliberately omit the React bundle. The regular template
  // hides #seo-page until React takes over, so reveal that real page content
  // again for browsers as well as text-only crawlers.
  return `${withoutRuntime.slice(0, headEnd)}<style>#seo-page { display: block !important; }</style>${withoutRuntime.slice(headEnd)}`;
};

const pageUrl = (path) => `${siteUrl}${path}`;

const formatDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Guide provenance date must use YYYY-MM-DD: ${value}`);
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Guide provenance date is invalid: ${value}`);
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(date);
};

const guideProvenance = (guide) => {
  const provenance = guide.provenance;
  const required = ['author', 'reviewer', 'datePublished', 'dateModified'];

  if (!provenance || required.some((field) => !provenance[field])) {
    throw new Error(`Guide ${guide.title} is missing required provenance.`);
  }

  if (provenance.dateModified < provenance.datePublished) {
    throw new Error(`Guide ${guide.title} has a modified date before its published date.`);
  }

  return provenance;
};

const renderGuideProvenance = (guide) => {
  const provenance = guideProvenance(guide);
  const published = formatDate(provenance.datePublished);
  const modified = formatDate(provenance.dateModified);
  const dates = provenance.datePublished === provenance.dateModified
    ? `Published and updated <time datetime="${escapeHtml(provenance.datePublished)}">${escapeHtml(published)}</time>`
    : `Published <time datetime="${escapeHtml(provenance.datePublished)}">${escapeHtml(published)}</time> · Updated <time datetime="${escapeHtml(provenance.dateModified)}">${escapeHtml(modified)}</time>`;

  return `<p class="seo-byline">By ${escapeHtml(provenance.author)} · Reviewed by ${escapeHtml(provenance.reviewer)}<br>${dates}</p>`;
};

const renderLanding = (landing, guides, faq = [], siteLinks = '') => {
  const featureCards = [
    landing.features.needs,
    landing.features.team,
    landing.features.connectors,
    landing.features.byo,
  ].map((feature) => `
    <article class="seo-card">
      <p class="seo-kicker">${escapeHtml(feature.kicker)}</p>
      <h3>${escapeHtml(feature.title)}</h3>
      <p>${escapeHtml(feature.text)}</p>
      ${list(Object.values(feature.points))}
    </article>`).join('');

  const howItWorks = [
    landing.how.steps.install,
    landing.how.steps.teammate,
    landing.how.steps.swap,
  ].map((step, index) => `
    <article class="seo-card">
      <p class="seo-kicker">Step ${index + 1}</p>
      <h3>${escapeHtml(step.title)}</h3>
      <p>${escapeHtml(step.text)}</p>
    </article>`).join('');

  const teamCards = Object.values(landing.agentTeams.cards).map((card) => `
    <article class="seo-card">
      <h3>${escapeHtml(card.title)}</h3>
      <ul>${Object.values(card.roster).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
      <ul>${Object.values(card.chat).map((line) => `<li>${escapeHtml([line.author, line.text].filter(Boolean).join(': '))}</li>`).join('')}</ul>
      <p>${escapeHtml(card.footer)}</p>
    </article>`).join('');

  const guideCards = Object.entries(guides).map(([id, guide]) => `
    <article class="seo-card">
      <p class="seo-kicker">${escapeHtml(guide.eyebrow)}</p>
      <h3><a href="/guides/${encodeURIComponent(id)}/">${escapeHtml(guide.title)}</a></h3>
      <p>${escapeHtml(guide.summary)}</p>
    </article>`).join('');

  // The same questions and answers the en landing shows and its FAQPage JSON-LD carries.
  const faqSection = faq.length ? `
        <section id="faq">
          <h2>${escapeHtml(landing.faq.title)}</h2>
          <dl>${faq.map((item) => `<dt>${escapeHtml(item.question)}</dt><dd>${escapeHtml(item.answer)}</dd>`).join('')}</dl>
        </section>` : '';

  return `
    <div id="seo-page">
      <header class="seo-header">
        <a class="seo-brand" href="/" aria-label="Commonly home">Commonly</a>
        <nav aria-label="Primary navigation">
          <a href="#features">Features</a>
          <a href="#agent-teams">${landing.nav.agentTeams}</a>
          <a href="#guides">Guides</a>
          <a href="https://github.com/Team-Commonly/commonly">GitHub</a>
        </nav>
      </header>
      <main>
        <section class="seo-hero">
          <p class="seo-kicker">${escapeHtml(landing.hero.eyebrow)}</p>
          <h1>${escapeHtml(landing.hero.ariaLabel)}</h1>
          <p class="seo-lede">${escapeHtml(landing.hero.lede)}</p>
          <p class="seo-actions"><a class="seo-primary" href="/v2/register">${escapeHtml(landing.actions.getStarted)}</a></p>
          <p class="seo-install"><code>$ git clone github.com/Team-Commonly/commonly &amp;&amp; docker compose up</code></p>
        </section>
        <section class="seo-band">
          <h2>${escapeHtml(landing.wedge.title)}</h2>
          <p>${escapeHtml(landing.wedge.copy)}</p>
        </section>
        <section id="features">
          <p class="seo-kicker">${escapeHtml(landing.features.kicker)}</p>
          <h2>${escapeHtml(landing.features.title)}</h2>
          <div class="seo-grid">${featureCards}</div>
        </section>
        <section>
          <p class="seo-kicker">${escapeHtml(landing.how.kicker)}</p>
          <h2>${escapeHtml(landing.how.title)}</h2>
          <div class="seo-grid">${howItWorks}</div>
        </section>
        <section id="agent-teams">
          <p class="seo-kicker">${escapeHtml(landing.agentTeams.kicker)}</p>
          <h2>${escapeHtml(landing.agentTeams.title)}</h2>
          <div class="seo-grid">${teamCards}</div>
        </section>
        <section id="guides">
          <p class="seo-kicker">Guides</p>
          <h2>Learn how teams work with agents</h2>
          <div class="seo-grid">${guideCards}</div>
          <p><a href="/guides/">Browse all guides</a></p>
        </section>
        <section>
          <p class="seo-kicker">${escapeHtml(landing.openSource.kicker)}</p>
          <h2>${escapeHtml(landing.openSource.title)}</h2>
          <p>${escapeHtml(landing.openSource.lede)}</p>
          <p><a href="https://github.com/Team-Commonly/commonly">${escapeHtml(landing.actions.readSource)}</a></p>
        </section>${faqSection}
      </main>
      <footer class="seo-footer">Commonly is open source under Apache-2.0.${siteLinks}</footer>
    </div>`;
};

// Links every static page carries, so the comparison and use-case pages are reachable from a page
// crawlers already index, not only from the sitemap (D139: most of the sitemap sits "Discovered – not indexed").
export const renderSiteLinks = ({ useCases = {}, compareSources = {} }) => {
  const compareLinks = Object.values(compareSources).map((source) => `<a href="${escapeHtml(source.path)}">${escapeHtml(source.title.split(':')[0])}</a>`);
  const useCaseLinks = Object.entries(useCases).map(([id, useCase]) => `<a href="/use-cases/${encodeURIComponent(id)}/">${escapeHtml(useCase.title)}</a>`);
  return `<nav class="seo-site-links" aria-label="More from Commonly">
        <p><a href="/guides/">Guides</a></p>
        ${compareLinks.length ? `<p>Compare: ${compareLinks.join(' · ')}</p>` : ''}
        ${useCaseLinks.length ? `<p>Use cases: ${useCaseLinks.join(' · ')}</p>` : ''}
      </nav>`;
};

const renderCompare = (compare) => {
  const alternativeCards = Object.values(compare.alts).map((alternative) => `
    <article class="seo-card">
      <h3>${escapeHtml(alternative.name)}</h3>
      <p>${escapeHtml(alternative.what)}</p>
      <p>${escapeHtml(alternative.accept)}</p>
    </article>`).join('');
  const commonlyCards = Object.values(compare.us).map((item) => `
    <article class="seo-card">
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.body)}</p>
    </article>`).join('');

  return `
    <div id="seo-page">
      <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a><a href="https://github.com/Team-Commonly/commonly">GitHub</a></nav></header>
      <main>
        <section class="seo-hero">
          <p class="seo-kicker">${escapeHtml(compare.kicker)}</p>
          <h1>${escapeHtml(compare.title)}</h1>
          <p class="seo-lede">${escapeHtml(compare.lede)}</p>
          <p class="seo-actions"><a class="seo-primary" href="/v2/register">${escapeHtml(compare.actions.getStarted)}</a></p>
        </section>
        <section>
          <h2>${escapeHtml(compare.sameTitle)}</h2>
          <p>${escapeHtml(compare.same)}</p>
        </section>
        <section>
          <h2>${escapeHtml(compare.altsTitle)}</h2>
          <div class="seo-grid">${alternativeCards}</div>
        </section>
        <section>
          <h2>${escapeHtml(compare.usTitle)}</h2>
          <div class="seo-grid">${commonlyCards}</div>
        </section>
        <section class="seo-band"><h2>${escapeHtml(compare.closeTitle)}</h2><p>${escapeHtml(compare.close)}</p><p>${escapeHtml(compare.closeUs)}</p></section>
        <p class="seo-note">${escapeHtml(compare.note)}</p>
      </main>
      <footer class="seo-footer"><a href="/">Commonly</a> · <a href="https://github.com/Team-Commonly/commonly">GitHub</a></footer>
    </div>`;
};

const renderUseCase = (useCase, siteLinks = '') => `
  <div id="seo-page">
    <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a></nav></header>
    <main>
      <section class="seo-hero">
        <p class="seo-kicker">${escapeHtml(useCase.eyebrow)}</p>
        <h1>${escapeHtml(useCase.title)}</h1>
        <p class="seo-lede">${escapeHtml(useCase.summary)}</p>
        <p class="seo-actions"><a class="seo-primary" href="/v2/register">Start with this use case</a><a href="/v2/agents">Explore Agent Hub</a></p>
      </section>
      <section>
        <div class="seo-grid">
          <article class="seo-card"><h2>Common challenges</h2>${list(useCase.problems)}</article>
          <article class="seo-card"><h2>What you can do</h2>${list(useCase.outcomes)}</article>
        </div>
      </section>
      <section><h2>Example flow</h2><ol>${useCase.exampleFlow.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol></section>
      ${useCase.relatedGuides?.length ? `<section><h2>Related guides</h2><ul>${useCase.relatedGuides.map((guide) => `<li><a href="${escapeHtml(guide.path)}">${escapeHtml(guide.title)}</a></li>`).join('')}</ul></section>` : ''}
    </main>
    <footer class="seo-footer"><a href="/">Back to Commonly</a>${siteLinks}</footer>
  </div>`;

const renderGuide = (guide, siteLinks = '') => {
  const sections = guide.sections.map((section) => `
    <section>
      <h2>${escapeHtml(section.title)}</h2>
      ${(section.paragraphs || []).map((paragraph) => {
        if (typeof paragraph === 'object' && paragraph.strong) {
          return `<p><strong>${escapeHtml(paragraph.strong)}</strong></p>`;
        }

        return `<p>${escapeHtml(paragraph)}</p>`;
      }).join('')}
      ${section.bullets?.length ? list(section.bullets) : ''}
      ${section.orderedItems?.length ? `<ol>${section.orderedItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>` : ''}
      ${section.tables?.map(renderGuideTable).join('') || ''}
      ${section.codeBlocks?.map((block) => `<pre class="seo-code"><code${block.language ? ` class="language-${escapeHtml(block.language)}"` : ''}>${escapeHtml(block.code)}</code></pre>`).join('') || ''}
      ${section.links?.length ? `<p class="seo-source-links">${section.links.map((link) => `<a href="${escapeHtml(link.path)}"${link.external ? ' rel="noreferrer"' : ''}>${escapeHtml(link.label)}</a>`).join(' · ')}</p>` : ''}
    </section>`).join('');
  const faq = guide.faq.map((item) => `
    <article class="seo-card"><h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p></article>`).join('');
  const relatedLinks = guide.relatedLinks.map((link) => `<a href="${escapeHtml(link.path)}">${escapeHtml(link.label)}</a>`).join(' · ');

  return `
  <div id="seo-page">
    <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a><a href="/guides/">Guides</a><a href="/use-cases/agent-collab/">Agent collaboration</a></nav></header>
    <main>
      <section class="seo-hero">
        <p class="seo-kicker">${escapeHtml(guide.eyebrow)}</p>
        <h1>${escapeHtml(guide.title)}</h1>
        <p class="seo-lede">${escapeHtml(guide.description)}</p>
        ${renderGuideProvenance(guide)}
        ${(guide.intro || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}
      </section>
      ${sections}
      ${guide.faq.length ? `<section><h2>Frequently asked questions</h2><div class="seo-grid">${faq}</div></section>` : ''}
      <section class="seo-band"><h2>${escapeHtml(guide.cta.title)}</h2><p>${escapeHtml(guide.cta.body)}</p><p class="seo-actions"><a class="seo-primary" href="${escapeHtml(guide.cta.primary.path)}">${escapeHtml(guide.cta.primary.label)}</a><a href="${escapeHtml(guide.cta.secondary.path)}">${escapeHtml(guide.cta.secondary.label)}</a></p></section>
      <p class="seo-note">${relatedLinks}</p>
    </main>
    <footer class="seo-footer"><a href="/">Back to Commonly</a>${siteLinks}</footer>
  </div>`;
};

const renderGuidesIndex = (guides, siteLinks = '') => {
  const guideCards = Object.entries(guides).map(([id, guide]) => `
    <article class="seo-card">
      <p class="seo-kicker">${escapeHtml(guide.eyebrow)}</p>
      <h2><a href="/guides/${encodeURIComponent(id)}/">${escapeHtml(guide.title)}</a></h2>
      <p>${escapeHtml(guide.summary)}</p>
      <p><a href="/guides/${encodeURIComponent(id)}/">Read the guide</a></p>
    </article>`).join('');

  return `
    <div id="seo-page">
      <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a><a href="/use-cases/agent-collab/">Agent collaboration</a></nav></header>
      <main>
        <section class="seo-hero">
          <p class="seo-kicker">Guides</p>
          <h1>Guides for teams working with AI agents</h1>
          <p class="seo-lede">Practical explanations of the shared context, ownership, and handoffs that help people and AI agents work together on real projects.</p>
        </section>
        <section>
          <div class="seo-grid">${guideCards}</div>
        </section>
      </main>
      <footer class="seo-footer"><a href="/">Back to Commonly</a>${siteLinks}</footer>
    </div>`;
};

const jsonLd = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');

// Must equal FAQ_JSONLD_ID in src/v2/landing/landingFaq.ts: the landing effect reuses this tag.
const faqJsonLdId = 'landing-faq-jsonld';

const faqPageJsonLd = (faq) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faq.map((item) => ({
    '@type': 'Question',
    name: item.question,
    acceptedAnswer: { '@type': 'Answer', text: item.answer },
  })),
});

const metadata = ({ title, description, path, schema, faqSchema, ogType = 'website', datePublished, dateModified, noindex = false }) => {
  const url = pageUrl(path);
  const structuredData = jsonLd(schema);
  const articleDates = ogType === 'article' && datePublished && dateModified
    ? `\n    <meta property="article:published_time" content="${escapeHtml(datePublished)}" />\n    <meta property="article:modified_time" content="${escapeHtml(dateModified)}" />`
    : '';
  return `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="${noindex ? 'noindex' : 'index,follow'}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="${escapeHtml(ogType)}" />
    <meta property="og:site_name" content="Commonly" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${siteUrl}/og-card.png?v=4" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    ${articleDates}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@sam_commonly" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${siteUrl}/og-card.png?v=4" />
    <script type="application/ld+json">${structuredData}</script>${faqSchema ? `
    <script type="application/ld+json" id="${faqJsonLdId}">${jsonLd(faqSchema)}</script>` : ''}`;
};

// Compare pages (GEO, D104). The markdown below is GTM's copy, pasted verbatim
// from the drafts; the renderer only turns it into HTML. A page with an open
// [HOLD: ...] marker refuses to build, so a held claim cannot ship as text.
const comparePageSources = {
  openagents: {
    path: '/compare/openagents/',
    title: "Commonly vs OpenAgents (openagents.org): what each ships, side by side",
    description: "OpenAgents and Commonly are both Apache-2.0 workspaces where people and coding agents work together. Commonly is one pod for a team where each person brings their own agent. A factual comparison of agents, self-hosting, how people take part and outside tools.",
    markdown: `# Commonly vs OpenAgents

*Updated 2026-10-31. Facts about other products were checked on their own sites on 2026-10-25 and re-checked on 2026-10-31.*

**Short answer.** OpenAgents (openagents.org) and Commonly are both open-source, Apache-2.0 workspaces where people and coding agents work together. Commonly is built around a team where each person brings their own agent. Teammates join one pod by invite link, each agent is a named member with an owner, and people and agents share the same conversations and one task board, so everyone can see who has what. OpenAgents lists more agent CLIs, adds shared threads, files and a live browser, and ships desktop and mobile apps.

*This page compares OpenAgents at openagents.org (GitHub: openagents-org/openagents). It is not about openagents.com, which is a separate product.*

## What each ships today

| | OpenAgents (openagents.org) | Commonly |
|---|---|---|
| **What it is, in its own words** | "The collaboration OS for AI agents": shared conversations, files and a live browser where people and agents work together. [1] | One pod for your team and the agents each of you runs. [9] |
| **License** | Apache 2.0. [1][5] | Apache-2.0. [9] |
| **Self-host** | Yes. "Run the full platform on your own infrastructure", with Docker or Kubernetes. [1][5] | Open source (Apache-2.0). The repo includes a Docker Compose setup (\`./install.sh\`). [9] |
| **Agents named** | Homepage: Claude Code, Codex, Cursor, OpenClaw, Gemini CLI, GitHub Copilot, OpenCode, Kimi, CodeBuddy, Hermes, DeepSeek and Pi. Its Workspace FAQ says "Currently: OpenClaw, Claude Code, Codex CLI, Cursor, and OpenCode" and marks others coming soon. [1][5] | Your own Claude Code or Codex, connected from your Mac, plus a hosted agent you start from the pod with one click. |
| **How agents connect** | A desktop Launcher or a CLI for agents on your computer, a pairing code to connect a whole machine, or a hosted cloud agent added with an API key. Agents connect "over open protocols (including MCP)". [2][6] | A command from the pod's "Bring your own agent" page starts a listener for your own Claude Code or Codex on a Mac. By default it wakes on what people post in the pod, @mentions included. Claude Code can also join over MCP. |
| **Where agent code runs** | "Code execution happens on your machine — never on OpenAgents servers." [3] | Your own agent runs on your machine. The hosted agent runs on Commonly. |
| **How people take part** | Threads with @mentions, a shared browser you can take over, and Issues. People are invited to collaborate from the workspace, and access is granted to "members, agents, or groups". [2] | Teammates join a pod by invite link, and each brings their own agent. Each agent is a named member with an owner. People and agents share the pod's conversations, with @mentions. Your own connected agent claims tasks on the pod's board (the claim holds a lease), posts what it tried, and asks a person on a decision card when a call is theirs. |
| **Access to outside tools** | Workspaces have "roles, membership, and access control", and you choose which threads each participant can join. For local agents, model keys go "directly between your machine and the model provider". [3] | The owner of a Linear connection grants one agent read access. The agent sees the read tools and no write tools. Calls made through a grant are logged. |
| **Apps** | Web, desktop (macOS and Windows on the homepage; the README adds a Linux AppImage), iOS and Android. [1][8] | Web. |
| **Pricing, as stated** | Hosted: "Free to start". FAQ: "Workspaces are open source and available at no cost." Enterprise: a "Talk to us" button that links to Discord. openagents.org/pricing returned a 404 on 2026-10-25. [1][4][5] | Not listed on this page. |

## When to pick OpenAgents

- You want a long list of agent CLIs supported today, including Cursor, Gemini CLI and GitHub Copilot.
- You want shared threads, files and a live browser that agents and people use together.
- You want desktop and mobile apps, or a Launcher that installs and runs agents on each machine.
- You want the vendor's own statement that agent code never runs on its servers.

## When to pick Commonly

- Several people on your team each run their own agent, and you want those agents in one pod with the people who own them.
- You want everyone, people and agents, to see who has what: each agent is a named member with an owner.
- You want your own agents to claim work on a shared board so two of them don't take the same task.
- You want an agent to stop and ask a person on a decision card when a call is theirs.
- You want a hosted agent you can start from the pod, next to your own.
- You want to give one agent read access to your Linear, and have it see those read tools and nothing more.

## FAQ

**Is OpenAgents the same as openagents.com?**
No. This page covers openagents.org and the openagents-org/openagents repository. openagents.com opens with "Projects you can walk into. People and agents building them.", and its homepage doesn't mention openagents.org. [7]

**Are both open source?**
Yes. Both are Apache-2.0. [1][9]

**Can I run either one on my own servers?**
Both document self-hosting. OpenAgents with Docker or Kubernetes, Commonly with Docker Compose. [5][9]

**Which agents work with Commonly?**
Your own Claude Code or Codex, connected from your Mac, plus a hosted agent you start from the pod with one click.

## Sources

Competitor facts checked on each vendor's site on 2026-10-25 and re-checked on 2026-10-31:

1. OpenAgents homepage: https://openagents.org/ (headline, agent list, apps, "Free to start", Apache 2.0)
2. OpenAgents Workspace: https://openagents.org/workspace (threads, browser, Issues, access)
3. OpenAgents Security: https://openagents.org/security (execution on your machine, invitation links, keys)
4. OpenAgents Enterprise: https://openagents.org/enterprise ("Free to start", "Talk to us" to Discord)
5. OpenAgents FAQ: https://openagents.org/faq (no-cost workspaces, Docker/Kubernetes, the five "currently" supported agents)
6. OpenAgents docs overview: https://openagents.org/docs/en/getting-started/overview (Launcher, pairing code, cloud agent, MCP)
7. openagents.com homepage: https://openagents.com/ (different product; read to tell the two apart, not cited for any fact above)
8. OpenAgents GitHub: https://github.com/openagents-org/openagents (Apache-2.0; 4,272 stars and latest release launcher-v1.1.8, both as of 2026-10-28)
9. Commonly README: https://github.com/Team-Commonly/commonly (Apache-2.0, \`install.sh\`)

Commonly facts come from the Commonly README and from using the product on commonly.me, as of 2026-10-27.
`,
  },
  githubAgentHq: {
    path: '/compare/github-agent-hq/',
    title: "Commonly vs GitHub Agent HQ: where each one fits",
    description: "GitHub Agent HQ runs Copilot, Claude and Codex agents inside GitHub. Commonly is one pod where each teammate brings their own agent and the team shares the same conversations and one task board. A factual comparison with preview and GA status.",
    markdown: `# Commonly vs GitHub Agent HQ

*Updated 2026-10-31. Facts about other products were checked on their own sites on 2026-10-25 and re-checked on 2026-10-31.*

**Short answer.** If your team lives in GitHub and pays for Copilot, GitHub Agent HQ is the natural choice: you assign issues to Copilot, Claude or Codex agents and review their pull requests in GitHub, under your organization's policies and audit log. Commonly fits a different setup: a team where each person brings their own agent. Teammates join one pod by invite link, and people and agents share the same conversations and one task board, so everyone can see who has what. Claude and Codex on Agent HQ are in public preview as of 2026-10-25.

## What each ships today

| | GitHub Agent HQ (with Copilot) | Commonly |
|---|---|---|
| **What it is, in its own words** | One place to assign, steer and track agents across GitHub, VS Code, mobile and the CLI ("mission control"). Announced 2025-10-28. [1] | One pod for your team and the agents each of you runs. [11] |
| **Agents** | Copilot cloud agent. Third-party: Anthropic Claude (Claude Agent SDK) and OpenAI Codex (Codex SDK), **public preview**. [2][3] | Your own Claude Code or Codex, connected from your Mac, plus a hosted agent you start from the pod with one click. |
| **Where agents run** | Copilot cloud agent works "in a cloud development environment, rather than your local IDE": a cloud sandbox, a GitHub Actions runner or a remote custom environment. [4] For third-party agents, GitHub says "Coding agents consume GitHub Actions minutes and AI credits." [2] | Your own agent runs on your own machine; the hosted agent runs on Commonly. |
| **How work is assigned** | Assign an issue or a prompt from the Agents tab, an issue, a PR comment, GitHub Mobile or VS Code. The agent opens a PR and requests review. One branch and one PR per task. Sessions on GitHub Actions are limited to one repository; cloud sandbox sessions can span repositories. [2][4] | @mention an agent in the pod, or put a task on the pod's board. Your own connected agent claims tasks over MCP (the claim holds a lease), posts what it tried, and asks a person on a decision card when a call is theirs. |
| **Steering a running agent** | Available for Copilot. "Steering is not available for third-party coding agents." [5] | Reply to it in the pod. |
| **Who sees the work** | Teammates with repository access can follow shared sessions and PRs. [4] | Everyone in the pod, people and agents, sees the conversations, the board and decision cards. Teammates join by invite link, and each agent is a named member with an owner. |
| **Access controls** | Org and enterprise policies decide which agents are allowed; enabling Claude or Codex installs a GitHub App for it. By default, the agent's GitHub MCP server uses "a specially scoped token with read-only access to the current repository" [12]. Enterprise AI Controls and the agent control plane are **GA since 2026-02-26**; enterprise-wide MCP allowlists **remain in preview**. [2][4][6] | The owner of a Linear connection grants one agent read access, and the agent then sees those read tools and no write tools. Calls made through a grant are logged. |
| **Audit** | Actions by the agent GitHub Apps appear in the audit log. Entries carry \`actor_is_agent\` with the \`user\` the agent acts for; an \`agent_session.task\` event records start, finish and failure (GA 2026-02-26). [2][6] | Calls an agent makes through a granted connector are logged. |
| **Tools outside GitHub** | Delegate to Copilot from Slack and Microsoft Teams. [4] Linear's changelog (2026-07-30): "GitHub Copilot users can assign issues directly to Copilot's cloud agent from Linear." [10] | Read grants for Linear, one agent at a time. |
| **License / self-host** | Hosted GitHub service. | Apache-2.0, with a Docker Compose setup in the repo. [11] |
| **Pricing, as stated** | Pro $10/mo, Pro+ $39/mo, Max $100/mo; Business $19 and Enterprise $39 per granted seat per month. Third-party agents are marked "(Preview)". The plans page lists them for Pro+ and Max and "Not included" for Pro, while the docs plan page lists Pro, Pro+ and Max. [7][8] | Not listed on this page. |

**Preview vs GA, as of 2026-10-25:**
- Third-party Claude and Codex agents: public preview. [2][3]
- Enterprise AI Controls and agent control plane: GA (2026-02-26). Enterprise-wide MCP allowlists: preview. [6]
- VS Code Automations and agent merge: preview. HydraFusion: research preview. [9]
- Copilot cloud agent: the docs page carries no preview label. [4]

## When to pick GitHub Agent HQ

- Your code, issues and reviews already live on GitHub, and your team pays for Copilot.
- You want the issue → agent → pull request loop inside GitHub, with CodeQL and secret scanning on the agent's code. [2]
- You need enterprise policy and an audit log that marks agent actions and the human they act for. [6]
- Your work fits one branch and one PR per task. [4]

## When to pick Commonly

- Teammates each run their own agent, and you want those agents in one pod with the people who own them, where everyone sees who has what.
- You want work claimed on a shared board so two agents don't take the same task.
- You want an agent to ask a person on a decision card when the call is theirs.
- Your agents need to read Linear, and you want to grant that per agent, read-only.
- You use both: Commonly can sit next to GitHub, where your agents still open PRs.
- If you're weighing other options too, see [GitHub Agent HQ alternatives](/guides/github-agent-hq-alternative/).

## FAQ

**Is Claude on GitHub Agent HQ generally available?**
Not as of 2026-10-25. GitHub's docs say third-party coding agents "are currently in public preview." [2]

**Can I steer Claude or Codex mid-task on Agent HQ?**
GitHub's docs say steering is not available for third-party coding agents. [5]

**Does Commonly replace GitHub?**
No. Your own Claude Code in a Commonly pod runs on your machine with your own git setup, so it can still branch, push and open pull requests on GitHub as it does today.

## Sources

Competitor facts checked on each vendor's site on 2026-10-25 and re-checked on 2026-10-31:

1. GitHub blog, "Welcome home, agents" (2025-10-28): https://github.blog/news-insights/company-news/welcome-home-agents/
2. GitHub Docs, About third-party agents: https://docs.github.com/en/copilot/concepts/agents/about-third-party-agents
3. GitHub blog, "Pick your agent: Use Claude and Codex on Agent HQ" (2026-02-04): https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/
4. GitHub Docs, About Copilot cloud agent: https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
5. GitHub Docs, Manage agents: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/manage-agents
6. GitHub changelog, Enterprise AI Controls and agent control plane GA (2026-02-26): https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/
7. GitHub Copilot plans: https://github.com/features/copilot/plans
8. GitHub Docs, Copilot plans: https://docs.github.com/en/copilot/get-started/plans (Business $19, Enterprise $39 per granted seat per month)
9. GitHub changelog, Copilot in VS Code September 2026 releases (2026-10-01): https://github.blog/changelog/2026-10-01-github-copilot-in-vs-code-september-2026-releases
10. Linear changelog, "GitHub Copilot for Linear" (2026-07-30 entry; it links a GitHub post whose URL says "generally available", the entry text does not): https://linear.app/changelog
11. Commonly README: https://github.com/Team-Commonly/commonly
12. GitHub Docs, MCP and Copilot: https://docs.github.com/en/copilot/concepts/customizations/mcp

Commonly facts come from the Commonly README and from using the product on commonly.me, as of 2026-10-27.
`,
  },
};

// Any bracketed text is an open marker (a HOLD, a re-check note, or anything
// else GTM bracketed) except a numeric citation like [1] or a markdown link.
export const assertNoOpenHolds = (key, markdown) => {
  const markers = [...markdown.matchAll(/\[([^\]\n]*)\](?!\((?:https?:\/\/[^)\s]+|\/(?!\/)[^)\s]*)\))/g)]
    .filter(([, inner]) => !/^\d+$/.test(inner))
    .map(([marker]) => marker);
  if (markers.length) throw new Error(`${key} has ${markers.length} open bracketed marker(s), first ${markers[0]}; GTM must clear them before this page can build`);
};

const inlinePattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/(?!\/)[^)\s]*)\)|(https?:\/\/[^\s<)\]]*[^\s<)\].,;:])|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

const renderInline = (text) => {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const [whole, code, label, labelHref, bareHref, bold, italic] = match;
    html += escapeHtml(text.slice(last, match.index));
    if (code !== undefined) html += `<code>${escapeHtml(code)}</code>`;
    else if (label !== undefined) html += `<a href="${escapeHtml(labelHref)}" rel="noreferrer">${escapeHtml(label)}</a>`;
    else if (bareHref !== undefined) html += `<a href="${escapeHtml(bareHref)}" rel="noreferrer">${escapeHtml(bareHref)}</a>`;
    else if (bold !== undefined) html += `<strong>${renderInline(bold)}</strong>`;
    else html += `<em>${renderInline(italic)}</em>`;
    last = match.index + whole.length;
  }
  return html + escapeHtml(text.slice(last));
};

const splitTableRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

const renderMarkdownTable = (lines) => {
  const [headerLine, separator, ...bodyLines] = lines;
  if (!/^\|?[\s:|-]+\|?$/.test(separator)) throw new Error(`table has no separator row under: ${headerLine}`);
  const head = splitTableRow(headerLine);
  const rows = bodyLines.map(splitTableRow);
  for (const row of rows) {
    if (row.length !== head.length) throw new Error(`table row has ${row.length} cells, header has ${head.length}: ${row[0]}`);
  }
  return `<div class="seo-table-wrap"><table class="seo-table">
    <thead><tr>${head.map((cell) => `<th scope="col">${renderInline(cell)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${renderInline(cell)}</th>` : `<td>${renderInline(cell)}</td>`)).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
};

// Internal notes live in HTML comments. Drop each one, and refuse the build when a
// comment is left open or nested, since its tail would ship as visible text.
const stripHtmlComments = (markdown) => {
  let out = '';
  let i = 0;
  for (;;) {
    const open = markdown.indexOf('<!--', i);
    if (open === -1) break;
    out += markdown.slice(i, open);
    const ends = ['-->', '--!>'].map((end) => [markdown.indexOf(end, open + 4), end.length]).filter(([at]) => at !== -1);
    if (!ends.length) throw new Error('unclosed HTML comment in compare markdown');
    const [at, length] = ends.reduce((first, next) => (next[0] < first[0] ? next : first));
    i = at + length;
  }
  out += markdown.slice(i);
  if (out.includes('<!--') || out.includes('-->') || out.includes('--!>')) {
    throw new Error('unclosed HTML comment in compare markdown');
  }
  return out;
};

// The subset of markdown the compare drafts use: headings, paragraphs, bullet
// and numbered lists, pipe tables, and inline code, bold, italic and links.
export const renderMarkdown = (markdown) => {
  const text = stripHtmlComments(markdown);
  const lines = text.split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i += 1;
    } else if (line.startsWith('|')) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        block.push(lines[i].trim());
        i += 1;
      }
      html.push(renderMarkdownTable(block));
    } else if (/^#{1,3} /.test(line)) {
      const [, hashes, text] = line.match(/^(#{1,3}) (.*)$/);
      html.push(`<h${hashes.length}>${renderInline(text)}</h${hashes.length}>`);
      i += 1;
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const item = ordered ? /^\d+\. (.*)$/ : /^- (.*)$/;
      const items = [];
      while (i < lines.length && item.test(lines[i].trim())) {
        items.push(lines[i].trim().match(item)[1]);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((text) => `<li>${renderInline(text)}</li>`).join('')}</${tag}>`);
    } else {
      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,3} |\||- |\d+\. )/.test(lines[i].trim())) {
        paragraph.push(lines[i].trim());
        i += 1;
      }
      html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    }
  }
  return html.join('\n');
};

export const buildPageDefinitions = ({ landing, compare, useCases, guides = {}, landingFaq = [], compareSources = comparePageSources }) => {
  const siteLinks = renderSiteLinks({ useCases, compareSources });
  const organizationId = `${siteUrl}/#organization`;
  const websiteId = `${siteUrl}/#website`;
  const organization = {
    '@type': 'Organization',
    '@id': organizationId,
    name: 'Commonly AI',
    alternateName: ['Commonly', 'commonly.me'],
    url: `${siteUrl}/`,
    logo: `${siteUrl}/favicon.svg`,
    description: 'Commonly (commonly.me) is a shared workspace platform where humans and AI agents from any origin work together in pods with shared memory, tasks, and messaging.',
    sameAs: [
      'https://github.com/Team-Commonly/commonly',
      'https://www.npmjs.com/package/@commonlyai/mcp',
      'https://discord.gg/NsS3fzsJDw',
    ],
  };
  const website = {
    '@type': 'WebSite',
    '@id': websiteId,
    name: 'Commonly',
    alternateName: 'Commonly.me',
    url: `${siteUrl}/`,
    publisher: { '@id': organizationId },
  };
  const softwareApplication = {
    '@type': 'SoftwareApplication',
    name: 'Commonly AI',
    alternateName: ['Commonly', 'commonly.me'],
    url: `${siteUrl}/`,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: landing.hero.lede,
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    publisher: { '@id': organizationId },
  };
  const webPageNode = (title, description, path) => ({
    '@type': 'WebPage',
    '@id': pageUrl(path),
    name: title,
    description,
    url: pageUrl(path),
    isPartOf: { '@id': websiteId },
  });
  const webPage = (title, description, path) => ({
    '@context': 'https://schema.org',
    '@graph': [organization, website, webPageNode(title, description, path)],
  });

  const landingPage = {
    path: '/',
    outputPath: 'index.html',
    title: 'Commonly: bring your Claude Code, your teammate\'s Codex and your team into one pod',
    description: 'Everyone brings their own agent, and the team shares the conversations and the task board. Open source under Apache-2.0, and you can self-host.',
    content: renderLanding(landing, guides, landingFaq, siteLinks),
  };
  if (landingFaq.length) landingPage.faqSchema = faqPageJsonLd(landingFaq);
  landingPage.schema = {
    '@context': 'https://schema.org',
    '@graph': [organization, website, softwareApplication, webPageNode(landingPage.title, landingPage.description, landingPage.path)],
  };

  const comparePages = Object.values(compareSources).map((source) => {
    assertNoOpenHolds(source.path, source.markdown);
    return {
      path: source.path,
      outputPath: `${source.path.slice(1)}index.html`,
      // No app route serves /compare/*, so the page must stay static or React blanks it.
      staticOnly: true,
      title: source.title,
      description: source.description,
      content: `
    <div id="seo-page">
      <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a><a href="/guides/">Guides</a></nav></header>
      <main class="seo-article">
        ${renderMarkdown(source.markdown)}
      </main>
      <footer class="seo-footer"><a href="/">Back to Commonly</a>${siteLinks}</footer>
    </div>`,
      schema: webPage(source.title, source.description, source.path),
    };
  });

  const pages = [landingPage, {
    path: '/compare/',
    outputPath: 'compare/index.html',
    title: 'Commonly vs the alternatives | Commonly AI',
    description: compare.lede,
    content: renderCompare(compare),
    schema: webPage(compare.title, compare.lede, '/compare/'),
    // Unlisted: noindex, kept out of the sitemap, linked from nothing.
    noindex: true,
  }];

  const guidesIndexPath = '/guides/';
  const guidesIndexPage = {
    path: guidesIndexPath,
    outputPath: 'guides/index.html',
    title: 'Guides for teams working with AI agents | Commonly AI',
    description: 'Practical guides for teams that work with AI agents: shared context, task ownership, human review, and durable handoffs.',
    content: renderGuidesIndex(guides, siteLinks),
    staticOnly: true,
    schema: webPage('Guides for teams working with AI agents', 'Practical guides for teams that work with AI agents: shared context, task ownership, human review, and durable handoffs.', guidesIndexPath),
  };

  const useCasePages = Object.entries(useCases).map(([id, useCase]) => {
    const path = `/use-cases/${id}/`;
    return {
      path,
      outputPath: `use-cases/${id}/index.html`,
      title: `${useCase.title} | Commonly AI`,
      description: useCase.summary,
      content: renderUseCase(useCase, siteLinks),
      schema: webPage(useCase.title, useCase.summary, path),
    };
  });

  const guidePages = Object.entries(guides).map(([id, guide]) => {
    const path = `/guides/${id}/`;
    const provenance = guideProvenance(guide);
    const author = { '@type': 'Organization', '@id': organizationId, name: provenance.author, url: `${siteUrl}/` };
    const reviewer = { '@type': 'Organization', name: provenance.reviewer, url: `${siteUrl}/` };
    return {
      path,
      outputPath: `guides/${id}/index.html`,
      title: guide.titleTag,
      description: guide.description,
      content: renderGuide(guide, siteLinks),
      staticOnly: true,
      ogType: 'article',
      datePublished: provenance.datePublished,
      dateModified: provenance.dateModified,
      schema: {
        '@context': 'https://schema.org',
        '@graph': [{
          '@type': 'Article',
          '@id': `${pageUrl(path)}#article`,
          headline: guide.title,
          description: guide.description,
          mainEntityOfPage: { '@id': pageUrl(path) },
          author,
          datePublished: provenance.datePublished,
          dateModified: provenance.dateModified,
          publisher: { '@id': organizationId },
        }, {
          '@type': 'WebPage',
          '@id': pageUrl(path),
          name: guide.title,
          description: guide.description,
          url: pageUrl(path),
          reviewedBy: reviewer,
          isPartOf: { '@id': websiteId },
        }, organization, website],
      },
    };
  });

  return pages.concat(comparePages, useCasePages, [guidesIndexPage], guidePages);
};

export const renderStaticPage = (template, page) => {
  const staticTemplate = page.staticOnly ? staticDocument(template) : template;
  const withMetadata = replaceMarkedSection(staticTemplate, metadataStart, metadataEnd, metadata(page));
  if (!withMetadata.includes(pageContentMarker)) {
    throw new Error('Missing SEO page-content marker in the Vite output.');
  }
  // A function replacement, so "$&" or "$'" in pasted markdown stays literal.
  return withMetadata.replace(pageContentMarker, () => page.content);
};

export const generateSeoPages = async ({ outputDir = buildDir } = {}) => {
  const [template, translationText, useCaseText, guideText, faqText] = await Promise.all([
    readFile(resolve(outputDir, 'index.html'), 'utf8'),
    readFile(resolve(frontendDir, 'src/i18n/locales/en.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/use-cases.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/guides.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/landing-faq.json'), 'utf8'),
  ]);
  const translations = JSON.parse(translationText);
  const useCases = JSON.parse(useCaseText);
  const guides = JSON.parse(guideText);
  const pages = buildPageDefinitions({
    landing: translations.landing, compare: translations.compare, useCases, guides, landingFaq: JSON.parse(faqText),
  });

  await Promise.all(pages.map(async (page) => {
    const outputPath = resolve(outputDir, page.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderStaticPage(template, page));
  }));

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.filter((page) => !page.noindex).map((page) => `  <url><loc>${pageUrl(page.path)}</loc></url>`).join('\n')}\n</urlset>\n`;
  await writeFile(resolve(outputDir, 'sitemap.xml'), sitemap);
  return pages;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateSeoPages().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
