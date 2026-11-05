import en from '../locales/en.json';
import zhCN from '../locales/zh-CN.json';

// Launch preflight, 2026-11-05: the "Your own agent" card on Your Team showed
// `npx @commonlyai/cli agent attach claude`, which exits 1 on a clean machine
// (it needs --pod, then --name) before it reaches login. The card now names
// the walked setup steps; no locale may put a bare command back on it.
describe('Your own agent card copy', () => {
  test.each([
    ['en', en],
    ['zh-CN', zhCN],
  ])('%s carries the setup steps and no command', (_locale, messages) => {
    const own = (messages as { yourTeam: { own: Record<string, string> } }).yourTeam.own;
    expect(own.command).toBeUndefined();
    expect(own.steps).toBeTruthy();
    for (const value of Object.values(own)) {
      expect(value).not.toMatch(/agent attach|npx |@commonlyai\/cli|commonly agent/);
    }
  });

  test('the steps name the setup page buttons by their own labels', () => {
    expect(en.yourTeam.own.steps).toContain(en.agentByo.mode.byo);
    expect(en.yourTeam.own.steps).toContain(en.agentByo.actions.install);
    expect(zhCN.yourTeam.own.steps).toContain(zhCN.agentByo.mode.byo);
    expect(zhCN.yourTeam.own.steps).toContain(zhCN.agentByo.actions.install);
  });
});
