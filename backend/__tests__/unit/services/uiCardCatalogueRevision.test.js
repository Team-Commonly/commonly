const { createHash } = require('crypto');
const catalogue = require('../../../config/uiCardCatalogue.json');
const revision = require('../../../config/uiCardCatalogueRevision.json');

// Immutable revision 1 ABI. A new catalogue requires a new revision and reader;
// never update these expectations to retrofit a stored revision's meaning.
describe('Commonly UI catalogue revision 1', () => {
  it('pins all positional property orders', () => {
    expect(Object.fromEntries(Object.entries(catalogue.$defs)
      .map(([name, def]) => [name, Object.keys(def.properties)]))).toEqual({
      Card: ['title', 'children', 'meta', 'summary'], Text: ['body'],
      List: ['items', 'ordered'], Steps: ['steps'], Step: ['label', 'state', 'detail'],
      DiffSummary: ['files'], File: ['path', 'added', 'removed'],
      TaskStatus: ['taskId', 'note'], KeyValue: ['pairs'], Pair: ['key', 'value'],
      Table: ['columns', 'rows'], Col: ['label', 'type'], Badge: ['label', 'tone'],
      Link: ['label', 'url', 'as'], RunTrace: ['limit'],
    });
  });
  it('pins the complete schema, identity and revision hash', () => {
    const hash = `sha256:${createHash('sha256').update(JSON.stringify(catalogue)).digest('hex')}`;
    expect(revision).toEqual({ catalogId: 'commonly.ui', catalogRev: 1,
      catalogHash: 'sha256:bb8b4de07f90c06ee48f254d86478b5bd347c738b3e86cf65e2f32e26534db57' });
    expect(hash).toBe(revision.catalogHash);
  });
});
