import en from '../locales/en.json';
import zhCN from '../locales/zh-CN.json';

// Launch preflight, 2026-11-05: the "Your own agent" card on Your Team showed
// `npx @commonlyai/cli agent attach claude`, which exits 1 on a clean machine
// (it needs --pod, then --name) before it reaches login. The card now points
// to the walked setup page; no locale may put a bare command back on it.
describe('Your own agent card copy', () => {
  test.each([
    ['en', en],
    ['zh-CN', zhCN],
  ])('%s carries no command', (_locale, messages) => {
    const own = (messages as { yourTeam: { own: Record<string, string> } }).yourTeam.own;
    expect(own.command).toBeUndefined();
    for (const value of Object.values(own)) {
      expect(value).not.toMatch(/agent attach|npx |@commonlyai\/cli|commonly agent/);
    }
  });
});
