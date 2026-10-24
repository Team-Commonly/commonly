const Session = require('../../../models/Session');

test('session schema has no unused context settings or compaction predicate', () => {
  expect(Session.schema.path('contextSettings')).toBeUndefined();
  expect(Session.schema.methods.shouldCompact).toBeUndefined();
  const session = new Session({
    sessionKey: 'agent:pod:session',
    podId: '111111111111111111111111',
  });
  expect(session.toObject()).not.toHaveProperty('contextSettings');
});
