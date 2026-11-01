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

// Revision 2 (TASK-607) is revision 1 plus the server-stamped Source. Same rule:
// never edit these expectations; a change to the grammar is revision 3.
describe('Commonly UI catalogue revision 2', () => {
  const catalogue2 = require('../../../config/uiCardCatalogue.rev2.json');
  const revision2 = require('../../../config/uiCardCatalogueRevision.rev2.json');
  it('pins all positional property orders', () => {
    expect(Object.fromEntries(Object.entries(catalogue2.$defs)
      .map(([name, def]) => [name, Object.keys(def.properties)]))).toEqual({
      Card: ['title', 'children', 'meta', 'summary'], Text: ['body'],
      List: ['items', 'ordered'], Steps: ['steps'], Step: ['label', 'state', 'detail'],
      DiffSummary: ['files'], File: ['path', 'added', 'removed'],
      TaskStatus: ['taskId', 'note'], KeyValue: ['pairs'], Pair: ['key', 'value'],
      Table: ['columns', 'rows'], Col: ['label', 'type'], Badge: ['label', 'tone'],
      Link: ['label', 'url', 'as'], RunTrace: ['limit'], Source: ['connector', 'fetchedAt'],
    });
  });
  it('pins the complete schema, identity and revision hash', () => {
    const hash = `sha256:${createHash('sha256').update(JSON.stringify(catalogue2)).digest('hex')}`;
    expect(revision2).toEqual({ catalogId: 'commonly.ui', catalogRev: 2,
      catalogHash: 'sha256:1bbf106e81f08dde540996d53b32e8ac12f661ecdc1409e7ceb2c8a26655b7a1' });
    expect(hash).toBe(revision2.catalogHash);
  });
});
