import fs from 'fs';
import path from 'path';

/**
 * The statically checkable AI-slop tells, over EVERY v2 stylesheet and
 * every v2 source file. The list and its reasons live in
 * docs/design/ai-slop-tells.md; each test here names its tell by number.
 *
 * Files are found by walking `frontend/src/v2`, never by a hand list: the card
 * rail guard in v2-layout-invariants reads v2.css and the chat sheets only, and
 * on 2026-11-03 an accent rail sat in a sheet outside that list
 * (`agents/v2-persona-catalog.css`, dead CSS, since deleted). A sheet must not
 * be able to leave a guard by moving.
 *
 * Exceptions are named per file and per selector. Each allowlist is exact: a
 * new violation fails, and an entry that no longer violates fails too, so the
 * list cannot outlive what it excuses.
 */

const V2_ROOT = path.join(__dirname, '..');

const walk = (dir: string, keep: (name: string) => boolean): string[] => fs
  .readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === '__testkit__' ? [] : walk(full, keep);
    return keep(entry.name) ? [full] : [];
  })
  .sort();

const rel = (file: string): string => path.relative(V2_ROOT, file).split(path.sep).join('/');

const SHEETS = walk(V2_ROOT, (name) => name.endsWith('.css'));
const SOURCES = walk(V2_ROOT, (name) => /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name));

type Rule = { file: string; selector: string; body: string };

// Flat rules, comments stripped. An at-rule's prelude never matches (the
// pattern excludes '@'), so a rule inside @media is keyed to its own selector.
const rulesOf = (file: string): Rule[] => {
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].map((m) => ({
    file: rel(file),
    selector: m[1].trim().replace(/\s+/g, ' '),
    body: m[2],
  }));
};

const RULES: Rule[] = SHEETS.flatMap(rulesOf);

const key = (rule: Rule): string => `${rule.file} :: ${rule.selector}`;

const exact = (found: string[], allowed: string[]) => {
  const live = [...new Set(found)].sort();
  expect(live.filter((entry) => !allowed.includes(entry))).toEqual([]);
  expect(allowed.filter((entry) => !live.includes(entry))).toEqual([]);
};

