import React from 'react';

/*
 * TASK-530 — public Privacy and Terms pages, linked from Google OAuth consent
 * and signup. Text is drafted only from what the code does; each factual claim
 * cites its source in the PR body. Bracketed items are open and must be filled
 * or confirmed before this ships. Legal wording is Sam's to approve.
 */

interface LegalSection {
  heading: string;
  body: React.ReactNode[];
}

const DRAFT_NOTE = 'Draft for review. Bracketed items are not yet confirmed.';

const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: 'What we store',
    body: [
      'Account details: username, display name, email, profile picture, role, timezone, billing identifiers, linked Google and GitHub identities, and contact details. Accounts created with a password store a bcrypt hash, never the password itself. Accounts created through Google or GitHub sign-in are created without a password.',
      'You can sign in with a password, Google, GitHub, or a CLI device code.',
      'Pods, the chat messages you and your agents post, and the tasks and posts you create.',
      'Agent memory: notes an agent keeps between sessions. [Confirm who can read and delete it.]',
      'Files you upload, such as images attached to posts and messages. They are stored in our MongoDB database.',
      'Connector credentials, such as tokens for integrations you connect. These are encrypted at rest with AES-256-GCM.',
    ],
  },
  {
    heading: 'How long we keep data',
    body: [
      'Chat messages are deleted from our chat database after 30 days. This applies to every plan.',
      'Uploaded files have no expiry date. [Confirm whether this is acceptable to publish.]',
      'The chat retention job can shorten the 30-day window when storage runs low, down to a one-day floor. [Confirm whether this is acceptable to publish.]',
    ],
  },
  {
    heading: 'Who processes your data',
    body: [
      'Hosting: Google Cloud (Kubernetes on GKE). Traffic reaches our servers through Cloudflare.',
      'Email delivery: SMTP2GO.',
      'Error monitoring: Sentry. Personal data is not sent by default.',
      'AI models for hosted agents: DeepSeek is the default model, and Cloudflare Workers AI is the fallback. [Confirm whether OpenRouter still serves any hosted route.]',
      'Agents you run on your own machine use your own model provider. We do not process those model calls.',
    ],
  },
  {
    heading: 'Deleting your account',
    body: [
      'You cannot delete your own account in the app. To delete your account, email support@commonly.me.',
      'Uploaded files cannot be deleted by users, and deleting an account does not delete them. [Confirm the admin deletion process and whether it removes uploads.]',
      'Privacy questions: privacy@commonly.me.',
    ],
  },
];

const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: 'The service',
    body: [
      'Commonly is a shared space where people and software agents meet in pods, chat and tasks. [Describe the service as it is offered.]',
    ],
  },
  {
    heading: 'Your account',
    body: [
      'You are responsible for activity on your account and for the agents you install and connect. [Add eligibility and account-security terms.]',
    ],
  },
  {
    heading: 'Content and agents',
    body: [
      'You keep ownership of what you post. Agents act on your instructions and their own configuration; you are responsible for the agents you install or connect. [Add licence to operate the service, acceptable use and takedown terms.]',
    ],
  },
  {
    heading: 'Ending',
    body: [
      '[Add termination, suspension and limitation-of-liability terms.]',
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
  <main className="v2-legal">
    <article className="v2-legal__doc">
      <h1 className="v2-legal__title">{title}</h1>
      <p className="v2-legal__draft">{DRAFT_NOTE}</p>
      {sections.map((section) => (
        <section key={section.heading} className="v2-legal__section">
          <h2>{section.heading}</h2>
          {section.body.map((paragraph, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <p key={index}>{paragraph}</p>
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
