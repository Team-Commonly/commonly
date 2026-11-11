import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEXNOW_KEY, indexNowKeyFile } from './indexnow.mjs';

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
const ogImage = `${siteUrl}/og-card.png?v=7`;

// Search results cut a title near 60 characters and a description near 160
// (F397). Fitted once here, so a long guide title can't ship.
const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 160;
const siteSuffix = ' | Commonly AI';
const charCount = (text) => [...text].length;

// A head shorter than this is a name ("Commonly: …"), not a title on its own.
const MIN_TITLE_HEAD = 12;

export const fitTitle = (title) => {
  if (!String(title || '').trim()) throw new Error('A page has an empty title.');
  const hasSuffix = title.endsWith(siteSuffix);
  const base = hasSuffix ? title.slice(0, -siteSuffix.length) : title;
  const withSuffix = (text) => (hasSuffix && charCount(text + siteSuffix) <= TITLE_LIMIT ? text + siteSuffix : text);
  if (charCount(base) <= TITLE_LIMIT) return withSuffix(base);
  // "Head: subtitle" keeps its head, the part people search for, and
  // "Question? Subtitle" keeps the question.
  const split = base.match(/^(.+?)([:?])\s/);
  const head = split ? `${split[1]}${split[2] === '?' ? '?' : ''}` : base;
  if (head !== base && charCount(head) >= MIN_TITLE_HEAD && charCount(head) <= TITLE_LIMIT) return withSuffix(head);
  throw new Error(`Title over ${TITLE_LIMIT} characters with no subtitle to drop: "${title}". Give the page a shorter titleTag.`);
};

// A cut never ends on one of these: "…the context packet that makes…" reads broken.
const DANGLING = new Set(['a', 'an', 'and', 'or', 'nor', 'but', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with',
  'without', 'from', 'into', 'as', 'that', 'which', 'who', 'whom', 'whose', 'where', 'when', 'while', 'so', 'than',
  'is', 'are', 'can', 'its', 'their', 'your', 'our', 'what', 'how', 'why', 'whether', 'before', 'after', 'instead',
  'between', 'each', 'every', 'one', 'keep', 'makes', 'make', 'let', 'lets']);
const ABBREVIATION = /\b(?:vs|e\.g|i\.e|etc|approx|incl)$/i;

export const fitDescription = (description) => {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (charCount(text) <= DESCRIPTION_LIMIT) return text;
  const room = [...text].slice(0, DESCRIPTION_LIMIT).join('');
  // The last whole sentence, unless the stop belongs to "vs." or "e.g.".
  for (let at = room.length - 2; at >= 80; at -= 1) {
    if (/[.?!]/.test(room[at]) && room[at + 1] === ' ' && !ABBREVIATION.test(room.slice(0, at))) return room.slice(0, at + 1);
  }
  // Else the last clause that still says most of it, else the last word, and
  // never a dangling one.
  const words = [...text].slice(0, DESCRIPTION_LIMIT - 1).join('');
  const clause = Math.max(words.lastIndexOf(', '), words.lastIndexOf(': '), words.lastIndexOf('; '), words.lastIndexOf('—'));
  let cut = clause >= 110 ? words.slice(0, clause) : words.slice(0, words.lastIndexOf(' '));
  for (;;) {
    cut = cut.replace(/[\s,;:—–-]+$/, '');
    const last = cut.slice(cut.lastIndexOf(' ') + 1).toLowerCase();
    if (!DANGLING.has(last) || cut.lastIndexOf(' ') < 0) break;
    cut = cut.slice(0, cut.lastIndexOf(' '));
  }
  return `${cut}…`;
};

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

const isIsoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// The landing's lastmod: the later of its copy (en.json "landing") and its FAQ
// (landing-faq.json). Change it when either changes (F395).
export const LANDING_DATE_MODIFIED = '2026-11-11';

const recordedDate = (where, value) => {
  if (value === undefined) return undefined;
  if (!isIsoDate(value)) throw new Error(`${where} has a dateModified that is not YYYY-MM-DD.`);
  return value;
};

