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

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const list = (items) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;

const replaceMarkedSection = (template, start, end, content) => {
  const startIndex = template.indexOf(start);
  const endIndex = template.indexOf(end);

  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(`Missing or malformed ${start} marker in the Vite output.`);
  }

  return `${template.slice(0, startIndex)}${start}\n${content}\n${end}${template.slice(endIndex + end.length)}`;
};

const pageUrl = (path) => `${siteUrl}${path}`;

const renderLanding = (landing, useCases, guides) => {
  const featureCards = [
    landing.features.pods,
    landing.features.team,
    landing.features.dm,
    landing.features.identity,
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

  const useCaseCards = Object.entries(useCases).map(([id, useCase]) => `
    <article class="seo-card">
      <p class="seo-kicker">${escapeHtml(useCase.eyebrow)}</p>
      <h3><a href="/use-cases/${encodeURIComponent(id)}/">${escapeHtml(useCase.title)}</a></h3>
      <p>${escapeHtml(useCase.summary)}</p>
    </article>`).join('');

  const guideCards = Object.entries(guides).map(([id, guide]) => `
    <article class="seo-card">
      <p class="seo-kicker">${escapeHtml(guide.eyebrow)}</p>
      <h3><a href="/guides/${encodeURIComponent(id)}/">${escapeHtml(guide.title)}</a></h3>
      <p>${escapeHtml(guide.summary)}</p>
    </article>`).join('');

  return `
    <div id="seo-page">
      <header class="seo-header">
        <a class="seo-brand" href="/" aria-label="Commonly home">Commonly</a>
        <nav aria-label="Primary navigation">
          <a href="#features">Features</a>
          <a href="#use-cases">Use cases</a>
          <a href="#guides">Guides</a>
          <a href="/compare/">Compare</a>
          <a href="https://github.com/Team-Commonly/commonly">GitHub</a>
        </nav>
      </header>
      <main>
        <section class="seo-hero">
          <p class="seo-kicker">${escapeHtml(landing.hero.eyebrow)}</p>
          <h1>${escapeHtml(landing.hero.ariaLabel)}</h1>
          <p class="seo-lede">${escapeHtml(landing.hero.lede)}</p>
          <p class="seo-actions"><a class="seo-primary" href="/v2/register">${escapeHtml(landing.actions.getStarted)}</a><a href="/v2/showcase">${escapeHtml(landing.actions.watchLiveRoom)}</a></p>
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
        <section id="use-cases">
          <p class="seo-kicker">${escapeHtml(landing.useCases.kicker)}</p>
          <h2>${escapeHtml(landing.useCases.title)}</h2>
          <div class="seo-grid">${useCaseCards}</div>
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
        </section>
      </main>
      <footer class="seo-footer">Commonly is open source under Apache-2.0.</footer>
    </div>`;
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

const renderUseCase = (useCase) => `
  <div id="seo-page">
    <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a><a href="/compare/">Compare</a></nav></header>
    <main>
      <section class="seo-hero">
        <p class="seo-kicker">${escapeHtml(useCase.eyebrow)}</p>
        <h1>${escapeHtml(useCase.title)}</h1>
        <p class="seo-lede">${escapeHtml(useCase.summary)}</p>
        <p class="seo-actions"><a class="seo-primary" href="/v2/register">Start with this use case</a><a href="/v2/agents">Explore Agent Hub</a></p>
      </section>
      <section>
        <div class="seo-grid">
          <article class="seo-card"><h2>Commonly solves</h2>${list(useCase.problems)}</article>
          <article class="seo-card"><h2>Expected outcomes</h2>${list(useCase.outcomes)}</article>
        </div>
      </section>
      <section><h2>Example flow</h2><ol>${useCase.exampleFlow.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol></section>
      ${useCase.relatedGuides?.length ? `<section><h2>Related guides</h2><ul>${useCase.relatedGuides.map((guide) => `<li><a href="${escapeHtml(guide.path)}">${escapeHtml(guide.title)}</a></li>`).join('')}</ul></section>` : ''}
    </main>
    <footer class="seo-footer"><a href="/">Back to Commonly</a></footer>
  </div>`;

const renderGuide = (guide) => {
  const sections = guide.sections.map((section) => `
    <section>
      <h2>${escapeHtml(section.title)}</h2>
      ${(section.paragraphs || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}
      ${section.bullets?.length ? list(section.bullets) : ''}
      ${section.orderedItems?.length ? `<ol>${section.orderedItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>` : ''}
    </section>`).join('');
  const faq = guide.faq.map((item) => `
    <article class="seo-card"><h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p></article>`).join('');
  const relatedLinks = guide.relatedLinks.map((link) => `<a href="${escapeHtml(link.path)}">${escapeHtml(link.label)}</a>`).join(' · ');

  return `
  <div id="seo-page">
    <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a><a href="/guides/">Guides</a><a href="/use-cases/agent-collab/">Agent collaboration</a><a href="/compare/">Compare</a></nav></header>
    <main>
      <section class="seo-hero">
        <p class="seo-kicker">${escapeHtml(guide.eyebrow)}</p>
        <h1>${escapeHtml(guide.title)}</h1>
        <p class="seo-lede">${escapeHtml(guide.description)}</p>
        ${(guide.intro || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}
      </section>
      ${sections}
      <section><h2>Frequently asked questions</h2><div class="seo-grid">${faq}</div></section>
      <section class="seo-band"><h2>${escapeHtml(guide.cta.title)}</h2><p>${escapeHtml(guide.cta.body)}</p><p class="seo-actions"><a class="seo-primary" href="${escapeHtml(guide.cta.primary.path)}">${escapeHtml(guide.cta.primary.label)}</a><a href="${escapeHtml(guide.cta.secondary.path)}">${escapeHtml(guide.cta.secondary.label)}</a></p></section>
      <p class="seo-note">${relatedLinks}</p>
    </main>
    <footer class="seo-footer"><a href="/">Back to Commonly</a></footer>
  </div>`;
};

const renderGuidesIndex = (guides) => {
  const guideCards = Object.entries(guides).map(([id, guide]) => `
    <article class="seo-card">
      <p class="seo-kicker">${escapeHtml(guide.eyebrow)}</p>
      <h2><a href="/guides/${encodeURIComponent(id)}/">${escapeHtml(guide.title)}</a></h2>
      <p>${escapeHtml(guide.summary)}</p>
      <p><a href="/guides/${encodeURIComponent(id)}/">Read the guide</a></p>
    </article>`).join('');

  return `
    <div id="seo-page">
      <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a><a href="/use-cases/agent-collab/">Agent collaboration</a><a href="/compare/">Compare</a></nav></header>
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
      <footer class="seo-footer"><a href="/">Back to Commonly</a></footer>
    </div>`;
};

const metadata = ({ title, description, path, schema, ogType = 'website' }) => {
  const url = pageUrl(path);
  const structuredData = JSON.stringify(schema).replaceAll('<', '\\u003c');
  return `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="index,follow" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="${escapeHtml(ogType)}" />
    <meta property="og:site_name" content="Commonly" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${siteUrl}/og-card.png?v=2" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@sam_commonly" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${siteUrl}/og-card.png?v=2" />
    <script type="application/ld+json">${structuredData}</script>`;
};

export const buildPageDefinitions = ({ landing, compare, useCases, guides = {} }) => {
  const organization = {
    '@type': 'Organization',
    name: 'Commonly',
    url: `${siteUrl}/`,
    logo: `${siteUrl}/favicon.svg`,
    sameAs: ['https://github.com/Team-Commonly/commonly'],
  };
  const softwareApplication = {
    '@type': 'SoftwareApplication',
    name: 'Commonly',
    url: `${siteUrl}/`,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: landing.hero.lede,
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
  };
  const webPage = (title, description, path) => ({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    description,
    url: pageUrl(path),
    isPartOf: { '@type': 'WebSite', name: 'Commonly', url: `${siteUrl}/` },
  });

  const pages = [{
    path: '/',
    outputPath: 'index.html',
    title: 'Commonly — chat with your agents, ship real work',
    description: 'The open-source workspace where agents and teammates share one project memory — any runtime, your infra, no per-agent fees.',
    content: renderLanding(landing, useCases, guides),
    schema: {
      '@context': 'https://schema.org',
      '@graph': [organization, softwareApplication],
    },
  }, {
    path: '/compare/',
    outputPath: 'compare/index.html',
    title: 'Commonly vs the alternatives | Commonly',
    description: compare.lede,
    content: renderCompare(compare),
    schema: webPage(compare.title, compare.lede, '/compare/'),
  }];

  const guidesIndexPath = '/guides/';
  const guidesIndexPage = {
    path: guidesIndexPath,
    outputPath: 'guides/index.html',
    title: 'Guides for teams working with AI agents | Commonly',
    description: 'Practical guides for teams that work with AI agents: shared context, task ownership, human review, and durable handoffs.',
    content: renderGuidesIndex(guides),
    schema: webPage('Guides for teams working with AI agents', 'Practical guides for teams that work with AI agents: shared context, task ownership, human review, and durable handoffs.', guidesIndexPath),
  };

  const useCasePages = Object.entries(useCases).map(([id, useCase]) => {
    const path = `/use-cases/${id}/`;
    return {
      path,
      outputPath: `use-cases/${id}/index.html`,
      title: `${useCase.title} | Commonly`,
      description: useCase.summary,
      content: renderUseCase(useCase),
      schema: webPage(useCase.title, useCase.summary, path),
    };
  });

  const guidePages = Object.entries(guides).map(([id, guide]) => {
    const path = `/guides/${id}/`;
    return {
      path,
      outputPath: `guides/${id}/index.html`,
      title: guide.titleTag,
      description: guide.description,
      content: renderGuide(guide),
      ogType: 'article',
      schema: {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: guide.title,
        description: guide.description,
        mainEntityOfPage: { '@type': 'WebPage', '@id': pageUrl(path) },
        author: { '@type': 'Organization', name: 'Commonly', url: `${siteUrl}/` },
        publisher: organization,
      },
    };
  });

  return pages.concat(useCasePages, [guidesIndexPage], guidePages);
};

export const renderStaticPage = (template, page) => {
  const withMetadata = replaceMarkedSection(template, metadataStart, metadataEnd, metadata(page));
  if (!withMetadata.includes(pageContentMarker)) {
    throw new Error('Missing SEO page-content marker in the Vite output.');
  }
  return withMetadata.replace(pageContentMarker, page.content);
};

export const generateSeoPages = async ({ outputDir = buildDir } = {}) => {
  const [template, translationText, useCaseText, guideText] = await Promise.all([
    readFile(resolve(outputDir, 'index.html'), 'utf8'),
    readFile(resolve(frontendDir, 'src/i18n/locales/en.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/use-cases.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/guides.json'), 'utf8'),
  ]);
  const translations = JSON.parse(translationText);
  const useCases = JSON.parse(useCaseText);
  const guides = JSON.parse(guideText);
  const pages = buildPageDefinitions({ landing: translations.landing, compare: translations.compare, useCases, guides });

  await Promise.all(pages.map(async (page) => {
    const outputPath = resolve(outputDir, page.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderStaticPage(template, page));
  }));

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((page) => `  <url><loc>${pageUrl(page.path)}</loc></url>`).join('\n')}\n</urlset>\n`;
  await writeFile(resolve(outputDir, 'sitemap.xml'), sitemap);
  return pages;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateSeoPages().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
