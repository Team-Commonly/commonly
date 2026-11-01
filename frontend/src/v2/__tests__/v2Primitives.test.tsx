import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen } from '@testing-library/react';
import V2PrimitivesPage from '../primitives/V2PrimitivesPage';

// TASK-730 (D223) PR2: the shared primitives must take every colour and radius
// from the --v2-* tokens (the artboard's short names are mapped in
// primitives.css's header, not copied), and every v2p- class the page uses
// must be defined in the stylesheet.

const css = fs.readFileSync(path.join(__dirname, '../primitives/primitives.css'), 'utf8');
const pageSrc = fs.readFileSync(path.join(__dirname, '../primitives/V2PrimitivesPage.tsx'), 'utf8');

describe('D223 primitives', () => {
  test('primitives.css reads only --v2-* tokens, never the artboard short names', () => {
    const varRefs = Array.from(css.matchAll(/var\(--([a-z0-9-]+)\)/g), (m) => m[1]);
    const foreign = varRefs.filter((name) => !name.startsWith('v2-'));
    expect(foreign).toEqual([]);
  });

  test('every v2p- class the page uses is defined in primitives.css', () => {
    const used = new Set<string>();
    Array.from(pageSrc.matchAll(/className="([^"]+)"/g)).forEach((m) => {
      m[1].split(/\s+/).filter((c) => c.startsWith('v2p-')).forEach((c) => used.add(c));
    });
    expect(used.size).toBeGreaterThan(10);
    const undefinedClasses = Array.from(used).filter((c) => !css.includes(`.${c}`));
    expect(undefinedClasses).toEqual([]);
  });

  test('the page renders the shell, header, keys, segment, chips and drawer', () => {
    render(<V2PrimitivesPage />);
    expect(screen.getByRole('heading', { name: 'Primitives' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByLabelText('Drawer example')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Drawer title' })).toBeInTheDocument();
  });
});