const guideProvenance = (guide) => {
  const provenance = guide.provenance;
  const required = ['author', 'reviewer', 'datePublished', 'dateModified'];

  if (!provenance || required.some((field) => !provenance[field])) {
    throw new Error(`Guide ${guide.title} is missing required provenance.`);
  }

  // The dates go raw into the sitemap's lastmod and the Article JSON-LD, and the
  // string comparison below only orders full YYYY-MM-DD dates correctly.
  const badDate = ['datePublished', 'dateModified'].find((field) => !isIsoDate(provenance[field]));
  if (badDate) {
    throw new Error(`Guide ${guide.title} has a ${badDate} that is not YYYY-MM-DD.`);
  }

  if (guide.revised !== undefined) {
    if (!isIsoDate(guide.revised) || guide.revised < provenance.dateModified) {
      throw new Error(`Guide ${guide.title} has a revised date that is not YYYY-MM-DD on or after its dateModified.`);
    }
  } else if (guide.answer !== undefined) {
    throw new Error(`Guide ${guide.title} has an answer block but no revised date; the two land in one pass.`);
  }

  if (provenance.dateModified < provenance.datePublished) {
    throw new Error(`Guide ${guide.title} has a modified date before its published date.`);
  }

  return guide.revised ? { ...provenance, dateModified: guide.revised } : provenance;
};

// D295 (F430). A guide whose batch has landed carries `revised`, and that one field turns on the
// whole pass together: the answer block, Sam as the named author, and the new Updated date. A guide
// without it renders exactly as before. Nothing about the author beyond his name and his X link.
export const GUIDE_AUTHOR = { name: 'Sam Xu', url: 'https://x.com/sam_commonly' };
export const guideAuthorPerson = () => ({
  '@type': 'Person', name: GUIDE_AUTHOR.name, url: GUIDE_AUTHOR.url, sameAs: [GUIDE_AUTHOR.url],
});

