// TASK-171, Vera's coupling arm: the default listing and the connector target
// predicate read ONE constant, so a type added to it must leave BOTH.
//
// The arm cannot be written by mutating the constant at runtime: both readers
// close over the module-scope array at load, so a `jest.mock` that swaps the
// exported binding leaves the readers reading the real one (measured — the
// predicate still admitted `team` after the factory claimed otherwise, in a
// file where the mock was hoisted above every require). What a reader can be
// held to instead is the constant itself, which is what these arms do: each one
// derives its expectation from `DEFAULT_LISTING_HIDDEN_POD_TYPES`, so adding a
// type makes every reader prove it followed — and a second list, whether equal
// in content or not, fails the arms that compare against it.
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_LISTING_HIDDEN_POD_TYPES,
  defaultListingTypeFilter,
  isHiddenFromDefaultListing,
} = require('../../../services/podListing');
const {
  isConnectorTargetPod,
  isRoutedPodTarget,
} = require('../../../services/connectorRelayPolicy');

const readSource = (relative) => fs.readFileSync(path.join(__dirname, '../../../', relative), 'utf8');

describe('the listing and the connector target predicate share one constant', () => {
  it('the default listing filter carries that constant, not a copy of it', () => {
    expect(defaultListingTypeFilter()).toEqual({
      type: { $nin: [...DEFAULT_LISTING_HIDDEN_POD_TYPES] },
    });
    // Identity, not equality: a second frozen array with the same contents today
    // is exactly the drift this row opened on, and `toEqual` cannot see it.
    expect(defaultListingTypeFilter().type.$nin).toBe(DEFAULT_LISTING_HIDDEN_POD_TYPES);
  });

  it('an explicitly requested type still passes through', () => {
    // The hidden set bounds the DEFAULT listing, not an explicit request, so
    // these arms cannot pass by refusing every listing.
    expect(defaultListingTypeFilter('team')).toEqual({ type: 'team' });
  });

  it('every type in the constant is refused as a connector target', () => {
    DEFAULT_LISTING_HIDDEN_POD_TYPES.forEach((type) => {
      expect(isHiddenFromDefaultListing({ type })).toBe(true);
      expect(isConnectorTargetPod({ type, members: ['user-1'] }, 'user-1')).toBe(false);
    });
    // And a type outside it is still a target — otherwise the arm above would
    // pass for a predicate that refuses everything.
    expect(isConnectorTargetPod({ type: 'chat', members: ['user-1'] }, 'user-1')).toBe(true);
    // Membership is still the other half of the rule.
    expect(isConnectorTargetPod({ type: 'chat', members: [] }, 'user-1')).toBe(false);
  });

  it('the routed-target conjunction refuses them too, so relay cannot drift from write', () => {
    const integration = {
      scope: 'user',
      podId: 'active-pod',
      config: { gates: { 'pod-a': { enabled: true } } },
    };
    const gated = (type) => ({
      integration, pod: { type, members: ['user-1'] }, podId: 'pod-a', userId: 'user-1',
    });

    DEFAULT_LISTING_HIDDEN_POD_TYPES.forEach((type) => {
      expect(isRoutedPodTarget(gated(type))).toBe(false);
    });
    expect(isRoutedPodTarget(gated('chat'))).toBe(true);
  });

  it('no second list exists: each reader names the constant, not a type', () => {
    // The runtime arms above cannot see a second literal list whose contents
    // happen to match. These can, and they are written against the two shapes a
    // second list would take — a hardcoded filter in the listing, or an array of
    // types beside the predicate — rather than against every mention of the type
    // name, which legitimately appears in `VALID_POD_TYPES` and in prose.
    const controller = readSource('controllers/podController.ts');
    expect(controller).not.toMatch(/\$ne:\s*'agent-admin'/);
    expect(controller).not.toMatch(/\$nin:\s*\['agent-admin'/);
    expect(controller).toContain('defaultListingTypeFilter');

    const policy = readSource('services/connectorRelayPolicy.ts');
    expect(policy).not.toMatch(/=\s*\[[^\]]*'agent-admin'/);
    expect(policy).toContain('isHiddenFromDefaultListing');
  });
});
