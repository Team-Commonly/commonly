import fs from 'fs';
import path from 'path';
import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import i18n from '../../../i18n';
import { useAuth } from '../../../context/AuthContext';
import V2LandingPage from '../V2LandingPage';

/**
 * worksWithLogos.test.ts reads the config. This one reads the page: each tile
 * draws a mark, and each configured file, both theme variants included, is on it.
 */

jest.mock('axios');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'V2LandingPage.tsx'), 'utf8');
const configured = [...PAGE.matchAll(/'(\/logos\/works-with\/[^']+\.svg)'/g)].map((match) => match[1]);

describe('the Works with tiles as rendered', () => {
  beforeEach(async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: {} });
    (useAuth as jest.Mock).mockReturnValue({ isAuthenticated: false });
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('draws one mark on every tile, and our own on the hosted agent', () => {
    const { container } = render(<MemoryRouter><V2LandingPage /></MemoryRouter>);
    const tiles = [...container.querySelectorAll('.v2-landing__works-item')];

    expect(tiles).toHaveLength(11);
    for (const tile of tiles) expect(tile.querySelector('.v2-landing__works-logo')).not.toBeNull();
    const hosted = tiles.find((tile) => tile.textContent?.includes('Hosted agent'));
    expect(hosted?.querySelector('svg.v2-landing__works-logo')).not.toBeNull();
  });

  it('puts every configured file on the page', () => {
    const { container } = render(<MemoryRouter><V2LandingPage /></MemoryRouter>);
    const rendered = [...container.querySelectorAll('img.v2-landing__works-logo')]
      .map((image) => image.getAttribute('src'));

    expect(configured.length).toBeGreaterThan(0);
    expect(rendered.sort()).toEqual([...configured].sort());
  });
});