const renderGuideProvenance = (guide) => {
  const provenance = guideProvenance(guide);
  const published = formatDate(provenance.datePublished);
  const modified = formatDate(provenance.dateModified);
  const dates = provenance.datePublished === provenance.dateModified
    ? `Published and updated <time datetime="${escapeHtml(provenance.datePublished)}">${escapeHtml(published)}</time>`
    : `Published <time datetime="${escapeHtml(provenance.datePublished)}">${escapeHtml(published)}</time> · Updated <time datetime="${escapeHtml(provenance.dateModified)}">${escapeHtml(modified)}</time>`;

  const author = guide.revised
    ? `<a href="${escapeHtml(GUIDE_AUTHOR.url)}" rel="author">${escapeHtml(GUIDE_AUTHOR.name)}</a>`
    : escapeHtml(provenance.author);
  return `<p class="seo-byline">By ${author} · Reviewed by ${escapeHtml(provenance.reviewer)}<br>${dates}</p>`;
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
          <p><a href="https://github.com/Team-Commonly/commonly">${escapeHtml(landing.actions.starGithub)}</a></p>
        </section>${faqSection}
      </main>
      <footer class="seo-footer">Commonly is open source under Apache-2.0. <a href="https://www.opensourcealternatives.to"><img src="/badge-osa.svg" alt="As seen on Open Source Alternatives" width="270" height="20"></a>${siteLinks}</footer>
    </div>`;
};

// Links every static page carries, so the comparison and use-case pages are reachable from a page
// crawlers already index, not only from the sitemap (D139: most of the sitemap sits "Discovered – not indexed").
export const renderSiteLinks = ({ useCases = {}, compareSources = {} }) => {
  const compareLinks = Object.values(compareSources).map((source) => `<a href="${escapeHtml(source.path)}">${escapeHtml(source.title.split(':')[0])}</a>`);
  // The footer on every page links the use cases. linkLabel pins that text, so a use-case title
  // change touches only its own page, not every page's footer (D295's one-pass rule, F430).
  const useCaseLinks = Object.entries(useCases).map(([id, useCase]) => `<a href="/use-cases/${encodeURIComponent(id)}/">${escapeHtml(useCase.linkLabel || useCase.title)}</a>`);
  return `<nav class="seo-site-links" aria-label="More from Commonly">
        <p><a href="/guides/">Guides</a></p>
        ${compareLinks.length ? `<p>Compare: ${compareLinks.join(' · ')}</p>` : ''}
        ${useCaseLinks.length ? `<p>Use cases: ${useCaseLinks.join(' · ')}</p>` : ''}
        <p><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
      </nav>`;
};

const renderCompare = (compare, compareSources = {}, siteLinks = '') => {
  // The lede promises "each page below": list every comparison, in listOrder (F432).
  const comparisonLinks = Object.values(compareSources).map((source) => `
    <li><a href="${escapeHtml(source.path)}">${escapeHtml(source.title)}</a></li>`).join('');
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
          <h2>${escapeHtml(compare.pagesTitle)}</h2>
          <ul>${comparisonLinks}
          </ul>
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
        ${siteLinks}
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
        ${useCase.dateModified ? `<p class="seo-byline">Updated <time datetime="${escapeHtml(useCase.dateModified)}">${escapeHtml(formatDate(useCase.dateModified))}</time></p>` : ''}
        ${(useCase.intro || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}
        <p class="seo-actions"><a class="seo-primary" href="/v2/register">Start with this use case</a><a href="/v2/agents">Explore Agent Hub</a></p>
      </section>
      <section>
        <div class="seo-grid">
          <article class="seo-card"><h2>Common challenges</h2>${list(useCase.problems)}</article>
          <article class="seo-card"><h2>What you can do</h2>${list(useCase.outcomes)}</article>
        </div>
      </section>
      <section><h2>Example flow</h2><ol>${useCase.exampleFlow.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol></section>
      ${(useCase.sections || []).map(renderContentSection).join('')}
      ${useCase.faq?.length ? `<section><h2>Frequently asked questions</h2><div class="seo-grid">${useCase.faq.map((item) => `
        <article class="seo-card"><h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p></article>`).join('')}</div></section>` : ''}
      ${useCase.relatedGuides?.length ? `<section><h2>Related guides</h2><ul>${useCase.relatedGuides.map((guide) => `<li><a href="${escapeHtml(guide.path)}">${escapeHtml(guide.title)}</a></li>`).join('')}</ul></section>` : ''}
    </main>
    <footer class="seo-footer"><a href="/">Back to Commonly</a>${siteLinks}</footer>
  </div>`;

// One content section, shared by guides and the long-form use cases.
const renderContentSection = (section) => `
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
    </section>`;

const renderGuide = (guide, siteLinks = '') => {
  const sections = guide.sections.map(renderContentSection).join('');
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
        ${renderGuideProvenance(guide)}${guide.answer ? `
        <p><strong>Short answer.</strong> ${escapeHtml(guide.answer)}</p>` : ''}
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

// The legal pages, from the same words V2LegalPage renders (content/legal.json).
// Each commonly.me address becomes a mailto link, as on the page.
const linkLegalEmails = (text) => escapeHtml(text).replace(/([a-z]+@commonly\.me)/g, '<a href="mailto:$1">$1</a>');

const renderLegal = (title, sections, siteLinks = '') => `
    <div id="seo-page">
      <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a></nav></header>
      <main class="seo-article">
        <h1>${escapeHtml(title)}</h1>
        ${sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2>${section.body.map((paragraph) => `<p>${linkLegalEmails(paragraph)}</p>`).join('')}</section>`).join('\n        ')}
      </main>
      <footer class="seo-footer"><a href="/">Back to Commonly</a>${siteLinks}</footer>
    </div>`;

const USE_CASES_INDEX = {
  titleTag: 'AI agent use cases for teams',
  title: 'AI agent use cases: how teams work with agents in shared pods',
  lede: 'How teams use Commonly: pods where people and their agents share the same conversations, tasks and context.',
};

const renderUseCasesIndex = (useCases, siteLinks = '') => {
  const cards = Object.entries(useCases).map(([id, useCase]) => `
    <article class="seo-card">
      <p class="seo-kicker">${escapeHtml(useCase.eyebrow)}</p>
      <h2><a href="/use-cases/${encodeURIComponent(id)}/">${escapeHtml(useCase.title)}</a></h2>
      <p>${escapeHtml(useCase.summary)}</p>
    </article>`).join('');
  return `
    <div id="seo-page">
      <header class="seo-header"><a class="seo-brand" href="/">Commonly</a><nav aria-label="Primary navigation"><a href="/">Home</a><a href="/guides/">Guides</a></nav></header>
      <main>
        <section class="seo-hero">
          <p class="seo-kicker">Use cases</p>
          <h1>${escapeHtml(USE_CASES_INDEX.title)}</h1>
          <p class="seo-lede">${escapeHtml(USE_CASES_INDEX.lede)}</p>
        </section>
        <section>
          <div class="seo-grid">${cards}</div>
        </section>
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

