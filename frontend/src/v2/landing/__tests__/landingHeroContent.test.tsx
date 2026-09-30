import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../../context/AuthContext';
import i18n from '../../../i18n';
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

/** Every text node under `root` that carries something a reader would see. */
const visibleTextNodes = (root: Element): Text[] => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if ((node.textContent ?? '').trim().length > 0) nodes.push(node);
  }
  return nodes;
};

/**
 * True when some ancestor of `node` below `root` is `aria-hidden`. The bound
 * matters: the hero h1 is deliberately NOT hidden (its `aria-label` is the
 * whole sentence), so an `aria-hidden` on the h1 itself would be a different
 * defect and must not satisfy the check.
 */
const hasHiddenAncestor = (node: Text, root: Element): boolean => {
  let el = node.parentElement;
  while (el && el !== root) {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    el = el.parentElement;
  }
  return false;
};

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

  it('renders the zh hero title suffix as its own element for the nowrap rule to bind to', async () => {
    // TASK-211. The hero sentence is 「与你的___对话」 in zh: the rotator supplies
    // the object and the suffix trails it, so the suffix is a word the reader
    // must see whole (it split across lines at 390 until v2-landing.css stopped
    // the break). The declaration is pinned in v2-layout-invariants.test.ts —
    // this is the other half: that pin only means anything while the suffix
    // still renders through `.v2-landing__title-suffix` inside the h1 it is
    // scoped to. Inline the suffix as bare text and the CSS would have nothing
    // to bind to while the pin stayed green.
    const zhSuffix = (((readLocale('zh-CN.json').landing as TranslationTree).hero as TranslationTree)
      .titleSuffix) as string;
    expect(zhSuffix.length).toBeGreaterThan(0);

    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      const zh = renderLanding();
      const node = zh.container.querySelector('.v2-landing__title-suffix');
      expect(node).not.toBeNull();
      expect(node?.textContent).toBe(zhSuffix);
      expect(node?.closest('h1.v2-landing__title')).not.toBeNull();
      zh.unmount();

      // en ships an empty suffix, so no span is rendered there and the rule is
      // zh-only by construction — this is the control that keeps the pin from
      // quietly becoming an English-hero assertion.
      await act(async () => { await i18n.changeLanguage('en'); });
      const en = renderLanding();
      expect(en.container.querySelector('.v2-landing__title-suffix')).toBeNull();
      en.unmount();
    } finally {
      // TASK-213: the language is the suite's ambient state, so the restore has
      // to survive a failure above it. Unguarded, a red assertion in here left
      // every later test rendering zh, and their English misses read as defects
      // in the page rather than in this test (found by sprint-review on #2033,
      // reproduced with a forced-failure probe).
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  it('leaves no fragment of the zh hero sentence exposed beside its aria-label', async () => {
    // TASK-215. The h1 states the sentence once, on `aria-label`
    // (V2LandingPage.tsx: "screen readers get one sentence, not fragments"),
    // and every fragment under it is supposed to be `aria-hidden`. The rotator
    // (line 122) and each staggered word are; the zh suffix span was not, so
    // the accessibility tree read the sentence AND a stray 「对话」 after it —
    // `heading "与你的 …, 以及整个团队对话。" [level=1]: 对话` — on main since
    // #717, on every renderer. This walks the h1 rather than naming the span,
    // so a NEW fragment added later has to declare its own aria-hidden instead
    // of inheriting the silence this arm is checking.
    const zhSuffix = (((readLocale('zh-CN.json').landing as TranslationTree).hero as TranslationTree)
      .titleSuffix) as string;
    expect(zhSuffix.length).toBeGreaterThan(0);

    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      const zh = renderLanding();
      const h1 = zh.container.querySelector('h1.v2-landing__title');
      expect(h1).not.toBeNull();
      // The premise the sweep rests on: the sentence is on the label and the
      // heading itself is announced, not hidden.
      expect(h1?.getAttribute('aria-label')).toBeTruthy();
      expect(h1?.getAttribute('aria-hidden')).toBeNull();

      const exposed = visibleTextNodes(h1 as Element)
        .filter((node) => !hasHiddenAncestor(node, h1 as Element))
        .map((node) => node.textContent);
      expect(exposed).toEqual([]);

      // Non-vacuity: the sweep has to be looking at a heading that really does
      // carry the visible fragments (the rotator stack renders every term), or
      // an empty h1 would pass it.
      expect(visibleTextNodes(h1 as Element).length).toBeGreaterThan(1);
      expect(zh.container.textContent).toContain(zhSuffix);
      zh.unmount();

      // en ships an empty suffix and the rotator is hidden there too, so the
      // control keeps this from becoming an en-shaped assertion.
      await act(async () => { await i18n.changeLanguage('en'); });
      const en = renderLanding();
      const enH1 = en.container.querySelector('h1.v2-landing__title');
      expect(
        visibleTextNodes(enH1 as Element).filter((node) => !hasHiddenAncestor(node, enH1 as Element)),
      ).toEqual([]);
      en.unmount();
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });
});
