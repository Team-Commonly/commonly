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

const LANDING_CSS = fs.readFileSync(path.join(__dirname, '..', 'v2-landing.css'), 'utf8');

/** The `landing.wedge.title` string a locale actually ships. */
const wedgeTitle = (fileName: string): string => (
  ((readLocale(fileName).landing as TranslationTree).wedge as TranslationTree).title
) as string;

const landingStrings = (value: string | TranslationTree): string[] => {
  if (typeof value === 'string') return [value];
  return Object.values(value).flatMap((child) => landingStrings(child));
};

/**
 * The declarations between a rule's braces in v2-landing.css. Throws rather
 * than returning empty, so a renamed selector is a red test instead of an
 * assertion over nothing.
 */
const cssRuleBody = (selector: string): string => {
  const start = LANDING_CSS.indexOf(selector);
  if (start === -1) throw new Error(`${selector} is no longer in v2-landing.css`);
  const open = LANDING_CSS.indexOf('{', start);
  return LANDING_CSS.slice(open + 1, LANDING_CSS.indexOf('}', open));
};

const cssDeclarations = (body: string): string[] => body
  .split(';')
  .map((decl) => decl.trim().replace(/\s+/g, ' '))
  .filter(Boolean);

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

  it('keeps the zh landing glossary free of Latin agent wording (TASK-231)', () => {
    const zhLanding = (readLocale('zh-CN.json').landing as TranslationTree);
    // payments-agent is a sample agent's handle in card three, so it stays Latin.
    const wording = (value: string) => value.replace(/payments-agent/g, '');
    expect(landingStrings(zhLanding).filter((value) => /agent/i.test(wording(value)))).toEqual([]);
  });

  it('makes multiplayer the h1, with the sentence that says what it means right under it', async () => {
    for (const [lang, locale, word] of [['en', 'en.json', /^Multiplayer for coding agents$/], ['zh-CN', 'zh-CN.json', /多人协作/]] as const) {
      const hero = (readLocale(locale).landing as TranslationTree).hero as TranslationTree;
      expect(String(hero.title)).toMatch(word);
      await act(async () => { await i18n.changeLanguage(lang); });
      try {
        const view = renderLanding();
        const h1 = view.container.querySelector('h1.v2-landing__title');
        expect(h1).toHaveAttribute('aria-label', String(hero.title));
        // The next thing after the h1 is the concrete sentence, readable as text.
        const bring = h1!.nextElementSibling;
        expect(bring).toHaveClass('v2-landing__bring');
        expect(bring!.querySelector('.v2-landing__wedge-sr')).toHaveTextContent(String(hero.ariaLabel));
        // The visible prefix runs into the term with a space in en and none in zh.
        const visible = bring!.querySelector('[aria-hidden="true"]')!.textContent ?? '';
        expect(visible.startsWith(lang === 'en' ? `${hero.titlePrefix} ` : `${hero.titlePrefix}${' '}`.trim())).toBe(true);
        if (lang === 'zh-CN') expect(visible.startsWith(`${hero.titlePrefix} `)).toBe(false);
        view.unmount();
      } finally {
        await act(async () => { await i18n.changeLanguage('en'); });
      }
    }
    expect(String(((readLocale('en.json').landing as TranslationTree).hero as TranslationTree).ariaLabel)).toMatch(/your Claude Code, your teammate's Codex/);
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

  it('exposes the wedge sentence as text, because a paragraph cannot carry a name', async () => {
    // TASK-216. `.v2-landing__wedge-line` is a `<p>`, and ARIA prohibits naming
    // role=paragraph — so `aria-label` is not a name this role may have, however
    // leniently a browser computes one. Measured in Chromium on live `9ac94e95`
    // (CDP `Accessibility.getPartialAXTree`, en and zh): the name IS computed,
    // from the attribute, so the row's "reads as nothing" is not what that
    // instrument shows. What is true, and is the defect: the name was the
    // sentence's ONLY exposure — every word under it is aria-hidden — which
    // makes the sentence's reach a property of the engine rather than of the
    // markup. It is CONTENT now, and this sweeps the line for text a reader
    // would get rather than naming the span, so a later re-shuffle of the line
    // has to keep exposing it.
    for (const [lang, locale] of [['en', 'en.json'], ['zh-CN', 'zh-CN.json']] as const) {
      const sentence = wedgeTitle(locale);
      expect(sentence.length).toBeGreaterThan(0);
      await act(async () => { await i18n.changeLanguage(lang); });
      try {
        const view = renderLanding();
        const line = view.container.querySelector('p.v2-landing__wedge-line');
        expect(line).not.toBeNull();
        // The premise, stated as an assertion: this role may not carry a name,
        // so an `aria-label` here is the defect this arm exists for.
        expect((line as Element).getAttribute('aria-label')).toBeNull();
        expect((line as Element).getAttribute('aria-hidden')).toBeNull();

        const nodes = visibleTextNodes(line as Element);
        const exposed = nodes.filter((node) => !hasHiddenAncestor(node, line as Element));
        expect(exposed.map((node) => (node.textContent ?? '').trim()).join(' ')).toContain(sentence);
        // The markup carries the class the rule is read by. Without this the
        // pair can drift by a rename: the sentence stays text (sweep green),
        // the rule stays clipped (sheet green), and a sighted reader gets the
        // line twice.
        expect((line as Element).querySelector('.v2-landing__wedge-sr')).not.toBeNull();

        // Non-vacuity: the line has to still hold the aria-hidden words, or a
        // paragraph that had no hidden fragment left would satisfy the
        // assertion above for a reason this arm is not about.
        expect(exposed.length).toBeGreaterThan(0);
        expect(nodes.length).toBeGreaterThan(exposed.length);
        view.unmount();
      } finally {
        await act(async () => { await i18n.changeLanguage('en'); });
      }
    }

    // The span is out of flow and clipped. jsdom has no layout engine, so a
    // sentence rendered visibly TWICE is invisible to every assertion above;
    // the declarations are read from the sheet instead, and the required set is
    // DERIVED from the family's existing member rather than restated here, so a
    // declaration the family grows is required of this copy too. The span is
    // looked up by the same class the rule is looked up by, which is what binds
    // the markup to the rule — a renamed class reds instead of rendering the
    // sentence in the open.
    const family = cssDeclarations(cssRuleBody('.v2-landing__install-status {'))
      .filter((decl) => !decl.startsWith('color:'));
    expect(family.length).toBeGreaterThan(0);
    const wedgeSr = cssDeclarations(cssRuleBody('.v2-landing__wedge-sr {'));
    expect(family.filter((decl) => !wedgeSr.includes(decl))).toEqual([]);
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
    // still renders through `.v2-landing__title-suffix` inside the sentence
    // under the h1. Inline the suffix as bare text and the CSS would have nothing
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
      expect(node?.closest('p.v2-landing__bring')).not.toBeNull();
      zh.unmount();

      // en option 1 ships its own suffix now ("into one pod."), so this control
      // checks that the English element carries the English sentence and not the
      // zh one. The zh pin above is what keeps the band rule about zh.
      const enSuffix = (((readLocale('en.json').landing as TranslationTree).hero as TranslationTree)
        .titleSuffix) as string;
      await act(async () => { await i18n.changeLanguage('en'); });
      const en = renderLanding();
      expect(en.container.querySelector('.v2-landing__title-suffix')?.textContent).toBe(enSuffix);
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

  it('leaves no fragment of the zh hero sentence exposed beside its readable copy', async () => {
    // TASK-215, moved with the sentence: it now sits under the h1 as a
    // paragraph, stated once in a clipped span, and every rotating or trailing
    // fragment beside it must be aria-hidden, or the tree reads the sentence
    // AND a stray 「带进同一个 Pod。」 after it. This walks the line rather than
    // naming spans, so a new fragment has to declare its own aria-hidden.
    const zhHero = (readLocale('zh-CN.json').landing as TranslationTree).hero as TranslationTree;
    expect(String(zhHero.titleSuffix).length).toBeGreaterThan(0);
    for (const lang of ['zh-CN', 'en'] as const) {
      await act(async () => { await i18n.changeLanguage(lang); });
      try {
        const view = renderLanding();
        const line = view.container.querySelector('p.v2-landing__bring');
        expect(line).not.toBeNull();
        expect(line!.getAttribute('aria-label')).toBeNull();
        const sr = line!.querySelector('.v2-landing__wedge-sr') as Element;
        const exposed = visibleTextNodes(line as Element)
          .filter((node) => !hasHiddenAncestor(node, line as Element) && !sr.contains(node))
          .map((node) => node.textContent);
        expect(exposed).toEqual([]);
        // Non-vacuity: the decoration is really there beside the readable copy.
        expect(visibleTextNodes(line as Element).length).toBeGreaterThan(2);
        // And the h1's own words are decoration under its label.
        const h1 = view.container.querySelector('h1.v2-landing__title') as Element;
        expect(visibleTextNodes(h1).filter((node) => !hasHiddenAncestor(node, h1))).toEqual([]);
        view.unmount();
      } finally {
        await act(async () => { await i18n.changeLanguage('en'); });
      }
    }
  });
});