// A colour is "chromatic" when its channels spread by more than 40 of 255 —
// the neutrals (#101828, rgba(15,23,42,…), white, black) all sit well under.
const chromatic = (colour: string): boolean => {
  if (/var\(--v2-(accent|status|prio|danger|success|warning|info)/.test(colour)) return true;
  let rgb: number[] | null = null;
  const fn = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(colour);
  if (fn) rgb = fn.slice(1, 4).map(Number);
  const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(colour);
  if (!rgb && hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  return !!rgb && Math.max(...rgb) - Math.min(...rgb) > 40;
};

const hsl = (hex: string): { hue: number; chroma: number } => {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return { hue: 0, chroma: 0 };
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, chroma: d };
};

// Arrows, ticks, crosses, chevrons, stars, sparkles, pencils, bullets, and any
// pictographic emoji. × and ✕ count: an icon-only close button must be an SVG.
const GLYPH = /[\u00D7\u2039\u203A\u2190-\u21FF\u2605\u2606\u2713-\u2718\u270E\u2728\u2B50]|\p{Extended_Pictographic}/u;
const GLYPH_OR_BULLET = new RegExp(`${GLYPH.source}|\u2022`, 'u');

describe('AI-slop tells (docs/design/ai-slop-tells.md)', () => {
  test('the walk finds the whole tree, not a hand list', () => {
    // A changed root or a broken walk yields a vacuous pass.
    expect(SHEETS.length).toBeGreaterThanOrEqual(25);
    expect(SHEETS.map(rel)).toEqual(expect.arrayContaining(['v2.css', 'agents/v2-agent-profile.css', 'connectors/connectors.css', 'landing/v2-landing.css', 'primitives/primitives.css']));
    expect(RULES.length).toBeGreaterThan(2000);
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  test('tell 1: no coloured rail down one side of anything', () => {
    // Quote rails are typographic and neutral (--v2-border*), so they pass on
    // colour, not by name. A focus treatment is not a resting rail.
    const offenders: string[] = [];
    for (const rule of RULES) {
      if (/:focus/.test(rule.selector)) continue;
      const side = /border-(?:left|inline-start)(?:-width)?:\s*(\d+(?:\.\d+)?)px([^;]*)/.exec(rule.body);
      const sideColour = /border-(?:left|inline-start)-color:\s*([^;]*)/.exec(rule.body)?.[1] ?? side?.[2] ?? '';
      const neutral = /transparent|none|var\(--v2-(border|divider|hairline)/.test(sideColour);
      if (side && Number(side[1]) >= 2 && !neutral) offenders.push(key(rule));
      const inset = /box-shadow:[^;]*\binset\s+-?[1-9]\d*(?:\.\d+)?px\s+0(?:px)?\s+0(?:px)?\s+([^,;]*)/.exec(rule.body);
      if (inset && chromatic(inset[1])) offenders.push(key(rule));
    }
    expect(offenders).toEqual([]);
  });

  test('tell 2: no gradient text', () => {
    const offenders = RULES
      .filter((rule) => /(?:-webkit-)?background-clip:\s*text|text-fill-color:\s*transparent/.test(rule.body))
      .map(key);
    expect(offenders).toEqual([]);
  });

  test('tell 3: no frosted glass; backdrop blur lives only on the marketing header', () => {
    exact(
      RULES.filter((rule) => /backdrop-filter:\s*(?!\s|none)/.test(rule.body)).map(key),
      ['landing/v2-landing.css :: .v2-landing__bar'],
    );
  });

  test('tell 4: no decorative gradients — keys use their own a/b pair, and the rest are named', () => {
    // D215 (TASK-730) draws keys as a two-stop gradient of ONE token family
    // (--v2-fill-*, --v2-key-*, --v2-accent-fill-*). Anything else is a mask
    // fade, a range track or a hatch, and is listed by name.
    const keyPair = /linear-gradient\(\s*180deg\s*,\s*var\(--([\w-]*?)-a\b[^)]*\)\)?\s*,\s*var\(--\1-b\b/;
    const found: string[] = [];
    for (const rule of RULES) {
      for (const m of rule.body.matchAll(/(?:repeating-)?(?:linear|radial|conic)-gradient\(/g)) {
        const rest = rule.body.slice(m.index);
        if (/^linear/.test(m[0]) && keyPair.test(rest)) continue;
        found.push(key(rule));
      }
    }
    exact(found, [
      'cards/uiCard.css :: .v2-ui-card .bar span.r', // hatch on a "remaining" bar segment
      'chat/chat-message.css :: .v2-msg__prose--closed', // mask fade over a clamped message
      'components/V2SettingsPage.css :: .v2-root .v2-settings__avatar-zoom input[type="range"]::-webkit-slider-runnable-track', // range fill
      'landing/v2-landing.css :: .v2-landing__trusted-marquee', // marquee edge mask (marketing)
    ]);
    // Radial and conic gradients are the blob / aurora tell; there are none.
    expect(RULES.filter((rule) => /(?:radial|conic)-gradient\(/.test(rule.body)).map(key)).toEqual([]);
  });

  test('tell 5: no coloured glow; the two cobalt key shadows are the drawn ones', () => {
    // A layer is a glow when it is outside the box, blurred past 2px, and
    // chromatic. Focus halos have no blur and are not counted.
    const found: string[] = [];
    for (const rule of RULES) {
      const decls = [...rule.body.matchAll(/(?:box-shadow|--[\w-]*shadow[\w-]*):\s*([^;]*)/g)].map((m) => m[1]);
      for (const decl of decls) {
        for (const layer of decl.split(/,(?![^(]*\))/)) {
          if (/\binset\b/.test(layer)) continue;
          const lengths = layer.replace(/\([^)]*\)/g, '').match(/-?\d*\.?\d+(?:px)?/g) || [];
          const blur = Number.parseFloat(lengths[2] ?? '0');
          if (blur > 2 && chromatic(layer)) found.push(key(rule));
        }
      }
    }
    exact(found, [
      'primitives/primitives.css :: .v2p-b-c', // d215 .b-c, the cobalt key's contact shadow
      'v2.css :: .v2-rail__brand-icon', // d215 .logo, the cobalt brand key
    ]);
  });

  test('tell 6: no emoji or unicode glyph icons in product copy', () => {
    // Keyboard notation and the two reply-aim / pair marks are typography, not icons.
    const ALLOWED: Record<string, string> = {
      'activity.compose.hint': '⌘↵',
      'podChat.composer.aimThread': '↳',
      'podChat.composer.aimReply': '↳',
      'inspector.detail.openDm': '↔',
      // 2026-11-03: Activity belongs to its redesign owner; the ✓ prefix is a
      // proposal there (docs/design/ai-slop-tells.md), not a fix here.
      'activity.decision.ruled': '✓',
    };
    const offenders: string[] = [];
    for (const locale of ['en', 'zh-CN']) {
      const json = JSON.parse(fs.readFileSync(path.join(V2_ROOT, '..', 'i18n', 'locales', `${locale}.json`), 'utf8'));
      const visit = (node: unknown, at: string) => {
        if (typeof node === 'string') {
          // ©, ® and ™ are Extended_Pictographic in Unicode, and typography in copy.
          const stripped = [...(ALLOWED[at] || ''), '©', '®', '™'].reduce((s, ch) => s.split(ch).join(''), node);
          if (GLYPH.test(stripped)) offenders.push(`${locale}:${at} = ${node}`);
        } else if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) visit(v, at ? `${at}.${k}` : k);
        }
      };
      visit(json, '');
    }
    expect(offenders).toEqual([]);
  });

  test('tell 6: no emoji or unicode glyph icons in v2 source outside the named exceptions', () => {
    // Keyed by file AND the exact line, so an exception excuses one literal,
    // never the rest of its file.
    const ALLOWED: Record<string, string[]> = {
      // the reaction picker: user content, README carve-out
      'components/V2MessageActions.tsx': ["const REACTION_PALETTE = ['👍', '❤️', '🔥', '🤔', '👀', '🚀'];"],
      // parses the kernel's "🤝 … started a DM" event
      'components/V2MessageRow.tsx': ['const AGENT_DM_EVENT_RE = /^🤝\\s+(.+?)\\s+—\\s+\\[view\\]\\(\\/v2\\/pods\\/([a-f0-9]{24})\\)\\s*$/i;'],
      // the masked token's bullets
      'components/V2SettingsPage.tsx': ["const maskedToken = '••••••••••••••••••••••••••••••••';"],
      // ↵ key hint in the marketing demo composer
      'landing/DemoWorkspace.tsx': ['<span className="v2-demo__enter" aria-hidden="true">↵</span>'],
    };
    const found: string[] = [];
    for (const file of SOURCES) {
      // A block comment opens at a line start, after whitespace or after `{`
      // (JSX). Anchoring it matters: an unanchored /\*…\*/ treats the `/*` in
      // a string such as accept="image/*" as an opener and swallows real code
      // up to the next `*/` (it hid a × in V2Composer).
      const code = fs.readFileSync(file, 'utf8')
        .replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, '$1')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const line of code.split('\n')) {
        if (GLYPH_OR_BULLET.test(line)) found.push(`${rel(file)} :: ${line.trim()}`);
      }
    }
    exact(found, Object.entries(ALLOWED).flatMap(([file, lines]) => lines.map((line) => `${file} :: ${line}`)));
  });

  test('tell 7: no sparkle "AI" icon', () => {
    const offenders = SOURCES
      .filter((file) => /AutoAwesome|AutoFixHigh|Sparkles?\b|✨/.test(fs.readFileSync(file, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  test('tell 8: no purple or indigo outside the named tokens', () => {
    const found: string[] = [];
    for (const rule of RULES) {
      for (const m of rule.body.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
        // Chroma, not saturation: a near-white lavender tint is not an accent.
        const { hue, chroma } = hsl(m[0]);
        if (hue >= 245 && hue <= 320 && chroma > 0.2) found.push(`${key(rule)} ${m[0].toLowerCase()}`);
      }
    }
    exact(found, [
      'chat/chat-states.css :: .v2-prcard__state--merged #6f42c1', // GitHub's merged state, a semantic colour
      'v2.css :: .v2-root #611f69', // Slack's brand aubergine, a connector mark token
      'v2.css :: .v2-root #a78bfa', // --v2-violet, an avatar role tint (README: never chrome)
    ]);
  });

  test('tell 9: uppercase tracked labels are a short, named list', () => {
    // README: UPPERCASE eyebrows sparingly, for kickers and badges. A new one
    // is a decision, so it lands here by name.
    exact(
      RULES.filter((rule) => /text-transform:\s*uppercase/.test(rule.body)).map(key),
      [
        'agents/v2-agent-profile.css :: .v2-aprofile .v2-aprofile__runtime',
        'chat/chat-message.css :: .v2-msg__chip-ext',
        'chat/chat-message.css :: .v2-msg__lead-badge',
        'chat/chat-states.css :: .v2-approval__badge',
        'chat/chat-states.css :: .v2-byo-handoff__badge',
        'chat/chat-states.css :: .v2-prcard__state',
        'components/V2SettingsPage.css :: .v2-settings__avatar-zoom',
        'components/V2YourTeamPage.css :: .v2-team .v2-team-card__mark',
        'landing/v2-landing.css :: .v2-landing__eyebrow',
        'landing/v2-landing.css :: .v2-landing__faq-item dt::first-letter',
        'landing/v2-landing.css :: .v2-landing__footer-title',
        'landing/v2-landing.css :: .v2-landing__kicker',
        'landing/v2-landing.css :: .v2-landing__tier-name',
        'landing/v2-landing.css :: .v2-landing__trusted-label',
        'v2.css :: .v2-admin-analytics__chart-title',
        'v2.css :: .v2-admin-users__table th',
        'v2.css :: .v2-avatar',
      ],
    );
  });

  test('tell 10: no radius past the 16px pop surface, except pills', () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      for (const m of rule.body.matchAll(/border-radius:\s*([^;]*)/g)) {
        const big = (m[1].match(/\d+(?:\.\d+)?px/g) || []).map(Number.parseFloat).some((px) => px > 16 && px < 999);
        if (big) offenders.push(key(rule));
      }
    }
    expect(offenders).toEqual([]);
  });
});
