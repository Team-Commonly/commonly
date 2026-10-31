import fs from 'fs';
import path from 'path';
import { guidePalette, guideTextButtonSx } from '../../components/landing/guideShell';

const frontend = path.resolve(__dirname, '../../..');
const read = (name: string) => fs.readFileSync(path.join(frontend, name), 'utf8');
const retiredAccent = /#2f6feb|rgba?\(\s*47\s*,\s*111\s*,\s*235/i;

// These standalone assets and legacy bridges cannot all inherit .v2-root.
// Historical preview cards and stable avatar colors are outside this sweep.
describe('Signal accent on standalone and bridged surfaces', () => {
  test('the standalone favicon paints all four mark shapes cobalt', () => {
    const svg = new DOMParser().parseFromString(read('public/favicon.svg'), 'image/svg+xml');
    expect(svg.querySelector('parsererror')).toBeNull();
    const shapes = Array.from(svg.querySelectorAll('path, circle'));
    expect(shapes).toHaveLength(4);
    shapes.forEach((shape) => {
      expect(shape.getAttribute(shape.tagName === 'path' ? 'stroke' : 'fill')).toBe('#1d3fd1');
    });
  });

  // Structural source guard: these fixtures prove the absence check can detect old colors.
  test.each(['color: #2F6FEB;', 'color: rgb(47, 111, 235);', 'background: rgba(47,111,235,.2);'])(
    'the structural retired-accent guard detects %s', (fixture) => {
      expect(fixture).toMatch(retiredAccent);
    },
  );

  test.each([
    'index.html',
    'public/favicon.svg',
    'src/components/landing/guideShell.ts',
    'src/v2/components/V2FeaturePage.tsx',
    'src/v2/components/V2CliAuthorize.css',
    'src/v2/v2.css',
    'design-system/tokens.css',
  ])('%s excludes the retired accent and its RGB channels', (name) => {
    const source = read(name);
    expect(source).not.toMatch(retiredAccent);
  });

  test('the static shell uses Signal for browser chrome and SEO accent states', () => {
    const html = read('index.html');
    expect(html).toContain('<meta name="theme-color" content="#1d3fd1" />');
    const expected = [
      ['a', 'color', '#1d3fd1'], ['a:hover', 'color', '#0f2378'],
      ['.seo-kicker', 'color', '#1d3fd1'], ['.seo-primary', 'background', '#1d3fd1'],
      ['.seo-primary:hover', 'background', '#1633a8'],
      ['.seo-band', 'color', '#0f2378'], ['.seo-band', 'background', '#e9edfb'],
    ];
    expected.forEach(([selector, property, value]) => {
      const rule = html.split(`#seo-page ${selector} {`)[1]?.split('}')[0];
      expect(rule).toContain(`${property}: ${value};`);
    });
  });

  test.each([
    ['src/components/landing/guideShell.ts', /accent:\s*'#1d3fd1'/],
    ['src/v2/components/V2FeaturePage.tsx', /accent:\s*'#1d3fd1'/],
    ['design-system/tokens.css', /::selection\s*\{\s*background:\s*rgba\(29, 63, 209, 0\.20\)/],
    ['src/v2/v2.css', /\.v2-activity__compose:focus-within\s*\{\s*box-shadow: 0 0 0 4px rgba\(29, 63, 209, 0\.10\)/],
  ])('%s retains its intended cobalt accent', (name, expected) => {
    expect(read(name as string)).toMatch(expected as RegExp);
  });

  test.each([
    ['src/components/landing/guideShell.ts', ['accentStrong', 'accentSoft', 'accentText', 'accentDeep']],
    ['src/v2/components/V2FeaturePage.tsx', ['accentStrong', 'accentSoft']],
  ])('%s uses Signal accent variants', (name, keys) => {
    const source = read(name as string);
    const expected: Record<string, string> = {
      accentStrong: '#1633a8', accentSoft: '#e9edfb', accentText: '#1d3fd1', accentDeep: '#0f2378',
    };
    (keys as string[]).forEach((key) => {
      expect(source).toContain(`${key}: '${expected[key]}'`);
    });
  });

  test('guide buttons are excluded from the legacy blue reset in every interaction state', () => {
    const css = read('src/App.css');
    ['', ':hover', ':active'].forEach((state) => {
      expect(css).toContain(`body.modern-ui:not(.v2-canvas):not(.guide-canvas) button${state} {`);
      expect(css).not.toContain(`body.modern-ui:not(.v2-canvas) button${state} {`);
    });
  });

  test.each(['GuidePage.tsx', 'GuidesIndexPage.tsx'])('%s uses the cobalt mark instead of the legacy PNG', (name) => {
    const source = read(`src/components/landing/${name}`);
    expect(source).toContain('src="/favicon.svg"');
    expect(source).not.toContain('commonly-logo.png');
  });

  test('guide text buttons bind their hover tint to Signal instead of the root theme', () => {
    expect(guideTextButtonSx.color).toBe('#1d3fd1');
    expect(guideTextButtonSx['&:hover'].backgroundColor).toBe(guidePalette.accentSoft);
    expect(guidePalette.accentSoft).toBe('#e9edfb');
    ['GuidePage.tsx', 'GuidesIndexPage.tsx'].forEach((name) => {
      const source = read(`src/components/landing/${name}`);
      expect(source).toContain('sx={guideTextButtonSx}');
      expect(source).not.toContain('sx={{ color: guidePalette.accentText }}');
    });
    const guidePage = read('src/components/landing/GuidePage.tsx');
    expect(guidePage).toContain("sx={{ ...guideTextButtonSx, alignSelf: 'flex-start' }}");
    // The /compare/ static-link branch went with the unlisting (TASK-563): no related link is an anchor.
    expect(guidePage).not.toContain('href={link.path} sx={guideTextButtonSx}>');
    expect(guidePage).toContain('sx={guideTextButtonSx} onClick={() => navigate(link.path)}>');
  });

  test('the CLI authorize surface mounts in .v2-root and reads tokens only', () => {
    // TASK-682: wrapped in .v2-root so the tokens resolve and the dark theme reaches it.
    const tsx = read('src/v2/components/V2CliAuthorize.tsx');
    expect(tsx).toContain('<main className="v2-root v2-cli-authorize">');
    const css = read('src/v2/components/V2CliAuthorize.css');
    expect(css).toContain('background: var(--v2-accent-fill)');
    expect(css).toContain('box-shadow: var(--v2-focus-ring)');
    // No fallbacks inside var() (it merges after #3058), and no card shadow.
    expect(css).not.toMatch(/var\(--v2-[a-z-]+,/);
    expect(css).not.toContain('0 12px 32px');
    // The only hexes are the warning-ink token's light and dark values.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/var\(--v2-[a-z-]+, #[0-9a-f]+\)/gi, '').match(/#[0-9a-f]{3,8}\b/gi)).toEqual(['#7c4a03', '#f4c27a', '#f4c27a']);
    // The input must outrank `body.modern-ui:not(.v2-canvas) input` (0,2,2).
    expect(css).toContain('.v2-root.v2-cli-authorize .v2-cli-authorize__field input {');
    expect(css).toContain('color: var(--v2-warning-ink) !important');
    expect(css).toContain(':root[data-v2-theme="dark"] .v2-cli-authorize { --v2-warning-ink: #f4c27a; }');
    expect(css).toContain(':root:not([data-v2-theme="light"]) .v2-cli-authorize { --v2-warning-ink: #f4c27a; }');
    // App.css's legacy button rule is (0,3,2), its :hover (0,4,2): the controls must out-specify both.
    expect(css).toContain('.v2-root.v2-cli-authorize .v2-cli-authorize__card .v2-cli-authorize__primary {');
    expect(css).toContain('.v2-root.v2-cli-authorize .v2-cli-authorize__card .v2-cli-authorize__primary:hover');
    expect(css).toContain('.v2-root.v2-cli-authorize .v2-cli-authorize__card .v2-cli-authorize__secondary {');
    // Inputs set their own ground, or dark leaves them browser white.
    expect(css).toMatch(/\.v2-cli-authorize__field input \{[^}]*background: var\(--v2-surface\)/);
  });

  test.each([
    'colors-accent.html',
    'colors-semantic.html',
    'colors-agent-roles.html',
    'brand-logo.html',
    'components-buttons.html',
  ])('the legacy %s preview identifies its values as historical', (name) => {
    const html = read(`design-system/preview/${name}`);
    expect(html).toContain('Historical, pre-Signal reference.');
    expect(html).toContain('href="../../../docs/design/signal-identity.md"');
  });

});
