import en from '../../i18n/locales/en.json';
import zhCN from '../../i18n/locales/zh-CN.json';

/**
 * Pricing copy must not promise a price we do not charge.
 *
 * This exists because it already happened: the Pro card shipped carrying a
 * "Free in beta" / "公测期免费" badge directly above "$12/human/mo", and stayed
 * that way through the commit that turned real billing on. A user who signs up
 * under a free-in-beta banner and is then charged has a dispute, not a
 * misunderstanding — so a free-claim on a priced tier is a money bug, not a
 * copy nit, and it belongs in the test suite rather than in a reviewer's head.
 *
 * The check is deliberately narrow. Only the fields that DESCRIBE COST are
 * scanned (`price`, `period`, `note`, and any `badge`); the feature bullets are
 * exempt because they legitimately name other tiers — "Everything in Cloud
 * free" is a cross-reference, not a price claim.
 */

const LOCALES = { en, 'zh-CN': zhCN } as Record<string, any>;

// Fields that make a statement about what the tier costs.
const COST_FIELDS = ['badge', 'price', 'period', 'note'];

// A free-claim in each language we ship. Kept as plain substrings: this must
// stay readable by someone adding a locale, who has to extend it.
const FREE_CLAIMS = [/free/i, /免费/, /\$0\b/];

/** A tier is "priced" when its price field names a non-zero amount. */
const isPriced = (tier: Record<string, unknown>): boolean => {
  const price = String(tier.price ?? '');
  const digits = price.replace(/[^\d.]/g, '');
  return digits !== '' && parseFloat(digits) > 0;
};

describe('landing pricing copy', () => {
  Object.entries(LOCALES).forEach(([locale, bundle]) => {
    describe(locale, () => {
      const pricing = bundle.landing.pricing as Record<string, any>;
      const tiers = Object.entries(pricing).filter(
        ([, v]) => v && typeof v === 'object' && 'name' in v,
      );

      test('has tiers to check (guards against the copy moving out from under this test)', () => {
        expect(tiers.length).toBeGreaterThan(0);
      });

      test.each(tiers)('the %s tier never claims to be free while showing a price', (name, tier) => {
        if (!isPriced(tier)) return; // Free tiers are free; nothing to defend.

        COST_FIELDS.forEach((field) => {
          const text = tier[field];
          if (typeof text !== 'string') return;
          FREE_CLAIMS.forEach((claim) => {
            expect(`${name}.${field}: ${text}`).not.toMatch(claim);
          });
        });
      });
    });
  });

  test('Pro is priced, so the rule above actually applies to it', () => {
    // Without this, deleting the price would silently disarm every assertion.
    expect(isPriced(en.landing.pricing.pro)).toBe(true);
    expect(isPriced(zhCN.landing.pricing.pro)).toBe(true);
  });

  test('the two locales price Pro identically — currency is not translated', () => {
    expect(zhCN.landing.pricing.pro.price).toBe(en.landing.pricing.pro.price);
  });
});
