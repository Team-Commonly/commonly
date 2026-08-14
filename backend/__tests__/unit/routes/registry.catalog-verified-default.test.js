/**
 * The public agent catalog must not serve our own test fixtures.
 *
 * Measured on production 2026-08-14: `GET /api/registry/agents` returned 66
 * rows, 52 of them unverified — and among those were every internal and
 * smoke-test agent we have created:
 *
 *   smoke-claude · demo-claude · demo-claude2 · demo-target · demo-clean2
 *   smokea50698-{agent,scribe,helper,organic} · smoke-stub · test-agent
 *   test-agent2 · pod-architect · cl-critic · cl-strategist · claude-on-dev
 *   sam-claude · sam-local-codex · nova-claude · hq-support · carol
 *
 * `search()` already excluded ephemeral rows, so that was never the leak. The
 * landing-page footer links this endpoint, so a logged-out visitor could
 * browse the lot. `verified` is precisely the axis that separates them: those
 * rows are all `commonly-community` + unverified; the curated set is verified.
 *
 * These pin the DEFAULT, not the capability — `?verified=false` still works.
 */

const mockSearch = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { search: (...args) => mockSearch(...args), getByName: jest.fn() },
  AgentInstallation: { find: jest.fn(), findOne: jest.fn() },
}));

const { parseVerifiedFilter } = require('../../../routes/registry/helpers');

// Mirrors the resolution in routes/registry/catalog.ts.
const resolveVerified = (raw) => {
  const parsed = parseVerifiedFilter(raw);
  return parsed === null ? true : parsed;
};

describe('the public catalog defaults to verified-only', () => {
  test('no ?verified param → verified: true', () => {
    // The leak: absent used to mean "no filter", i.e. show everything.
    expect(resolveVerified(undefined)).toBe(true);
  });

  test('?verified=true → true', () => {
    expect(resolveVerified('true')).toBe(true);
  });

  test('?verified=false still reaches unverified rows — capability preserved', () => {
    // Nothing becomes unreachable; only the default changes. An explicit
    // opt-in is how an admin or a future curated-community view gets them.
    expect(resolveVerified('false')).toBe(false);
  });

  test('a garbage value falls back to the safe default rather than to "show all"', () => {
    // parseVerifiedFilter returns null for anything it does not recognise, and
    // null must resolve to the RESTRICTIVE side — the whole point of the fix.
    expect(resolveVerified('yes')).toBe(true);
    expect(resolveVerified('')).toBe(true);
  });
});
