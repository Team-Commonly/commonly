/**
 * A lang-core upgrade must not change what the backend accepts. Every card in
 * the fixture was run through services/uiCardValidation.ts against the
 * published @openuidev/lang-core 1.0.1 package, and its verdict recorded:
 * accepted, or degraded to its text fallback for an unapproved link host. The
 * installed lang-core must reach the same verdict for each, under both
 * catalogue revisions, and stampCardSource must print the same envelope, since
 * clients render the stored source as it was written.
 */
const fixture = require('../../fixtures/uiCards/lang-core-1.0.1-accepted.json');
const rev1 = require('../../../config/uiCardCatalogueRevision.json');
const rev2 = require('../../../config/uiCardCatalogueRevision.rev2.json');
const { validateAgentCardPayload, stampCardSource } = require('../../../services/uiCardValidation');

const revisions = { 1: rev1, 2: rev2 };
const verdict = (catalogRev, source) => (validateAgentCardPayload('card', {
  ...revisions[catalogRev], kind: 'ui', v: 1, lang: 'openui@1', source,
}, 'Text fallback') ? 'degraded' : 'accepted');

describe('cards the lang-core 1.0.1 server accepted', () => {
  test('still get the same verdict, and stamped cards print the same envelope', () => {
    expect(fixture.recordedWith).toBe('@openuidev/lang-core@1.0.1');
    expect(fixture.agent.length).toBeGreaterThan(0);
    const actual = fixture.agent.map(({ name, catalogRev, source }) => ({
      name, catalogRev, verdict: verdict(catalogRev, source),
    }));
    expect(actual).toEqual(fixture.agent.map(({ name, catalogRev, verdict: recorded }) => ({
      name, catalogRev, verdict: recorded,
    })));

    fixture.stamped.forEach(({ source, connector, envelope }) => {
      expect(stampCardSource(source, 'Text fallback', {
        connector, fetchedAt: '2026-11-24T00:00:00.000Z',
      })).toEqual(envelope);
    });
  });
});
