import React from 'react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
// The sections live in content/legal.json so the build can prerender these
// pages for crawlers from the same words (F396).
import legal from '../../content/legal.json';

/*
 * TASK-530 — public Privacy and Terms pages, linked from Google OAuth consent
 * and signup. Every factual claim cites its source in the PR body. Legal
 * wording is approved before the gate.
 */

interface LegalSection {
  heading: string;
  body: string[];
}

// Turns each commonly.me address in a paragraph into a mailto link.
// String.split with a capture group puts the matches at odd indexes.
const EMAIL_PATTERN = /([a-z]+@commonly\.me)/;
const linkEmails = (text: string): React.ReactNode[] =>
  text.split(EMAIL_PATTERN).map((part, index) => (index % 2 === 1
    ? <a key={index} href={`mailto:${part}`}>{part}</a>
    : part));

const LegalDocument: React.FC<{
  title: string;
  titleKey: string;
  sections: LegalSection[];
}> = ({ title, titleKey, sections }) => {
  useDocumentTitle(titleKey);
  return (
    <main className="v2-root v2-legal">
      <article className="v2-legal__doc">
        <a className="v2-legal__home" href="/">Commonly</a>
        <h1 className="v2-legal__title">{title}</h1>
        {sections.map((section) => (
          <section key={section.heading} className="v2-legal__section">
            <h2>{section.heading}</h2>
            {section.body.map((paragraph, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <p key={index}>{linkEmails(paragraph)}</p>
            ))}
          </section>
        ))}
      </article>
    </main>
  );
};

export const V2PrivacyPage: React.FC = () => (
  <LegalDocument title="Privacy" titleKey="pageTitle.privacy" sections={legal.privacy as LegalSection[]} />
);

export const V2TermsPage: React.FC = () => (
  <LegalDocument title="Terms" titleKey="pageTitle.terms" sections={legal.terms as LegalSection[]} />
);
