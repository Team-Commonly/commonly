import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../../context/AuthContext';
import V2LandingPage from '../V2LandingPage';

// TASK-152. Two user-visible strings on the landing hero were wrong in
// different directions, and both were wrong in a way that no render test would
// have caught on its own: the rotator still advertised OpenClaw after the wash
// removed it everywhere else, and the install one-liner skipped the directory
// change and the setup step the README documents, so anyone who pasted it got a
// bare clone and no started stack. The guards below DERIVE both values from the
// artifact they must agree with (the locale files, and the README) rather than
// restating them here — a restated list would go stale in exactly the way the
// strings did.

jest.mock('axios');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;

const LANDING_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'V2LandingPage.tsx'), 'utf8');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const TERM_KEY_PREFIX = 'landing.hero.terms.';

type TranslationTree = { [key: string]: string | TranslationTree };

const readLocale = (fileName: string): TranslationTree => JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'i18n', 'locales', fileName), 'utf8'),
);

/** The `landing.hero.terms.*` keys a locale actually ships. */
const localeTermKeys = (fileName: string): string[] => {
  const terms = (readLocale(fileName).landing as TranslationTree).hero as TranslationTree;
  return Object.keys(terms.terms as TranslationTree).map((key) => `${TERM_KEY_PREFIX}${key}`);
};

const localeTermValues = (fileName: string): string[] => {
  const terms = (readLocale(fileName).landing as TranslationTree).hero as TranslationTree;
  return Object.values(terms.terms as TranslationTree) as string[];
};

/** The `landing.hero.terms.*` keys the component asks the translator for. */
const referencedTermKeys = (): string[] => {
  const pattern = new RegExp(`t\\('(${TERM_KEY_PREFIX}[A-Za-z]+)'\\)`, 'g');
  return [...LANDING_SOURCE.matchAll(pattern)].map((match) => match[1]);
};

const selfHostCommand = (): string => {
  const match = /const SELF_HOST_COMMAND = '([^']+)'/.exec(LANDING_SOURCE);
  if (!match) throw new Error('SELF_HOST_COMMAND is no longer a single-quoted literal in V2LandingPage.tsx');
  return match[1];
};

/** The README's Quick Start block, one command per line, joined into the one-liner. */
const readmeQuickStartCommand = (): string => {
  const block = /## Quick Start[^\n]*\n[\s\S]*?```bash\n([\s\S]*?)```/.exec(README);
  if (!block) throw new Error('README.md no longer has a bash block under a "## Quick Start" heading');
  return block[1]
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter(Boolean)
    .join(' && ');
};

const renderLanding = () => render(
  <MemoryRouter>
    <V2LandingPage />
  </MemoryRouter>,
);

describe('V2LandingPage hero content (TASK-152)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ isAuthenticated: false });
    mockAxiosGet.mockResolvedValue({ data: { agentCount: 262, messageCount24h: 1234 } });
  });

  it('references exactly the rotator terms the locale files ship, in both languages', () => {
    const referenced = [...referencedTermKeys()].sort();

    // A term that exists in a locale but is never referenced is dead copy (this
    // is what OpenClaw became after the wash); a reference with no key renders
    // the raw key string at the visitor.
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced).toEqual([...localeTermKeys('en.json')].sort());
    expect(referenced).toEqual([...localeTermKeys('zh-CN.json')].sort());
  });

  it('does not put OpenClaw anywhere in the rendered hero', () => {
    renderLanding();

    // Every term is in the DOM, not just the active one: the rotator renders
    // the full stack (V2LandingPage.tsx, .v2-landing__rotator-stack) and only
    // the sizer follows the active index, so this assertion does not depend on
    // where in the cycle the term sits.
    expect(screen.queryByText('OpenClaw')).toBeNull();
    for (const term of localeTermValues('en.json')) {
      expect(screen.getAllByText(term).length).toBeGreaterThan(0);
    }
  });

  it('renders the self-host one-liner identical to the README quick start', () => {
    const command = selfHostCommand();
    renderLanding();

    expect(screen.getByText(command)).toBeInTheDocument();
    // The README is the published instruction; the hero is the shortcut. If
    // they diverge, the shortcut is the one that is wrong.
    expect(command).toBe(readmeQuickStartCommand());
    expect(command).toContain('cd commonly');
    expect(command).toContain('./install.sh');
  });
});
