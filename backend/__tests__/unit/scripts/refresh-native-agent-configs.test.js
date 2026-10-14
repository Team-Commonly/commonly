/**
 * refresh-native-agent-configs — a manifest refresh merges; it never replaces.
 *
 * The first version assigned the whole projection to `config`. Run for Scout
 * on 2026-10-14, a read-only diff showed it would wipe per-install keys and
 * re-enable wake flags operators had turned off, so the production refresh was
 * done by hand. These arms pin what the script now promises.
 */

const {
  planConfigRefresh, hasChanges, parseArgs, describeValue, stableStringify,
} = require('../../../scripts/refresh-native-agent-configs');
const { MANIFEST_CONFIG_KEYS } = require('../../../scripts/seed-native-agents');

const projected = {
  runtime: { runtimeType: 'native' },
  systemPrompt: 'NEW prompt with the verified knowledge block',
  model: 'deepseek-v4-flash',
  tools: ['post_message', 'propose_action'],
  triggers: ['mention', 'heartbeat'],
  heartbeat: { enabled: true, everyMinutes: 60 },
  wakeOnMessage: { enabled: true },
  recentMessages: 8,
};

describe('planConfigRefresh', () => {
  test('rewrites a changed manifest key and adds a missing one', () => {
    const current = {
      runtime: { runtimeType: 'native' },
      model: 'deepseek-v4-flash',
      tools: ['post_message'],
      triggers: ['mention', 'heartbeat'],
      // no systemPrompt at all: the three agent-room Scouts found on 2026-10-14
    };
    const plan = planConfigRefresh(current, projected);
    expect(plan.changed).toEqual(['tools']);
    expect(plan.added).toEqual(['systemPrompt', 'recentMessages']);
    expect(plan.next.systemPrompt).toBe(projected.systemPrompt);
    expect(plan.next.tools).toEqual(projected.tools);
  });

  test('never touches wake policy, even when the projection differs or the install has none', () => {
    const current = {
      ...projected,
      heartbeat: { enabled: false }, // turned off in the hardening wave
      // wakeOnMessage absent on purpose
    };
    delete current.wakeOnMessage;
    const plan = planConfigRefresh(current, projected);
    expect(hasChanges(plan)).toBe(false);
    expect(plan.next.heartbeat).toEqual({ enabled: false });
    expect(plan.next).not.toHaveProperty('wakeOnMessage');
    expect(plan.kept).toEqual(['heartbeat']);
  });

  test('keeps per-install keys exactly as found', () => {
    const current = { ...projected, autoJoinSource: 'agent-room', boardWake: { enabled: false } };
    const plan = planConfigRefresh(current, { ...projected, systemPrompt: 'changed' });
    expect(plan.changed).toEqual(['systemPrompt']);
    expect(plan.next.autoJoinSource).toBe('agent-room');
    expect(plan.next.boardWake).toEqual({ enabled: false });
    expect(plan.kept).toEqual(['autoJoinSource', 'boardWake', 'heartbeat', 'wakeOnMessage']);
  });

  test('removes a manifest key the manifest no longer declares', () => {
    const current = { ...projected, maxTurns: 12 };
    const plan = planConfigRefresh(current, projected);
    expect(plan.removed).toEqual(['maxTurns']);
    expect(plan.next).not.toHaveProperty('maxTurns');
  });

  test('key order inside a value is not a change, so an unchanged install is not saved', () => {
    const current = { ...projected, runtime: { runtimeType: 'native' } };
    const reordered = { ...projected, heartbeat: { everyMinutes: 60, enabled: true } };
    expect(hasChanges(planConfigRefresh(current, reordered))).toBe(false);
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  test('does not mutate the install config it was given', () => {
    const current = { ...projected, maxTurns: 12 };
    const snapshot = JSON.stringify(current);
    planConfigRefresh(current, { ...projected, systemPrompt: 'changed' });
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  test('the default manifest key list is the one the projection module exports', () => {
    const plan = planConfigRefresh({}, { systemPrompt: 'x', heartbeat: { enabled: true } });
    expect(plan.added).toEqual(['systemPrompt']);
    expect(MANIFEST_CONFIG_KEYS).not.toContain('heartbeat');
  });
});

describe('describeValue (what a dry run prints)', () => {
  test('a prompt prints as length and hash, never its text', () => {
    const out = describeValue('You are Scout. Secret-ish internal guidance.');
    expect(out).toMatch(/^string len=44 sha=[0-9a-f]{8}$/);
    expect(out).not.toMatch(/Scout/);
  });

  test('structured values print as clipped stable JSON', () => {
    expect(describeValue(['a', 'b'])).toBe('["a","b"]');
    expect(describeValue(undefined)).toBe('(absent)');
    expect(describeValue({ x: 'y'.repeat(200) }).length).toBe(80);
  });
});

describe('parseArgs', () => {
  test('the scope is never implied', () => {
    expect(() => parseArgs([])).toThrow(/--app <name>.*or --all/);
    expect(() => parseArgs(['--apply'])).toThrow(/--all/);
    expect(() => parseArgs(['--all', '--app', 'scout'])).toThrow(/not both/);
  });

  test('a dry run is the default; --dry is accepted and stays read-only', () => {
    expect(parseArgs(['--app', 'scout']).apply).toBe(false);
    expect(parseArgs(['--app', 'scout', '--dry']).apply).toBe(false);
    expect(parseArgs(['--app', 'scout', '--apply']).apply).toBe(true);
  });

  test('apps and skipped pods accept repeats and comma lists', () => {
    const args = parseArgs(['--app', 'scout,guide', '--app', 'task-clerk', '--skip-pod', 'p1', '--skip-pod', 'p2,p3']);
    expect(args.apps).toEqual(['scout', 'guide', 'task-clerk']);
    expect([...args.skipPods]).toEqual(['p1', 'p2', 'p3']);
    expect(parseArgs(['--all']).apps).toBe('all');
  });

  test('a flag missing its value or an unknown flag is an error, not a silent default', () => {
    expect(() => parseArgs(['--app'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--app', '--apply'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--app', 'scout', '--force'])).toThrow(/unknown argument/);
  });
});
