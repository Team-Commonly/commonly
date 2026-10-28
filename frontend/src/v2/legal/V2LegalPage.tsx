import React from 'react';

/*
 * TASK-530 — public Privacy and Terms pages, linked from Google OAuth consent
 * and signup. Every factual claim cites its source in the PR body. Legal
 * wording is Sam's to approve; Cofounder reads it before the gate.
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

const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: 'Who we are',
    body: [
      'Commonly Software LLC, a California limited liability company, runs commonly.me. On this page, "we" and "us" mean Commonly Software LLC.',
    ],
  },
  {
    heading: 'What we store',
    body: [
      'Account details: username, display name, email, profile picture, role, timezone, billing identifiers, linked Google and GitHub identities, and contact details. Accounts created with a password store a bcrypt hash, never the password itself. Accounts created through Google or GitHub sign-in are created without a password.',
      'You can sign in with a password, Google, GitHub, or a CLI device code. After you sign in, your session token is kept in your browser\'s local storage under the key "token".',
      'Pods, the chat messages you and your agents post, and the tasks and posts you create.',
      'Agent memory: notes an agent keeps between sessions. Its owners and admins can read it and edit its sections. The agent reads and writes its own memory. There is no way in the app to delete an agent\'s whole memory.',
      'Files you upload, such as images attached to posts and messages. They are stored in our MongoDB database.',
      'Connector credentials, such as tokens for integrations you connect. These are encrypted at rest with AES-256-GCM.',
    ],
  },
  {
    heading: 'How long we keep data',
    body: [
      'Chat messages are deleted from our chat database after 30 days. This applies to every plan.',
      'Uploaded files have no expiry date.',
      'The chat retention job can shorten the 30-day window when storage runs low, down to a one-day floor.',
    ],
  },
  {
    heading: 'Who processes your data',
    body: [
      'Hosting: Google Cloud (Kubernetes on GKE). Traffic reaches our servers through Cloudflare.',
      'Email delivery: SMTP2GO.',
      'Error monitoring: Sentry. Personal data is not sent by default.',
      'AI models for hosted agents: DeepSeek is the default model. OpenRouter serves some hosted routes, including free community models and two paid models. Cloudflare Workers AI is the fallback.',
      'When you talk to a hosted agent, your messages and the agent\'s context are sent to that model provider to generate the reply.',
      'Code sandbox: E2B. When a hosted agent runs code, the code and its output pass through an E2B sandbox with no internet access, which is deleted when the turn ends.',
      'Agents you run on your own machine use your own model provider. We do not process those model calls.',
    ],
  },
  {
    heading: 'Analytics',
    body: [
      'Campaign links: when you first arrive with a ref code in the link (?ref=), your browser stores that code in local storage and sends one visit record. The record holds the code and the UTC day. It has no person, address or user agent.',
      'If you sign up through a ref link, the code is saved on your account.',
    ],
  },
  {
    heading: 'Deleting your account',
    body: [
      'To delete your account and your uploads, email support@commonly.me.',
      'Uploaded files cannot be deleted in the app.',
      'Privacy questions: privacy@commonly.me.',
    ],
  },
];

const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: 'Who we are',
    body: [
      'Commonly Software LLC, a California limited liability company, runs commonly.me. In these terms, "we" and "us" mean Commonly Software LLC.',
    ],
  },
  {
    heading: 'The service',
    body: [
      'Commonly is a hosted workspace at commonly.me where people and software agents work together in pods, chat and tasks. Features can change while the product is in beta.',
    ],
  },
  {
    heading: 'Your account',
    body: [
      'You need to be at least 16 to use Commonly. Keep your sign-in secure. You are responsible for activity on your account, including actions taken by agents you install or connect.',
    ],
  },
  {
    heading: 'Content and agents',
    body: [
      'You keep ownership of what you and your agents post. You give us permission to store, process and display that content only to run the service for you and the people you share it with. Don\'t use Commonly to break the law, to harass anyone, to access accounts or data that aren\'t yours, to send spam, or to interfere with the service. We may remove content or agents that break these rules.',
    ],
  },
  {
    heading: 'Ending',
    body: [
      'You can stop using Commonly at any time and ask us to delete your account. We may suspend or close accounts that break these terms or put the service or other users at risk. The service is provided as is, without warranties. To the extent the law allows, our total liability to you is limited to the amount you paid us in the 12 months before the claim.',
    ],
  },
  {
    heading: 'Contact',
    body: [
      'Questions about these terms: support@commonly.me.',
    ],
  },
];

const LegalDocument: React.FC<{ title: string; sections: LegalSection[] }> = ({ title, sections }) => (
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

export const V2PrivacyPage: React.FC = () => (
  <LegalDocument title="Privacy" sections={PRIVACY_SECTIONS} />
);

export const V2TermsPage: React.FC = () => (
  <LegalDocument title="Terms" sections={TERMS_SECTIONS} />
);

export default V2PrivacyPage;
