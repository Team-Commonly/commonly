const {
  isOneToOneShapedPod,
  resolveWakePolicy,
  wakeOnMessageEnabledForPod,
} = require('../../../services/wakePolicyService');

const wakeConfig = { runtime: { runtimeType: 'native' }, wakeOnMessage: { enabled: true } };

describe('wake policy — personal rooms wake, shared rooms mention-only', () => {
  test('keeps an explicit opt-in for a 1:1-shaped private chat', () => {
    const pod = { type: 'chat', members: ['owner', 'guide'] };

    expect(isOneToOneShapedPod(pod)).toBe(true);
    expect(resolveWakePolicy(wakeConfig, pod)).toEqual(wakeConfig);
    expect(wakeOnMessageEnabledForPod(wakeConfig, pod)).toBe(true);
  });

  test('turns the same opt-in off in a shared chat and every non-chat shape', () => {
    const shared = { type: 'chat', members: ['owner', 'guide', 'teammate'] };

    expect(isOneToOneShapedPod(shared)).toBe(false);
    expect(resolveWakePolicy(wakeConfig, shared)).toEqual({
      runtime: { runtimeType: 'native' },
      wakeOnMessage: { enabled: false },
    });
    expect(wakeOnMessageEnabledForPod(wakeConfig, shared)).toBe(false);
    expect(wakeOnMessageEnabledForPod(wakeConfig, { type: 'team', members: ['owner'] })).toBe(false);
  });

  test('preserves default-off configurations and fails closed without a pod shape', () => {
    const defaultOff = { runtime: { runtimeType: 'native' } };

    expect(resolveWakePolicy(defaultOff, undefined)).toEqual(defaultOff);
    expect(wakeOnMessageEnabledForPod(wakeConfig, undefined)).toBe(false);
  });
});
