/**
 * buildInstallationConfig — the manifest→installation config projection.
 *
 * The heartbeat block is the regression under test. #833 made heartbeat
 * dispatch opt-in (`config.heartbeat.enabled === true`); the seeder never
 * projected the manifest's declared heartbeat into that flag, so
 * pod-summarizer — whose ONLY trigger is the heartbeat — stopped running
 * entirely at the 2026-08-04 deploy: an 8-day silent first-party outage,
 * surfaced by the #891 reviews. A manifest that declares
 * `triggers: ['heartbeat']` IS the owner's choice; the projection makes the
 * scheduler see it.
 */

const { buildInstallationConfig } = require('../../../scripts/seed-native-agents');

const baseApp = {
  agentName: 'test-app',
  displayName: 'Test App',
  description: 'x',
  systemPrompt: 'do the thing',
  model: 'test/model',
  tools: ['post_message'],
};

describe('buildInstallationConfig', () => {
  test('a manifest-declared heartbeat trigger opts the install in, interval on the key the scheduler reads', () => {
    const config = buildInstallationConfig({
      ...baseApp,
      triggers: ['heartbeat'],
      heartbeatIntervalMinutes: 360,
    });
    // `enabled: true` is the only value schedulerService dispatches on (#833),
    // and `everyMinutes` is what resolveHeartbeatIntervalMinutes reads —
    // the old top-level heartbeatIntervalMinutes copy was read by nothing
    // and pod-summarizer ran hourly for four months while declaring 360.
    expect(config.heartbeat).toEqual({ enabled: true, everyMinutes: 360 });
    expect(config.heartbeatIntervalMinutes).toBeUndefined();
  });

  test('a heartbeat trigger without a declared interval opts in on the scheduler default', () => {
    const config = buildInstallationConfig({ ...baseApp, triggers: ['heartbeat'] });
    expect(config.heartbeat).toEqual({ enabled: true });
  });

  test('apps without a heartbeat trigger get NO heartbeat block — #833 stays opt-in', () => {
    // task-clerk (mention) and pod-welcomer (pod.join) ran on default-on
    // heartbeats they never declared before #833; re-enabling them here would
    // silently undo the opt-in contract for the native class.
    for (const triggers of [['mention'], ['pod.join'], []]) {
      const config = buildInstallationConfig({ ...baseApp, triggers });
      expect(config.heartbeat).toBeUndefined();
    }
  });

  test('a manifest wake-on-message opt-in projects onto the flag the producer reads (ADR-018 D8)', () => {
    const config = buildInstallationConfig({
      ...baseApp,
      triggers: ['mention', 'chat.message'],
      wakeOnMessage: true,
      dailyRunCap: 60,
    });
    expect(config.wakeOnMessage).toEqual({ enabled: true });
    expect(config.dailyRunCap).toBe(60);
  });

  test('apps that do not declare wake-on-message get no flag — D8 stays opt-in', () => {
    const config = buildInstallationConfig({ ...baseApp, triggers: ['mention'] });
    expect(config.wakeOnMessage).toBeUndefined();
    expect(config.dailyRunCap).toBeUndefined();
  });

  test('runtime, prompt, tools, triggers, and limits project as before', () => {
    const config = buildInstallationConfig({
      ...baseApp,
      triggers: ['mention'],
      maxTurns: 4,
      maxTokens: 9000,
      maxWallClockMs: 60000,
    });
    expect(config).toEqual({
      runtime: { runtimeType: 'native' },
      systemPrompt: 'do the thing',
      model: 'test/model',
      tools: ['post_message'],
      triggers: ['mention'],
      maxTurns: 4,
      maxTokens: 9000,
      maxWallClockMs: 60000,
    });
  });
});
