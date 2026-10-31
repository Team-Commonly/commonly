/**
 * Scout posts Linear list results as a kind:'ui' card (TASK-573).
 *
 * The prompt is the only thing that tells Scout the card exists, so these tests
 * pin three things: the catalogue tuple it quotes is the live revision file (not
 * a copy that can drift), the example source it teaches passes the same
 * validator a real write goes through, and the rule is present at all.
 */
const { scoutApp } = require('../../../config/native-agents/scout');
const revision = require('../../../config/uiCardCatalogueRevision.json');
const { validateAgentCardPayload } = require('../../../services/uiCardValidation');

const prompt = scoutApp.systemPrompt;

// The example copied from the prompt, so a changed example fails here too.
const EXAMPLE_SOURCE = 'root = Card("Linear issues", [Table([Col("Issue"), Col("Status")], '
  + '[["LIN-12 Fix login", "In progress"]])])';

describe('Scout Linear list results as a card', () => {
  it('teaches the rule with the live catalogue tuple', () => {
    expect(prompt).toContain('LINEAR LIST RESULTS');
    expect(prompt).toContain(`"catalogId":"${revision.catalogId}"`);
    expect(prompt).toContain(`"catalogRev":${revision.catalogRev}`);
    expect(prompt).toContain(`"catalogHash":"${revision.catalogHash}"`);
  });

  it('teaches an example the card validator accepts', () => {
    expect(prompt).toContain(EXAMPLE_SOURCE);
    const payload = {
      ...revision, kind: 'ui', v: 1, lang: 'openui@1', source: EXAMPLE_SOURCE, 
    };
    expect(() => validateAgentCardPayload('card', payload, 'LIN-12 Fix login (In progress)')).not.toThrow();
  });

  it('names the card as the path for list results, with a text fallback', () => {
    expect(prompt).toContain('messageType "card"');
    expect(prompt).toContain('fallback every reader sees');
  });
});
