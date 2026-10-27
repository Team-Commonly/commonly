import React from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import i18n from '../../../i18n';
import { useAuth } from '../../../context/AuthContext';
import V2LandingPage from '../V2LandingPage';
import { FAQ_JSONLD_ID, LANDING_FAQ, buildFaqPageJsonLd } from '../landingFaq';

/**
 * TASK-531. The FAQ and its FAQPage JSON-LD must describe the same text. The
 * markup is emitted only on the en locale, so a visitor never sees an English
 * answer that the schema does not carry, or the reverse.
 */

jest.mock('axios');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;

const renderLanding = () => render(<MemoryRouter><V2LandingPage /></MemoryRouter>);

const jsonLd = (): Record<string, unknown> | null => {
  const node = document.getElementById('landing-faq-jsonld');
  return node ? JSON.parse(node.textContent || '{}') : null;
};

describe('V2LandingPage FAQ', () => {
  beforeEach(async () => {
    mockAxiosGet.mockResolvedValue({ data: {} });
    mockUseAuth.mockReturnValue({ isAuthenticated: false });
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    jest.clearAllMocks();
    document.getElementById('landing-faq-jsonld')?.remove();
  });

  it('renders each question and answer verbatim on en', () => {
    const { container } = renderLanding();

    const terms = Array.from(container.querySelectorAll('#faq dt')).map((n) => n.textContent);
    const defs = Array.from(container.querySelectorAll('#faq dd')).map((n) => n.textContent);
    expect(terms).toEqual(LANDING_FAQ.map((item) => item.question));
    expect(defs).toEqual(LANDING_FAQ.map((item) => item.answer));
  });

  it('emits FAQPage JSON-LD whose questions match the visible FAQ', () => {
    const { container } = renderLanding();

    const visible = Array.from(container.querySelectorAll('#faq dt')).map((n) => n.textContent);
    const schema = jsonLd() as { '@type': string; mainEntity: { name: string }[] };
    expect(schema).toEqual(buildFaqPageJsonLd());
    expect(schema['@type']).toBe('FAQPage');
    expect(schema.mainEntity.map((q) => q.name)).toEqual(visible);
  });

  it('renders no FAQ and no FAQPage markup on zh', async () => {
    await i18n.changeLanguage('zh');
    const { container } = renderLanding();

    expect(container.querySelector('#faq')).toBeNull();
    expect(jsonLd()).toBeNull();
  });

  it('removes the FAQ and its JSON-LD when the page switches from en to zh', async () => {
    const { container } = renderLanding();
    expect(container.querySelector('#faq')).not.toBeNull();
    expect(jsonLd()).not.toBeNull();

    await act(async () => {
      await i18n.changeLanguage('zh');
    });

    expect(container.querySelector('#faq')).toBeNull();
    expect(jsonLd()).toBeNull();
  });

  it('reuses the FAQPage script the static / HTML ships, then removes it on zh', async () => {
    // generate-seo-pages.mjs writes this tag into the static `/`; hydration must not add a second FAQPage.
    const seeded = document.createElement('script');
    seeded.id = FAQ_JSONLD_ID;
    seeded.type = 'application/ld+json';
    seeded.textContent = '{"@type":"FAQPage","mainEntity":[]}';
    document.head.appendChild(seeded);

    renderLanding();

    expect(document.querySelectorAll(`#${FAQ_JSONLD_ID}`)).toHaveLength(1);
    expect(document.getElementById(FAQ_JSONLD_ID)).toBe(seeded);
    expect(jsonLd()).toEqual(buildFaqPageJsonLd());

    await act(async () => {
      await i18n.changeLanguage('zh');
    });

    expect(document.getElementById(FAQ_JSONLD_ID)).toBeNull();
  });
});
