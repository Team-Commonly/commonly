const Task = require('../../../models/Task');

// TASK-063. `sourceRef` is PROVENANCE, not identity: one source — a message, a
// PR — can raise several asks with several owners. The unique key is therefore
// the (sourceRef, title) PAIR. The ref-only index that preceded it made the
// second ask adopt the first ask's row: it discarded the caller's title and
// reopened whatever row that ref already belonged to, twice in production
// (TASK-052, TASK-163), the second time on a row a merged PR had completed.
//
// This asserts the DECLARATION, because the declaration is the whole guarantee.
// No runtime branch can notice if someone relaxes the key back to sourceRef
// alone — the route's pre-check and the index would silently agree with each
// other again, which is exactly the state that produced the incident. The
// partial filter is pinned because `sparse` on a compound index indexes every
// doc that has podId (i.e. all of them) and would E11000 the second
// sourceRef-less task in a pod; the name is pinned because
// scripts/migrate-task-source-ref-identity.ts drops the legacy index by name.
describe('Task model — sourceRef identity index', () => {
  test('uniquely keys (podId, sourceRef, title) in that order', () => {
    const pairIndex = Task.schema.indexes().find(([fields]) => (
      fields.podId === 1 && fields.sourceRef === 1 && fields.title === 1
    ));

    expect(pairIndex).toBeDefined();
    expect(Object.keys(pairIndex[0])).toEqual(['podId', 'sourceRef', 'title']);
    expect(pairIndex[1]).toMatchObject({
      unique: true,
      name: 'podId_1_sourceRef_1_title_1_partial',
      partialFilterExpression: { sourceRef: { $type: 'string' } },
    });
  });

  test('declares no ref-only unique index', () => {
    const refOnly = Task.schema.indexes().find(([fields]) => (
      fields.sourceRef === 1 && fields.title === undefined
    ));

    expect(refOnly).toBeUndefined();
  });
});
