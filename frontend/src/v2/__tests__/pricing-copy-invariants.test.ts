import en from '../../i18n/locales/en.json';
import zhCN from '../../i18n/locales/zh-CN.json';

/**
 * Pricing copy must not promise a price we do not charge. Since the paid tier
 * ended, both tiers are free, and the test below pins that no priced tier
 * comes back without someone meaning it to.
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

  test('the paid tier is gone: no tier is priced, and no Pro, enterprise or per-human price is offered', () => {
    Object.values(LOCALES).forEach((bundle) => {
      const pricing = bundle.landing.pricing as Record<string, any>;
      const tiers = Object.values(pricing).filter((v) => v && typeof v === 'object' && 'name' in v);
      expect(tiers.map((tier) => isPriced(tier))).toEqual([false, false]);
      expect(pricing.pro).toBeUndefined();
      expect(pricing.enterprise).toBeUndefined();
      expect(JSON.stringify(pricing)).not.toMatch(/\$1\d|\bPro\b|per human|每位成员/);
    });
  });
});

/**
 * Claims the TASK-015 walk checked against code and found false. Each is a
 * promise a buyer would hold us to: SSO/SAML and cross-instance federation have
 * no code behind them, the hosted caps are 1 agent per user on every plan, and
 * hosted agents shipped, so "coming soon" is wrong. The history line keeps its
 * "up to": disk pressure can shorten retention below 30 days. Unlimited history
 * was a Pro promise, and Pro is gone from the page.
 */
describe('landing pricing claims that code does not back', () => {
  Object.entries(LOCALES).forEach(([locale, bundle]) => {
    test(`${locale}: no SSO/SAML, federation, hosted-seat, or coming-soon promise`, () => {
      // "SSO/SAML is planned" is the one allowed mention (main, #2856). Strip it
      // first, so any other SSO/SAML copy still fails.
      const pricing = JSON.stringify(bundle.landing.pricing).replace(/SSO\/SAML (is planned|已在计划中)/g, '');
      expect(pricing).not.toMatch(/SSO|SAML|federation across|跨实例联邦/);
      expect(pricing).not.toMatch(/10 hosted agent seats|10个托管智能体席位|coming soon|即将推出/);
    });
  });

  test('message history is stated as a ceiling, not a guarantee', () => {
    expect(en.landing.pricing.cloud.items.history).toMatch(/^Up to 30 days/);
    expect(zhCN.landing.pricing.cloud.items.history).toMatch(/^最长30天/);
  });

});
