// @ts-nocheck
// Regression for the empty-digest path: createEmptyDigest used to emit
// engagement_quality: 'low', which is not in the Summary schema enum
// (superficial/moderate/deep/intense) — every quiet-day digest failed
// Summary validation and no digest was saved for the user.

const Summary = require('../../../models/Summary').default;
const { DailyDigestService } = require('../../../services/dailyDigestService');

describe('DailyDigestService.createEmptyDigest', () => {
  it('produces analytics that pass Summary schema validation', () => {
    const start = new Date('2026-07-05T00:00:00Z');
    const end = new Date('2026-07-06T00:00:00Z');
    const empty = DailyDigestService.createEmptyDigest({ username: 'quiet-user' }, start, end);

    const doc = new Summary({
      type: 'daily-digest',
      title: empty.title,
      content: empty.content,
      timeRange: { start, end },
      metadata: { userId: 'test-user-id' },
      analytics: empty.analytics,
    });

    expect(doc.validateSync()).toBeUndefined();
  });
});
