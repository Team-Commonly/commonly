// TASK-156 spec fix (wren 74618): the gate reading and the gate+membership
// conjunction have one home, because three copies of the same ternary is how a
// list and a call drift apart. These are that home's own arms.
const {
  isGatedPodTarget,
  isRoutedPodTarget,
  chatPeopleAreListedMembers,
} = require('../../../services/connectorRelayPolicy');

// F489: one home for the rule F158, F487 and F488 each wrote: a bridge row's
// creator (who redeemed the connect code) and its linked user (who switched
// live relay on) must both be listed members for pod content to reach its chat.
describe('chatPeopleAreListedMembers', () => {
  const pod = { createdBy: 'pod-owner', members: ['a', 'b'] };
  const row = (createdBy, linkedUserId) => ({ createdBy, config: { linkedUserId } });

  it('holds while every present person is a listed member', () => {
    expect(chatPeopleAreListedMembers(row('a', 'a'), pod)).toBe(true);
    expect(chatPeopleAreListedMembers(row('a', 'b'), pod)).toBe(true);
    expect(chatPeopleAreListedMembers(row('a', undefined), pod)).toBe(true);
  });

  it('fails when either one has left, the pod creator included', () => {
    expect(chatPeopleAreListedMembers(row('c', 'a'), pod)).toBe(false);
    expect(chatPeopleAreListedMembers(row('a', 'c'), pod)).toBe(false);
    expect(chatPeopleAreListedMembers(row('pod-owner', 'a'), pod)).toBe(false);
  });

  it('fails closed with no pod or no people', () => {
    expect(chatPeopleAreListedMembers(row('a', 'a'), null)).toBe(false);
    expect(chatPeopleAreListedMembers(row(undefined, undefined), pod)).toBe(false);
    expect(chatPeopleAreListedMembers(null, pod)).toBe(false);
  });

  it('compares ObjectId-like ids by their string', () => {
    const id = { toString: () => 'a' };
    expect(chatPeopleAreListedMembers(row(id, id), pod)).toBe(true);
  });
});

const userScoped = (gates) => ({
  scope: 'user',
  type: 'telegram',
  podId: 'active-pod',
  config: { gates },
});
const podScoped = (podId, gates) => ({
  scope: 'pod',
  type: 'telegram',
  podId,
  config: { gates },
});
const pod = ({ members = [], createdBy } = {}) => ({ members, createdBy });

describe('connectorRelayPolicy — the gate reading', () => {
  it('keys a user-scoped connector on its gate for that pod', () => {
    const integration = userScoped({
      'pod-a': { enabled: true },
      'pod-b': { enabled: false },
    });
    expect(isGatedPodTarget(integration, 'pod-a')).toBe(true);
    expect(isGatedPodTarget(integration, 'pod-b')).toBe(false);
    // Absent key, and a key that exists without `enabled: true`, are both closed.
    expect(isGatedPodTarget(integration, 'pod-c')).toBe(false);
    expect(isGatedPodTarget(userScoped({ 'pod-a': {} }), 'pod-a')).toBe(false);
    expect(isGatedPodTarget(userScoped({ 'pod-a': { enabled: 'yes' } }), 'pod-a')).toBe(false);
    expect(isGatedPodTarget(userScoped(undefined), 'pod-a')).toBe(false);
  });

  it('keys a pod-scoped connector on its own pod and never on gates', () => {
    expect(isGatedPodTarget(podScoped('pod-a', undefined), 'pod-a')).toBe(true);
    expect(isGatedPodTarget(podScoped('pod-a', undefined), 'pod-b')).toBe(false);
    // Two identifier spaces for the same allow-list: a pod-scoped connector's
    // gates object is not a second switch, and must not be read as one.
    expect(isGatedPodTarget(podScoped('pod-a', { 'pod-a': { enabled: true } }), 'pod-b')).toBe(false);
    expect(isGatedPodTarget(podScoped('pod-a', { 'pod-b': { enabled: true } }), 'pod-b')).toBe(false);
  });

  it('compares pod ids by value, not by identity', () => {
    const integration = podScoped('pod-a', undefined);
    integration.podId = { toString: () => 'pod-a' };
    expect(isGatedPodTarget(integration, 'pod-a')).toBe(true);
  });
});

describe('connectorRelayPolicy — the routed-target conjunction', () => {
  const target = (overrides = {}) => ({
    integration: userScoped({ 'pod-a': { enabled: true } }),
    pod: pod({ members: ['user-1'] }),
    podId: 'pod-a',
    userId: 'user-1',
    ...overrides,
  });

  it('admits a gated pod the linked user is still in', () => {
    expect(isRoutedPodTarget(target())).toBe(true);
  });

  it('needs BOTH halves — the gate off, or the membership gone, is a refusal', () => {
    expect(isRoutedPodTarget(target({
      integration: userScoped({ 'pod-a': { enabled: false } }),
    }))).toBe(false);
    expect(isRoutedPodTarget(target({ pod: pod({ members: ['someone-else'] }) }))).toBe(false);
    expect(isRoutedPodTarget(target({ pod: undefined }))).toBe(false);
  });

  it('refuses a pod whose creator is not listed in members', () => {
    // TASK-161. `leavePod` filters `members` and never clears `createdBy`, so
    // this cell IS "a creator who has left" — and the pod's own write path
    // (`createMessage`) 401s them. The permissive `isPodMember` counted them as
    // a member so that a pod whose `members` forgot its creator still
    // authorises them; a connector must reach the same verdict as the write.
    expect(isRoutedPodTarget(target({ pod: pod({ createdBy: 'user-1' }) }))).toBe(false);
  });

  it('still admits a creator who is also listed — the clause is gone, not the creator', () => {
    // The complement, so the arm above cannot pass by refusing every pod that
    // names a creator at all.
    expect(isRoutedPodTarget(target({
      pod: pod({ createdBy: 'user-1', members: ['user-1'] }),
    }))).toBe(true);
  });

  it('refuses a missing user id rather than stringifying it into a match', () => {
    // `String(undefined)` is the truthy string 'undefined'; a caller that passed
    // that through would reach the membership read with a user who cannot exist.
    // Not exploitable, but the guard is what keeps this half honest.
    expect(isRoutedPodTarget(target({ userId: undefined }))).toBe(false);
    expect(isRoutedPodTarget(target({ userId: null }))).toBe(false);
    expect(isRoutedPodTarget(target({ userId: '' }))).toBe(false);
  });
});
