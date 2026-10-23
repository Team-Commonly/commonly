import i18n, { i18nReady } from '../../i18n';
import { localizeRelativeTime, localizeWindow } from './localizeRelativeTime';

// TASK-353: a past event a few seconds ahead of the browser clock used to read
// "1m from now" (round(0.5) === 1). Sub-minute skew must read as "just now",
// while a genuinely future event a minute or more ahead still reads as future.
describe('localizeRelativeTime future skew', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  const render = async (offsetMs: number) => {
    const now = Date.parse('2026-10-23T07:30:00.000Z');
    const date = new Date(now - offsetMs).toISOString();
    await i18n.changeLanguage('en');
    const en = localizeRelativeTime(date, i18n.t.bind(i18n), { now });
    await i18n.changeLanguage('zh-CN');
    const zh = localizeRelativeTime(date, i18n.t.bind(i18n), { now });
    return { en, zh };
  };

  test('a timestamp under a minute ahead of the clock reads just now, in both locales', async () => {
    // offset is negative: the event is ahead of the browser clock.
    await expect(render(-30_000)).resolves.toMatchObject({ en: 'just now', zh: '刚刚' });
    await expect(render(-1)).resolves.toMatchObject({ en: 'just now', zh: '刚刚' });
  });

  test('a timestamp a minute or more ahead still reads as future', async () => {
    await expect(render(-3 * 60_000)).resolves.toMatchObject({ en: '3m from now' });
    await expect(render(-3 * 60_000)).resolves.toMatchObject({ zh: expect.not.stringMatching(/刚刚/) });
  });
});

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
