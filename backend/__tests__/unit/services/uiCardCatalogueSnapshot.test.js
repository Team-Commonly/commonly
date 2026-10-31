/**
 * The MCP read tool serves commonly-mcp/src/ui-card-catalogue.json, a copy of
 * the backend catalogue made for npm (the package cannot import backend TS).
 * These checks keep the copy honest and prove every example it hands an agent
 * is accepted by the same validator the write path uses.
 */
const fs = require('fs');
const path = require('path');
const catalogueRevision = require('../../../config/uiCardCatalogueRevision.json');
const catalogue = require('../../../config/uiCardCatalogue.json');
const { validateAgentCardPayload } = require('../../../services/uiCardValidation');

const snapshotPath = path.join(__dirname, '../../../../commonly-mcp/src/ui-card-catalogue.json');
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

describe('commonly-mcp UI card catalogue snapshot', () => {
  it('serves the same revision tuple as the backend', () => {
    expect(snapshot.revision).toEqual(catalogueRevision);
  });
  it('serves the same component grammar as the backend', () => {
    expect(snapshot.grammar).toEqual(catalogue);
  });
  it.each(snapshot.examples.map((example) => [example.title, example.source]))(
    'accepts the example "%s" through the write validator',
    (_title, source) => {
      const payload = {
        kind: 'ui', v: 1, lang: 'openui@1', source, ...snapshot.revision,
      };
      expect(() => validateAgentCardPayload('card', payload, 'Text fallback')).not.toThrow();
    },
  );
});
