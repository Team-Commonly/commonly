import landingFaq from '../../content/landing-faq.json';

/**
 * TASK-531. The five GEO category questions and GTM's answers, verbatim.
 * The questions are fixed (weekly checks compare them across weeks), so do
 * not reword them. Every answer must describe something the live product does.
 *
 * English only: the FAQ renders and emits its FAQPage JSON-LD on the en locale
 * alone, so the markup always describes text a visitor can read on the page.
 *
 * The items live in src/content/landing-faq.json because the build-time
 * generator (scripts/generate-seo-pages.mjs) writes the same FAQ and FAQPage
 * JSON-LD into the static `/` HTML, which crawlers that run no JS read.
 */
export interface LandingFaqItem {
  question: string;
  answer: string;
}

export const LANDING_FAQ: readonly LandingFaqItem[] = landingFaq;

/**
 * id of the FAQPage script tag. The static `/` HTML ships a tag with this id,
 * so the landing effect reuses it instead of adding a second FAQPage.
 */
export const FAQ_JSONLD_ID = 'landing-faq-jsonld';

/** schema.org FAQPage node for the visible LANDING_FAQ block. */
export function buildFaqPageJsonLd(items: readonly LandingFaqItem[] = LANDING_FAQ): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