const metadata = ({ title, description, path, schema, faqSchema, faqSchemaId = faqJsonLdId, ogType = 'website', datePublished, dateModified, noindex = false }) => {
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
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    ${articleDates}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@sam_commonly" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${ogImage}" />
    <script type="application/ld+json">${structuredData}</script>${faqSchema ? `
    <script type="application/ld+json" id="${faqSchemaId}">${jsonLd(faqSchema)}</script>` : ''}`;
};

// Compare pages (GEO, D104; one data file per competitor since F429). Each file in
// src/content/compare/ is GTM's copy for one competitor, in fields; compareMarkdown is the one
// template that lays every page out. The build refuses a page whose competitor facts aren't
// sourced (assertCompareSourced), and, as before, one with an open [HOLD: ...] marker.
const compareDir = resolve(frontendDir, 'src/content/compare');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const compareMarkdown = (data) => {
  const parts = [
    `# Commonly vs ${data.name}`,
    `*${data.updated}*`,
    `**Short answer.** ${data.shortAnswer}`,
    ...(data.notes || []),
    `## What each ships today

| | ${data.table.them} | Commonly |
|---|---|---|
${data.table.rows.map((row) => `| **${row.label}** | ${row.them} | ${row.us} |`).join('\n')}`,
    ...(data.afterTable || []),
    `## When to pick ${data.pickThem.name}

${data.pickThem.items.map((item) => `- ${item}`).join('\n')}`,
    `## When to pick Commonly

${data.pickUs.map((item) => `- ${item}`).join('\n')}`,
    `## FAQ

${data.faq.map((entry) => `**${entry.q}**\n${entry.a}`).join('\n\n')}`,
    `## Sources

${data.sourcesIntro}

${data.sources.map((source, index) => `${index + 1}. ${source.label}: ${source.url}${source.note ? ` (${source.note})` : ''}`).join('\n')}`,
    data.closing,
  ];
  return `${parts.join('\n\n')}\n`;
};

// Every source names where it was read and when, every competitor cell in the facts table cites
// at least one source, and every [n] on the page points at a listed source (F429).
export const assertCompareSourced = (id, data) => {
  const problems = [];
  const sources = data.sources || [];
  if (!sources.length) problems.push('no sources');
  sources.forEach((source, index) => {
    // Each source carries its own number, so inserting one mid-list can't silently shift every later [n].
    if (source.n !== index + 1) problems.push(`source ${index + 1} is numbered ${source.n}; sources are numbered 1, 2, 3 in order`);
    if (!/^https:\/\/\S+$/.test(source.url || '')) problems.push(`source ${index + 1} has no https URL`);
    if (!ISO_DATE.test(source.read || '')) problems.push(`source ${index + 1} has no read date (YYYY-MM-DD)`);
  });
  for (const row of data.table?.rows || []) {
    // [1](https://...) is a link, not a citation.
    if (!/\[\d+\](?!\()/.test(row.them || '')) problems.push(`"${row.label}" states a ${data.name} fact with no source`);
  }
  const markdown = compareMarkdown(data);
  for (const [, n] of markdown.matchAll(/\[(\d+)\](?!\()/g)) {
    if (Number(n) < 1 || Number(n) > sources.length) problems.push(`[${n}] cites no listed source`);
  }
  for (const field of ['datePublished', 'dateModified']) {
    if (!ISO_DATE.test(data[field] || '')) problems.push(`${field} is not YYYY-MM-DD`);
  }
  if (data.dateModified < data.datePublished) problems.push(`dateModified ${data.dateModified} is before datePublished ${data.datePublished}`);
  if (data.path !== `/compare/${id}/`) problems.push(`path ${data.path} is not /compare/${id}/`);
  if (!Number.isInteger(data.listOrder)) problems.push('listOrder is not a whole number');
  if (problems.length) throw new Error(`compare/${id}: ${[...new Set(problems)].join('; ')}`);
};

export const compareSourceFromData = (id, data) => {
  assertCompareSourced(id, data);
  return {
    path: data.path,
    datePublished: data.datePublished,
    // The sitemap's lastmod. Change it with the text (F395).
    dateModified: data.dateModified,
    title: data.title,
    description: data.description,
    markdown: compareMarkdown(data),
  };
};

export const loadCompareSources = (dir = compareDir) => Object.fromEntries(readdirSync(dir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => {
    try {
      return [file.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(dir, file), 'utf8'))];
    } catch (error) {
      throw new Error(`compare/${file}: ${error.message}`);
    }
  })
  // listOrder fixes the order the footer links and llms.txt list them in.
  .sort(([, a], [, b]) => a.listOrder - b.listOrder)
  .map(([id, data]) => [id, compareSourceFromData(id, data)]));

const comparePageSources = loadCompareSources();

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

