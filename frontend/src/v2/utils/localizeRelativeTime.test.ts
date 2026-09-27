import i18n, { i18nReady } from '../../i18n';
import { localizeWindow } from './localizeRelativeTime';

// localizeWindow had no test of its own, and the clamp inside it is the ONE
// behaviour change in TASK-164: the English path used to read `just now` for a
// sub-minute window. Removing the clamp passes every other test in the repo and
// renders `0m` / `0分钟` instead — worse than either string it replaced — so the
// clamp is pinned here directly, at the unit rather than through a component
// whose fixture happens to use a one-hour window.
describe('localizeWindow', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  const minutes = async (ms: number) => {
    await i18n.changeLanguage('en');
    const en = localizeWindow(ms, i18n.t.bind(i18n));
    await i18n.changeLanguage('zh-CN');
    const zh = localizeWindow(ms, i18n.t.bind(i18n));
    return { en, zh };
  };

  test('a sub-minute window floors at one minute instead of rendering 0 (TASK-164)', async () => {
    // 30s is reachable: RoomGrant.budget.windowMs permits a minimum of 1.
    await expect(minutes(30_000)).resolves.toEqual({ en: '1m', zh: '1分钟' });
    // And the bottom of that range must not produce a zero-width window.
    await expect(minutes(1)).resolves.toEqual({ en: '1m', zh: '1分钟' });
  });

  test('rounds to the nearest minute, hour and day', async () => {
    await expect(minutes(60_000)).resolves.toEqual({ en: '1m', zh: '1分钟' });
    await expect(minutes(90_000)).resolves.toEqual({ en: '2m', zh: '2分钟' });
    await expect(minutes(3_600_000)).resolves.toEqual({ en: '1h', zh: '1小时' });
    await expect(minutes(5_400_000)).resolves.toEqual({ en: '2h', zh: '2小时' });
    await expect(minutes(23 * 3_600_000)).resolves.toEqual({ en: '23h', zh: '23小时' });
    await expect(minutes(24 * 3_600_000)).resolves.toEqual({ en: '1d', zh: '1天' });
    await expect(minutes(3 * 24 * 3_600_000)).resolves.toEqual({ en: '3d', zh: '3天' });
  });

  test('is localized rather than hardcoded, in both directions', async () => {
    await i18n.changeLanguage('zh-CN');
    // No Latin unit can survive: this is what the zh UX gate caught.
    expect(localizeWindow(3_600_000, i18n.t.bind(i18n))).not.toMatch(/[a-z]/i);
    await i18n.changeLanguage('en');
    expect(localizeWindow(3_600_000, i18n.t.bind(i18n))).toMatch(/[a-z]/);
  });
});
