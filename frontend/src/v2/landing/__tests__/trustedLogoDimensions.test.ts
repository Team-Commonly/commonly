/**
 * TASK-206: lazy logos must reserve their aspect ratio before loading. These
 * pins derive each ratio from the shipped asset; the browser fixture separately
 * compares the track's box before/after load at desktop and phone widths.
 */
import fs from 'fs';
import path from 'path';
import { blockAt, blockContaining } from '../../lib/cssBlocks';

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'V2LandingPage.tsx'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'v2-landing.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const PUBLIC = path.resolve(__dirname, '../../../../public');

/** SVG viewBox or PNG IHDR dimensions, independent of the page's constants. */
const assetRatio = (file: string): number => {
  const bytes = fs.readFileSync(path.join(PUBLIC, file));
  if (file.endsWith('.svg')) {
    const viewBox = /viewBox="([^"]+)"/.exec(bytes.toString('utf8'));
    expect(viewBox).not.toBeNull();
    const [, , width, height] = viewBox![1].trim().split(/[\s,]+/).map(Number);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    return width / height;
  }
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return bytes.readUInt32BE(16) / bytes.readUInt32BE(20);
};

describe('trusted logos reserve their boxes (TASK-206)', () => {
  test('every affiliation declares its asset aspect ratio at 26px high', () => {
    const config = /const TRUSTED_AFFILIATIONS = \[([\s\S]*?)\] as const;/.exec(PAGE);
    expect(config).not.toBeNull();
    const rows = [...config![1].matchAll(/\{([^}]+)\}/g)];
    expect(rows).toHaveLength(24);
    for (const row of rows) {
      const logo = /logo: '([^']+)'/.exec(row[1]);
      const width = /width: ([\d.]+)/.exec(row[1]);
      expect(logo).not.toBeNull();
      expect(width).not.toBeNull();
      expect(Number(width![1])).toBeCloseTo(assetRatio(logo![1]) * 26, 10);
    }
  });

  test('the shared image markup passes both dimensions to each lazy logo', () => {
    const logo = /<img\b[^>]*className="v2-landing__trusted-logo"[^>]*\/>/.exec(PAGE);
    expect(logo).not.toBeNull();
    expect(logo![0]).toMatch(/src=\{affiliation\.logo\}/);
    expect(logo![0]).toMatch(/width=\{affiliation\.width\}/);
    expect(logo![0]).toMatch(/height=\{26\}/);
    expect(logo![0]).toMatch(/loading="lazy"/);
  });

  test('CSS keeps proportional auto width at desktop and 22px phone height', () => {
    const base = blockAt(CSS, CSS.indexOf('.v2-landing__trusted-logo {'));
    expect(base).toMatch(/height:\s*26px\s*;/);
    expect(base).toMatch(/width:\s*auto\s*;/);
    const phone = blockContaining(CSS, '@media', '.v2-landing__trusted-logo { height: 22px; }');
    expect(phone).toMatch(/max-width:\s*680px/);
    expect(phone).toContain('.v2-landing__trusted-logo { height: 22px; }');
  });
});
