import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import guides from '../../content/guides.json';
import { ForwardArrow, GuideTop, useGuideCanvas } from './guideShell';

interface GuideStrongParagraph {
  strong: string;
}

type GuideParagraph = string | GuideStrongParagraph;

interface GuideSection {
  title: string;
  paragraphs?: GuideParagraph[];
  bullets?: string[];
  orderedItems?: string[];
  codeBlocks?: Array<{
    language?: string;
    code: string;
  }>;
  tables?: Array<{
    headers: string[];
    rows: string[][];
  }>;
  links?: GuideLink[];
}

interface GuideFaq {
  question: string;
  answer: string;
}

interface GuideLink {
  label: string;
  path: string;
  external?: boolean;
}

interface GuideProvenance {
  author: string;
  reviewer: string;
  datePublished: string;
  dateModified: string;
}

interface Guide {
  eyebrow: string;
  title: string;
  description: string;
  provenance: GuideProvenance;
  /** set together with `answer` when a guide's pass lands. */
  revised?: string;
  answer?: string;
  intro: string[];
  sections: GuideSection[];
  faq: GuideFaq[];
  relatedLinks: GuideLink[];
  cta: {
    title: string;
    body: string;
    primary: GuideLink;
    secondary: GuideLink;
  };
}

const GUIDES = guides as Record<string, Guide>;

// Mirrors the static page (scripts/generate-seo-pages.mjs, renderGuideProvenance):
// a guide with `revised` names Sam as its author and shows `revised` as its Updated date.
export const GUIDE_AUTHOR = { name: 'Sam Xu', url: 'https://x.com/sam_commonly' };

const formatGuideDate = (value: string) => new Intl.DateTimeFormat('en-US', {
  dateStyle: 'long',
  timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`));

const GuidePage: React.FC = () => {
  const { guideId } = useParams<{ guideId: string }>();
  const navigate = useNavigate();
  const guide = guideId ? GUIDES[guideId] : undefined;

  useGuideCanvas();

  if (!guide) {
    return (
      <div className="guide-page guide-page--missing">
        <div className="guide-container">
          <GuideTop onBack={() => navigate('/')} />
          <h1 className="guide-missing-title">Guide not found</h1>
          <p className="guide-lede">This guide does not exist yet. Return to the landing page to explore Commonly.</p>
        </div>
      </div>
    );
  }
  const modified = guide.revised || guide.provenance.dateModified;

  return (
    <div className="guide-page">
      <div className="guide-container">
        <GuideTop onBack={() => navigate('/')} />

        <p className="guide-eyebrow">{guide.eyebrow.toUpperCase()}</p>
        <h1 className="guide-title">{guide.title}</h1>
        <p className="guide-lede">{guide.description}</p>
        <p className="guide-byline">
          By {guide.revised
            ? <a href={GUIDE_AUTHOR.url} rel="author">{GUIDE_AUTHOR.name}</a>
            : guide.provenance.author} · Reviewed by {guide.provenance.reviewer}
          <br />
          {guide.provenance.datePublished === modified
            ? `Published and updated ${formatGuideDate(guide.provenance.datePublished)}`
            : `Published ${formatGuideDate(guide.provenance.datePublished)} · Updated ${formatGuideDate(modified)}`}
        </p>

        {guide.answer && (
          <p className="guide-answer"><strong>Short answer.</strong> {guide.answer}</p>
        )}

        <div className="guide-prose guide-prose--intro">
          {guide.intro.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </div>

        <div className="guide-sections">
          {guide.sections.map((section) => (
            <section key={section.title}>
              <h2 className="guide-h2">{section.title}</h2>
              <div className="guide-prose">
                {section.paragraphs?.map((paragraph) => (
                  <p key={typeof paragraph === 'string' ? paragraph : paragraph.strong}>
                    {typeof paragraph === 'string' ? paragraph : <strong>{paragraph.strong}</strong>}
                  </p>
                ))}
              </div>
              {section.bullets && (
                <ul className="guide-list">{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul>
              )}
              {section.orderedItems && (
                <ol className="guide-list">{section.orderedItems.map((item) => <li key={item}>{item}</li>)}</ol>
              )}
              {section.tables?.map((table) => (
                <div className="guide-table-wrap" key={table.headers.join('|')}>
                  <table className="guide-table">
                    <thead>
                      <tr>{table.headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr>
                    </thead>
                    <tbody>
                      {table.rows.map((row) => <tr key={row.join('|')}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}
                    </tbody>
                  </table>
                </div>
              ))}
              {section.codeBlocks?.map((block) => (
                <pre className="guide-code" key={block.code}>
                  <code className={block.language ? `language-${block.language}` : undefined}>{block.code}</code>
                </pre>
              ))}
              {section.links && (
                <div className="guide-actions">
                  {section.links.map((link) => (
                    <a
                      key={link.path}
                      className="guide-btn"
                      href={link.path}
                      target={link.external ? '_blank' : undefined}
                      rel={link.external ? 'noreferrer' : undefined}
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>

        <hr className="guide-rule" />

        {guide.faq.length > 0 && (
          <section>
            <h2 className="guide-h2">Frequently asked questions</h2>
            <div className="guide-cards">
              {guide.faq.map((item) => (
                <div className="guide-card" key={item.question}>
                  <h3 className="guide-h3">{item.question}</h3>
                  <p>{item.answer}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="guide-cta">
          <h2 className="guide-h2">{guide.cta.title}</h2>
          <p>{guide.cta.body}</p>
          <div className="guide-actions">
            <button type="button" className="guide-btn guide-btn--filled" onClick={() => navigate(guide.cta.primary.path)}>
              {guide.cta.primary.label}
              <ForwardArrow />
            </button>
            <button type="button" className="guide-btn guide-btn--outlined" onClick={() => navigate(guide.cta.secondary.path)}>
              {guide.cta.secondary.label}
            </button>
          </div>
        </section>

        <div className="guide-actions guide-related">
          {guide.relatedLinks.map((link) => (
            <button type="button" key={link.path} className="guide-btn" onClick={() => navigate(link.path)}>{link.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default GuidePage;
