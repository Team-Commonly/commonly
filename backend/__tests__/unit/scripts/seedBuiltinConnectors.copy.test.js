/**
 * The seeded connector rows are what the Connectors page renders, and
 * `seedBuiltinConnectors` runs at boot (`server.ts:350`) with `$set`, so a
 * manifest copy change reaches the page at the next boot without a migration.
 *
 * That is only true while the seed DERIVES the copy. Slack's description is a
 * literal in the same file, so "derive it" is a choice a future edit can
 * silently reverse — and the reversal is invisible to a value comparison,
 * because a forked literal that happens to match reads exactly like a
 * derivation. Hence two arms: one on the value, one on the binding itself.
 *
 * No database: the assertions are on the exported constant and the module's own
 * source. Only the seed's module graph is loaded.
 */
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn() }));

const fs = require('fs');
const path = require('path');

const { TELEGRAM_CONNECTOR } = require('../../../scripts/seed-builtin-connectors');
const { manifests } = require('../../../integrations/manifests');

const SEED_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../../scripts/seed-builtin-connectors.ts'),
  'utf8',
);

describe('builtin connector seed copy', () => {
  it('seeds the Telegram description the provider manifest carries', () => {
    expect(TELEGRAM_CONNECTOR.description).toBe(manifests.telegram.catalog.description);
  });

  it('derives that description rather than forking a second literal', () => {
    // A literal that equals the manifest passes the arm above, so the binding
    // is what has to be asserted. This is the only reader of the source text.
    expect(SEED_SOURCE).toMatch(/description:\s*telegramCatalog\.description\s*,/);
  });

  it('keeps the seeded Telegram copy out of the one-pod model TASK-154 reversed', () => {
    expect(TELEGRAM_CONNECTOR.description).not.toMatch(/one pod/i);
  });
});
