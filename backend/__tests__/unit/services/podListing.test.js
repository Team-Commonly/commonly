/**
 * podListing — the join-policy gate, tested against the ABSENT field.
 *
 * `joinPolicy` has a mongoose default of 'open', but a default applies on
 * write: documents created before the field existed carry no `joinPolicy`
 * at all, and production still holds 18 of them. Every read here must
 * therefore fail OPEN — `!== 'invite-only'`, never `=== 'open'` — so a
 * legacy pod stays joinable instead of silently disappearing from Discover.
 *
 * The predicate and the query are two encodings of the same rule, and they
 * are consumed by different callers (podController's join path vs. the
 * Mongo listing queries). They can drift apart, so both are asserted on the
 * absent-field case, not just the predicate.
 */
const {
  isCommunityListed,
  isDirectlyJoinable,
  DIRECTLY_JOINABLE_QUERY,
  communityDiscoverQuery,
  NON_LISTABLE_POD_TYPES,
} = require('../../../services/podListing');

const listedPod = (overrides = {}) => ({
  type: 'chat',
  publicRead: true,
  communityListed: true,
  ...overrides,
});

describe('podListing join-policy gate', () => {
  describe('absent joinPolicy (legacy rows) must fail OPEN', () => {
    test('isDirectlyJoinable is true when the field is missing entirely', () => {
      const pod = listedPod();
      expect('joinPolicy' in pod).toBe(false);
      expect(isDirectlyJoinable(pod)).toBe(true);
    });

    test('isDirectlyJoinable is true when the field is explicitly undefined', () => {
      expect(isDirectlyJoinable(listedPod({ joinPolicy: undefined }))).toBe(true);
    });

    test('isDirectlyJoinable is true when the field is null', () => {
      expect(isDirectlyJoinable(listedPod({ joinPolicy: null }))).toBe(true);
    });

    // The query half of the same rule. `{ $ne: 'invite-only' }` matches
    // documents where the field is absent; `{ $eq: 'open' }` would not, so
    // this asserts the encoding rather than just the value.
    test('DIRECTLY_JOINABLE_QUERY negates invite-only rather than asserting open', () => {
      expect(DIRECTLY_JOINABLE_QUERY.joinPolicy).toEqual({ $ne: 'invite-only' });
      expect(DIRECTLY_JOINABLE_QUERY.joinPolicy).not.toEqual({ $eq: 'open' });
      expect(DIRECTLY_JOINABLE_QUERY.joinPolicy).not.toBe('open');
    });

    test('communityDiscoverQuery inherits the same fail-open gate', () => {
      const query = communityDiscoverQuery({ callerId: 'user-1' });
      expect(query.joinPolicy).toEqual({ $ne: 'invite-only' });
    });
  });

  describe('present joinPolicy still gates as before', () => {
    test('open is joinable', () => {
      expect(isDirectlyJoinable(listedPod({ joinPolicy: 'open' }))).toBe(true);
    });

    test('invite-only is not joinable', () => {
      expect(isDirectlyJoinable(listedPod({ joinPolicy: 'invite-only' }))).toBe(false);
    });
  });

  describe('the join gate does not override the listing gate', () => {
    test('an unlisted pod is not joinable even with no joinPolicy', () => {
      expect(isDirectlyJoinable(listedPod({ communityListed: false }))).toBe(false);
    });

    test('a non-public pod is not joinable even with no joinPolicy', () => {
      expect(isDirectlyJoinable(listedPod({ publicRead: false }))).toBe(false);
    });

    test.each(NON_LISTABLE_POD_TYPES)('%s is never listed or joinable', (type) => {
      expect(isCommunityListed(listedPod({ type }))).toBe(false);
      expect(isDirectlyJoinable(listedPod({ type }))).toBe(false);
    });
  });
});
