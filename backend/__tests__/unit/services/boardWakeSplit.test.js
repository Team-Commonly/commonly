/**
 * Board wakes are a separate subscription from ambient chat (#1071, TASK-033).
 *
 * The property that matters is not "the new flag works" — it is that turning
 * the split on changed NOTHING for the installs that already existed. All 263
 * active installs carry no `boardWake` key, so the inherit branch is the whole
 * live population; a regression there is invisible in any test that only
 * exercises the new explicit branch.
 */
const { boardWakeEnabled, wakeOnMessageEnabled } = require('../../../services/agentMentionService');

const inst = (config) => ({ agentName: 'planner', instanceId: 'default', config });

describe('boardWakeEnabled — the four-cell matrix', () => {
  it.each([
    ['boardWake absent, wakeOnMessage on  -> inherits on', { wakeOnMessage: { enabled: true } }, true],
    ['boardWake absent, wakeOnMessage off -> inherits off', { wakeOnMessage: { enabled: false } }, false],
    ['boardWake true  overrides chat off', { boardWake: { enabled: true }, wakeOnMessage: { enabled: false } }, true],
    ['boardWake false overrides chat on', { boardWake: { enabled: false }, wakeOnMessage: { enabled: true } }, false],
  ])('%s', (_label, config, expected) => {
    expect(boardWakeEnabled(inst(config))).toBe(expected);
  });

  it('the Planner shape: board wakes without ambient chat', () => {
    const planner = inst({ boardWake: { enabled: true } });
    expect(boardWakeEnabled(planner)).toBe(true);
    // The whole point of the split — subscribing to the board must NOT
    // subscribe the seat to every message in the pod.
    expect(wakeOnMessageEnabled(planner)).toBe(false);
  });

  it('the inverse shape: ambient chat without board wakes', () => {
    const talker = inst({ wakeOnMessage: { enabled: true }, boardWake: { enabled: false } });
    expect(wakeOnMessageEnabled(talker)).toBe(true);
    expect(boardWakeEnabled(talker)).toBe(false);
  });
});

describe('backward compatibility — the branch the entire live fleet is on', () => {
  // Measured 2026-08-22 against the running instance: 263 active installs,
  // 34 with wakeOnMessage.enabled, ZERO carrying a boardWake key. So every
  // real install resolves through inherit, and these are the only cells that
  // describe production today.
  it.each([
    ['no config at all', undefined],
    ['empty config', {}],
    ['wakeOnMessage present but empty', { wakeOnMessage: {} }],
    ['boardWake present but empty', { boardWake: {} }],
  ])('%s -> false, same as wakeOnMessageEnabled', (_label, config) => {
    const i = inst(config);
    expect(boardWakeEnabled(i)).toBe(wakeOnMessageEnabled(i));
    expect(boardWakeEnabled(i)).toBe(false);
  });

  it('a truthy-but-not-true enabled does NOT subscribe, on either predicate', () => {
    // wakeOnMessageEnabled uses === true deliberately; the split must not
    // quietly widen that. 'true' the string is the shape a manifest typo takes.
    const i = inst({ boardWake: { enabled: 'true' } });
    expect(boardWakeEnabled(i)).toBe(false);
    expect(wakeOnMessageEnabled(i)).toBe(false);
  });

  it('inherit is a delegation, not a copy — it tracks wakeOnMessage exactly', () => {
    for (const enabled of [true, false, undefined, null, 1, 0, 'yes']) {
      const i = inst({ wakeOnMessage: { enabled } });
      expect(boardWakeEnabled(i)).toBe(wakeOnMessageEnabled(i));
    }
  });
});
