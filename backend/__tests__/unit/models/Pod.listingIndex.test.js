const Pod = require('../../../models/Pod');

// TASK-151. The default sidebar listing (getAllPods, scope=mine) matches on
// caller membership and sorts by recency. Without this index the query is a
// collection scan plus an in-memory sort of every pod on the instance: measured
// for a caller with ONE pod, 118-182 ms on a 200-pod instance, 412-515 ms on
// 1,200 and 644-767 ms on 4,200, against 5-10 ms with the index in place and
// the predicate pushed into the query. A live `explain` confirms
// `IXSCAN { members: 1, updatedAt: -1 }` with no SORT stage (the multikey
// equality binds the prefix and updatedAt supplies the order).
//
// The key ORDER is the load-bearing part, which is why this asserts it rather
// than just the presence of the two fields: { updatedAt: 1, members: 1 } cannot
// satisfy the sort and would leave the in-memory sort in place.
describe('Pod model — sidebar listing index', () => {
  test('has a compound members+updatedAt index in that order', () => {
    const listingIndex = Pod.schema.indexes().find(([fields]) => (
      fields.members === 1 && fields.updatedAt === -1
    ));

    expect(listingIndex).toBeDefined();
    expect(Object.keys(listingIndex[0])).toEqual(['members', 'updatedAt']);
  });
});
