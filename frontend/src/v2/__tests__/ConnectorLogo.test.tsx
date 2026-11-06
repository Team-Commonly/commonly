import fs from 'fs';
import path from 'path';
import React from 'react';
import { render } from '@testing-library/react';
import ConnectorLogo, { connectorName } from '../connectors/ConnectorLogo';

describe('ConnectorLogo', () => {
  test('Discord is the d215 frame\'s brand mark, not the grey glyph fallback', () => {
    const { container } = render(<ConnectorLogo type="discord" />);
    expect(container.querySelector('.v2-cx-logo--glyph')).toBeNull();
    expect(container.querySelector('svg.v2-cx-logo rect')).toHaveAttribute('fill', '#5865F2');
    // The mark itself: the white face and its two eyes, so a bare blue plate fails.
    expect(container.querySelector('svg.v2-cx-logo path')).toHaveAttribute('fill', '#fff');
    expect(container.querySelector('svg.v2-cx-logo path')?.getAttribute('d')).toMatch(/^M12\.5 13\.5/);
    expect(container.querySelectorAll('svg.v2-cx-logo circle')).toHaveLength(2);
  });

  test('Notion is the frame\'s mark, and its plate and stroke follow the theme', () => {
    const { container } = render(<ConnectorLogo type="notion" />);
    expect(container.querySelector('.v2-cx-logo--glyph')).toBeNull();
    expect(container.querySelector('svg.v2-cx-logo > rect')).toHaveAttribute('fill', 'var(--v2-bg-subtle)');
    expect(container.querySelector('svg.v2-cx-logo g')).toHaveAttribute('stroke', 'var(--v2-ink)');
    // The page outline and the N inside it.
    expect(container.querySelector('svg.v2-cx-logo g rect')).toHaveAttribute('width', '18');
    expect(container.querySelector('svg.v2-cx-logo g path')).toHaveAttribute('d', 'M7.5 17V7l9 10V7');
  });

  test('a type with no drawn logo still gets the glyph on its soft disc', () => {
    const { container } = render(<ConnectorLogo type="groupme" />);
    expect(container.querySelector('.v2-cx-logo--glyph')).not.toBeNull();
  });

  test('both read as their brand names', () => {
    expect(connectorName('discord')).toBe('Discord');
    expect(connectorName('notion')).toBe('Notion');
  });

  test('tile names use the frame\'s ink, and the section icon rule is present', () => {
    const css = fs.readFileSync(path.join(__dirname, '../connectors/connectors.css'), 'utf8');
    const name = css.match(/\.v2-cx-tile__name \{[^}]*\}/)?.[0] ?? '';
    expect(name).toContain('color: var(--v2-ink-2)');
    expect(css).toMatch(/\.v2-cx-group__icon \{[^}]*width: 13px; height: 13px;/);
    expect((css.match(/\{/g) ?? []).length).toBe((css.match(/\}/g) ?? []).length);
  });
});