export const buildPageDefinitions = ({ landing, compare, useCases, guides = {}, landingFaq = [], compareSources = comparePageSources, legal = null }) => {
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
  const webPage = (title, description, path, dates = {}) => ({
    '@context': 'https://schema.org',
    '@graph': [organization, website, { ...webPageNode(title, description, path), ...dates }],
  });

  const landingPage = {
    path: '/',
    outputPath: 'index.html',
    title: 'Commonly: bring your Claude Code and your teammate\'s Codex',
    description: 'Each person keeps the agent they already run on their own machine, whatever editor they use. The team works with all of them in one pod. Open source.',
    content: renderLanding(landing, guides, landingFaq, siteLinks),
    dateModified: LANDING_DATE_MODIFIED,
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
      dateModified: recordedDate(source.path, source.dateModified),
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
      // The same dates the page shows in its "Updated" line and the sitemap carries (F429, D295).
      schema: webPage(source.title, source.description, source.path, {
        ...(source.datePublished ? { datePublished: source.datePublished } : {}),
        ...(source.dateModified ? { dateModified: recordedDate(source.path, source.dateModified) } : {}),
      }),
    };
  });

  const pages = [landingPage, {
    path: '/compare/',
    outputPath: 'compare/index.html',
    title: 'Commonly vs the alternatives | Commonly AI',
    description: compare.lede,
    content: renderCompare(compare, compareSources, siteLinks),
    // The SPA has no /compare/ route and hides #seo-page once JS runs, so the hub ships without
    // the app bundle, like each comparison page (CodeRabbit on #3930).
    staticOnly: true,
    schema: webPage(compare.title, compare.lede, '/compare/'),
    // Unlisted: noindex and kept out of the sitemap. It links out to every comparison.
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
    // The index lists the guides, so it changes when the newest of them does.
    dateModified: Object.values(guides).map((guide) => guideProvenance(guide).dateModified).sort().pop(),
    schema: webPage('Guides for teams working with AI agents', 'Practical guides for teams that work with AI agents: shared context, task ownership, human review, and durable handoffs.', guidesIndexPath),
  };

  const useCasePages = Object.entries(useCases).map(([id, useCase]) => {
    const path = `/use-cases/${id}/`;
    // Checked before the page renders, since the page now shows the date (F430).
    recordedDate(path, useCase.dateModified);
    return {
      path,
      outputPath: `use-cases/${id}/index.html`,
      title: `${useCase.titleTag || useCase.title} | Commonly AI`,
      description: useCase.summary,
      content: renderUseCase(useCase, siteLinks),
      // Static like the guides: the page a reader gets is the one crawlers read.
      staticOnly: true,
      dateModified: recordedDate(path, useCase.dateModified),
      schema: webPage(useCase.title, useCase.summary, path, {
        ...(useCase.datePublished ? { datePublished: recordedDate(path, useCase.datePublished) } : {}),
        ...(useCase.dateModified ? { dateModified: useCase.dateModified } : {}),
      }),
      // Its own id: the landing's React effect reuses the landing-faq-jsonld tag.
      ...(useCase.faq?.length ? { faqSchema: faqPageJsonLd(useCase.faq), faqSchemaId: 'use-case-faq-jsonld' } : {}),
    };
  });

  const guidePages = Object.entries(guides).map(([id, guide]) => {
    const path = `/guides/${id}/`;
    const provenance = guideProvenance(guide);
    const author = guide.revised
      ? guideAuthorPerson()
      : { '@type': 'Organization', '@id': organizationId, name: provenance.author, url: `${siteUrl}/` };
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
          image: ogImage,
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

  // /use-cases/ was a 403: a directory of pages with no index (F396).
  const useCasesIndexPage = {
    path: '/use-cases/',
    outputPath: 'use-cases/index.html',
    title: `${USE_CASES_INDEX.titleTag} | Commonly AI`,
    description: USE_CASES_INDEX.lede,
    content: renderUseCasesIndex(useCases, siteLinks),
    // No app route serves /use-cases/, so the page stays static.
    staticOnly: true,
    // The newest use case's date: the index lists them all, so it changes
    // whenever one does.
    dateModified: Object.values(useCases).map((useCase) => useCase.dateModified).filter(Boolean).sort().at(-1),
    schema: webPage(USE_CASES_INDEX.title, USE_CASES_INDEX.lede, '/use-cases/'),
  };

  // /privacy and /terms are app routes, so they were served the prerendered
  // homepage and its canonical. Their own page keeps the app and gives
  // crawlers (and Google's OAuth review) the same words (F396).
  const legalPages = legal ? [
    ['/privacy/', 'Privacy', 'How Commonly Software LLC stores, uses and deletes your data on commonly.me.', legal.privacy],
    ['/terms/', 'Terms', 'The terms for using commonly.me, run by Commonly Software LLC.', legal.terms],
  ].map(([path, title, description, sections]) => ({
    path,
    outputPath: `${path.slice(1)}index.html`,
    title: `${title} | Commonly AI`,
    description,
    content: renderLegal(title, sections, siteLinks),
    // V2LegalPage.tsx's last change on main when this was written.
    dateModified: '2026-11-09',
    schema: webPage(title, description, path),
  })) : [];

  // Home > (Guides >) page, for every page but home (F397). Only /guides/ is
  // a section index every page under it can point to.
  const crumb = (name, path, position) => ({ '@type': 'ListItem', position, name, item: pageUrl(path) });
  const withBreadcrumbs = (page) => {
    if (page.path === '/') return page;
    const trail = [['Home', '/']];
    if (page.path.startsWith(guidesIndexPath) && page.path !== guidesIndexPath) trail.push(['Guides', guidesIndexPath]);
    trail.push([page.title.replace(siteSuffix, ''), page.path]);
    const breadcrumbs = {
      '@type': 'BreadcrumbList',
      '@id': `${pageUrl(page.path)}#breadcrumb`,
      itemListElement: trail.map(([name, path], index) => crumb(name, path, index + 1)),
    };
    return { ...page, schema: { ...page.schema, '@graph': [...page.schema['@graph'], breadcrumbs] } };
  };

  return pages.concat(comparePages, useCasePages, [useCasesIndexPage], [guidesIndexPage], guidePages, legalPages)
    .map((page) => withBreadcrumbs({ ...page, title: fitTitle(page.title), description: fitDescription(page.description) }));
};

// The SPA fallback (nginx.conf). It used to be index.html, which the build
// overwrites with the prerendered homepage, so every app-only path (/v2/…,
// /login, an unknown /v2/x) claimed the homepage's title and canonical. The
// shell has no canonical, says noindex, and carries no page content (F396).
export const renderAppShell = (template) => {
  const shell = replaceMarkedSection(template, metadataStart, metadataEnd, `
    <title>Commonly</title>
    <meta name="robots" content="noindex" />`);
  if (!shell.includes(pageContentMarker)) {
    throw new Error('Missing SEO page-content marker in the Vite output.');
  }
  return shell.replace(pageContentMarker, '');
};

// Logged-out page counts (D286). One count per page load and per signup or
// pricing click, sent to our own API with no cookie, no stored key and no
// identifier. It does nothing for a signed-in visitor (the app sends their
// events), or when Do Not Track or Global Privacy Control is on. The server
// keeps a day's total per page and campaign code, and nothing else.
const publicHitBody = `
var n=navigator;if(n.doNotTrack==='1'||window.doNotTrack==='1'||n.globalPrivacyControl)return;
try{if(localStorage.getItem('token'))return}catch(e){}
var api=__API__,h=location.hostname;
if(!api){if(h==='localhost'||h==='127.0.0.1')api='http://localhost:5000';else return}
var ps=location.search.replace(/^\\?/,'').split('&'),ref='';
for(var k=0;k<ps.length;k++){if(ps[k].indexOf('ref=')===0){try{ref=decodeURIComponent(ps[k].slice(4))}catch(e){ref=''}break}}
var page=location.pathname;
var send=function(name,value){var b={name:name,page:page};if(ref)b.ref=ref;if(value)b.value=value;
fetch(api+'/api/stats/public-hit',{method:'POST',keepalive:true,credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).catch(function(){})};
send('page-view');
document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;
var href=a.getAttribute('href')||'',cta;
if(href.indexOf('pricing')>=0)cta='pricing';else if(href.indexOf('register')<0)return;
else if(a.closest('header,nav'))cta='nav-signup';
else cta=page.indexOf('/guides/')===0?'guide-inline':page.indexOf('/compare/')===0?'compare-inline':'hero-start';
send('cta-click',cta)},true);
`;
export const publicHitScript = (apiBase = process.env.REACT_APP_API_URL || '') => {
  const api = JSON.stringify(apiBase).replace(/</g, '\\u003c');
  return `<script data-usage="public-hit">(function(){try{${publicHitBody.replace('__API__', () => api)}}catch(e){}})();</script>`;
};

export const renderStaticPage = (template, page) => {
  const staticTemplate = page.staticOnly ? staticDocument(template) : template;
  const withMetadata = replaceMarkedSection(staticTemplate, metadataStart, metadataEnd, metadata(page));
  if (!withMetadata.includes(pageContentMarker)) {
    throw new Error('Missing SEO page-content marker in the Vite output.');
  }
  // A function replacement, so "$&" or "$'" in pasted markdown stays literal.
  const html = withMetadata.replace(pageContentMarker, () => page.content);
  const bodyEnd = html.lastIndexOf('</body>');
  if (bodyEnd < 0) throw new Error('Missing closing body tag in the SEO page template.');
  return `${html.slice(0, bodyEnd)}${publicHitScript()}\n${html.slice(bodyEnd)}`;
};

// llms.txt and llms-full.txt (F395). public/llms.txt is the hand-written head; the
// build keeps it word for word up to its "## Guides" section and lists every
// indexable page from the same content the pages are built from, so the map
// can't fall behind the site. llms-full.txt carries those pages' text.
const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();
// A guide paragraph is a string or { strong } (renderGuide draws the latter bold).
const paragraphText = (paragraph) => oneLine(typeof paragraph === 'object' && paragraph ? paragraph.strong : paragraph);
const llmsLink = (title, path, description) => `- [${oneLine(title)}](${pageUrl(path)}): ${oneLine(description)}`;

export const renderLlmsTxt = ({ base, guides = {}, useCases = {}, compareSources = {}, pages = [] }) => {
  const cut = base.indexOf('## Guides');
  if (cut === -1) throw new Error('public/llms.txt needs a "## Guides" section for the build to list the pages under.');
  const head = base.slice(0, cut).replace(/\s*$/, '\n\n');
  const guideLines = Object.entries(guides).map(([id, guide]) => llmsLink(guide.title, `/guides/${id}/`, guide.description));
  const compareLines = Object.values(compareSources).map((source) => llmsLink(source.title, source.path, source.description));
  const useCaseLines = Object.entries(useCases).map(([id, useCase]) => llmsLink(useCase.title, `/use-cases/${id}/`, useCase.summary));
  // Any other indexable page (a new index or a legal page) is listed too, so the
  // map always matches the sitemap.
  const listed = new Set(['/', '/guides/', ...Object.keys(guides).map((id) => `/guides/${id}/`),
    ...Object.values(compareSources).map((source) => source.path), ...Object.keys(useCases).map((id) => `/use-cases/${id}/`)]);
  const otherLines = pages.filter((page) => !page.noindex && !listed.has(page.path))
    .map((page) => llmsLink(page.title.replace(/\s*\|\s*Commonly AI$/, ''), page.path, page.description));
  return `${head}## Guides

${llmsLink('Guides', '/guides/', 'guides for teams working with AI agents')}
${guideLines.join('\n')}

## Compare

${compareLines.join('\n')}

## Use cases

${useCaseLines.join('\n')}

## Optional

${llmsLink('commonly.me home', '/', 'what Commonly is, in one page')}
${otherLines.map((line) => `${line}\n`).join('')}- [Full text](${pageUrl('/llms-full.txt')}): every guide, comparison and use case above in one file
`;
};

const guideFullText = (guide) => {
  const parts = [oneLine(guide.summary), ...(guide.intro || []).map(oneLine)];
  (guide.sections || []).forEach((section) => {
    parts.push(`### ${oneLine(section.title)}`);
    (section.paragraphs || []).forEach((paragraph) => parts.push(paragraphText(paragraph)));
    if (section.bullets?.length) parts.push(section.bullets.map((item) => `- ${oneLine(item)}`).join('\n'));
    if (section.orderedItems?.length) parts.push(section.orderedItems.map((item, i) => `${i + 1}. ${oneLine(item)}`).join('\n'));
    (section.tables || []).forEach((table) => {
      const row = (cells) => `| ${cells.map(oneLine).join(' | ')} |`;
      parts.push([row(table.headers), row(table.headers.map(() => '---')), ...table.rows.map(row)].join('\n'));
    });
    (section.codeBlocks || []).forEach((block) => parts.push(`\`\`\`${block.language || ''}\n${block.code}\n\`\`\``));
    if (section.links?.length) {
      parts.push(section.links.map((link) => `- ${oneLine(link.label)}: ${link.external ? link.path : pageUrl(link.path)}`).join('\n'));
    }
  });
  if (guide.faq?.length) {
    parts.push('### FAQ');
    guide.faq.forEach((item) => parts.push(`Q: ${oneLine(item.question)}\nA: ${oneLine(item.answer)}`));
  }
  if (guide.cta?.title) parts.push(`### ${oneLine(guide.cta.title)}`, oneLine(guide.cta.body));
  return parts.filter(Boolean).join('\n\n');
};

const useCaseFullText = (useCase) => [
  oneLine(useCase.summary),
  ...(useCase.intro || []).map(oneLine),
  '### Problems',
  (useCase.problems || []).map((item) => `- ${oneLine(item)}`).join('\n'),
  '### Outcomes',
  (useCase.outcomes || []).map((item) => `- ${oneLine(item)}`).join('\n'),
  '### Example flow',
  (useCase.exampleFlow || []).map((item, i) => `${i + 1}. ${oneLine(item)}`).join('\n'),
  ...(useCase.sections || []).flatMap((section) => [
    `### ${oneLine(section.title)}`,
    ...(section.paragraphs || []).map(paragraphText),
    (section.bullets || []).map((item) => `- ${oneLine(item)}`).join('\n'),
    (section.links || []).map((link) => `- ${oneLine(link.label)}: ${link.external ? link.path : pageUrl(link.path)}`).join('\n'),
  ]),
  ...((useCase.faq || []).length ? ['### Frequently asked questions', ...useCase.faq.map((item) => `**${oneLine(item.question)}** ${oneLine(item.answer)}`)] : []),
].filter(Boolean).join('\n\n');

export const renderLlmsFullTxt = ({ guides = {}, useCases = {}, compareSources = {} }) => {
  const entry = (title, path, body) => `## ${oneLine(title)}\n\nURL: ${pageUrl(path)}\n\n${body.trim()}\n`;
  return [
    '# Commonly: full text of the guides, comparisons and use cases on commonly.me\n\n'
      + `> The pages listed in ${pageUrl('/llms.txt')}, as plain text.\n`,
    ...Object.entries(guides).map(([id, guide]) => entry(guide.title, `/guides/${id}/`, guideFullText(guide))),
    ...Object.values(compareSources).map((source) => entry(source.title, source.path, source.markdown)),
    ...Object.entries(useCases).map(([id, useCase]) => entry(useCase.title, `/use-cases/${id}/`, useCaseFullText(useCase))),
  ].join('\n---\n\n');
};

export const generateSeoPages = async ({ outputDir = buildDir } = {}) => {
  const [template, translationText, useCaseText, guideText, faqText, legalText] = await Promise.all([
    readFile(resolve(outputDir, 'index.html'), 'utf8'),
    readFile(resolve(frontendDir, 'src/i18n/locales/en.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/use-cases.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/guides.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/landing-faq.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/legal.json'), 'utf8'),
  ]);
  const translations = JSON.parse(translationText);
  const useCases = JSON.parse(useCaseText);
  const guides = JSON.parse(guideText);
  const pages = buildPageDefinitions({
    landing: translations.landing, compare: translations.compare, useCases, guides, landingFaq: JSON.parse(faqText),
    legal: JSON.parse(legalText),
  });
  // Written from the Vite template before the homepage overwrites index.html.
  await writeFile(resolve(outputDir, 'app.html'), renderAppShell(template));

  await Promise.all(pages.map(async (page) => {
    const outputPath = resolve(outputDir, page.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderStaticPage(template, page));
  }));

  // lastmod only where a page carries a real dateModified (the guides). A build-time date on
  // every URL would tell Google everything changed on each deploy, and it learns to ignore that (F369).
  const sitemapEntry = (page) => `  <url><loc>${pageUrl(page.path)}</loc>${page.dateModified ? `<lastmod>${page.dateModified}</lastmod>` : ''}</url>`;
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.filter((page) => !page.noindex).map(sitemapEntry).join('\n')}\n</urlset>\n`;
  await writeFile(resolve(outputDir, 'sitemap.xml'), sitemap);

  const base = await readFile(resolve(frontendDir, 'public/llms.txt'), 'utf8');
  await writeFile(resolve(outputDir, 'llms.txt'), renderLlmsTxt({ base, guides, useCases, compareSources: comparePageSources, pages }));
  await writeFile(resolve(outputDir, 'llms-full.txt'), renderLlmsFullTxt({ guides, useCases, compareSources: comparePageSources }));
  // IndexNow's ownership proof: the key, alone, at /<key>.txt (F428).
  await writeFile(resolve(outputDir, indexNowKeyFile()), INDEXNOW_KEY);
  return pages;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateSeoPages().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
