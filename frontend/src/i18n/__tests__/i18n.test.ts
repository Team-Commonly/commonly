import { act } from '@testing-library/react';
import i18n, { i18nReady, LANGUAGE_REGISTRY, LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES } from '..';

describe('i18n configuration', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  beforeEach(async () => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  afterAll(async () => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await i18n.changeLanguage('en');
  });

  it('falls back to English when a zh-CN key is missing', () => {
    i18n.addResource('en', 'translation', 'test.fallbackOnly', 'English fallback');

    expect(i18n.t('test.fallbackOnly', { lng: 'zh-CN' })).toBe('English fallback');
  });

  it.each([
    ['podChat.newPod.label', 'New pod starter actions'],
    ['podChat.newPod.title', 'Your pod is ready'],
    ['podChat.newPod.inviteLinkLabel', 'Invite link for this pod'],
    ['podChat.newPod.runHere', 'Run it here'],
    ['podChat.newPod.bringOwn', 'Bring your own'],
    ['podsSidebar.discover.empty', 'No community pods to discover right now.'],
    ['podsSidebar.discover.joinedEmpty', "You haven't joined any community pods yet."],
    ['podsSidebar.discover.loadFailed', "Couldn't load community pods. Try again."],
    ['podsSidebar.discover.inviteRequired', 'This pod needs an invite link to join.'],
    ['podsSidebar.discover.joinFailed', "Couldn't join this pod. Try again."],
  ])('uses lowercase pod in %s', (key, expected) => {
    expect(i18n.t(key, { lng: 'en' })).toBe(expected);
  });

  it.each([
    [0, '1 · 0 agents', '1 member, 0 agents'],
    [1, '1 · 1 agent', '1 member, 1 agent'],
    [2, '1 · 2 agents', '1 member, 2 agents'],
  ])('pluralizes the compact pod header at %i agents', (count, visible, accessible) => {
    const members = i18n.t('podChat.header.members', { lng: 'en', count: 1 });
    const agents = i18n.t('podChat.header.agents', { lng: 'en', count });
    expect(i18n.t('podChat.header.compactMeta', { lng: 'en', members: 1, agents })).toBe(visible);
    expect(i18n.t('podChat.header.compactMetaAccessible', { lng: 'en', members, agents })).toBe(accessible);
  });

  it('keeps the Chinese compact count while naming it for assistive tech', () => {
    const members = i18n.t('podChat.header.members', { lng: 'zh-CN', count: 1 });
    const agents = i18n.t('podChat.header.agents', { lng: 'zh-CN', count: 1 });
    expect(i18n.t('podChat.header.compactMeta', { lng: 'zh-CN', members: 1, agents })).toBe('1 · 1个智能体');
    expect(i18n.t('podChat.header.compactMetaAccessible', { lng: 'zh-CN', members, agents })).toBe('1名成员，1个智能体');
  });

  it('uses the singular agent count in the Your Team header', () => {
    const meta = (lng: string, count: number) => i18n.t('yourTeam.head.meta', {
      lng, count, agents: count, working: 0, needsYou: 0,
    });
    expect(meta('en', 0)).toBe('0 agents · 0 working · 0 needs you');
    expect(meta('en', 1)).toBe('1 agent · 0 working · 0 needs you');
    expect(meta('en', 2)).toBe('2 agents · 0 working · 0 needs you');
    expect(meta('zh-CN', 1)).toBe('1个智能体 · 0个工作中 · 0个等你');
  });

  it('defaults to English when no stored supported language exists', async () => {
    const languages = jest.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en-US']);
    const language = jest.spyOn(window.navigator, 'language', 'get').mockReturnValue('en-US');
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await act(async () => {
      await i18n.changeLanguage();
    });

    expect(i18n.resolvedLanguage).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    languages.mockRestore();
    language.mockRestore();
  });

  it('uses each registered language for the document and i18next', async () => {
    // Pinned as a literal, not derived from LANGUAGE_REGISTRY: comparing the
    // list to the map that defines it passes however the map changes
    // (Sprint Review 5611893458 on #2399). v2/__tests__/languageSurfaces.test.tsx
    // carries the same pin for the three surfaces that read the registry.
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'zh-CN']);
    for (const { code } of LANGUAGE_REGISTRY) {
      await act(async () => { await i18n.changeLanguage(code); });
      expect(i18n.resolvedLanguage).toBe(code);
      expect(document.documentElement.lang).toBe(code);
    }
  });

  it('interpolates Phase 1B auth and invite chrome in both locales', () => {    expect(i18n.t('auth.oauth.continueWith', {
      lng: 'en',
      provider: 'GitHub',
    })).toBe('Continue with GitHub');
    expect(i18n.t('auth.oauth.continueWith', {
      lng: 'zh-CN',
      provider: 'GitHub',
    })).toBe('使用 GitHub 继续');
    expect(i18n.t('inviteRedeem.invitedTo', {
      lng: 'zh-CN',
      podName: 'Commonly HQ',
    })).toBe('你受邀加入 Commonly HQ');
  });

  it('keeps the verification copy glossary-clean in Simplified Chinese', () => {
    // lily-shen's zh-CN gate (2026-09-23, the eng lead's read under the
    // zh-cn-ui-localization skill, standing in for Sam's pass): "Pod" stays
    // English with half-width spaces, the purpose-clause calque 以…加入 is out,
    // and a Chinese sentence takes ，rather than an em dash. The banner and the
    // screen carry one sentence, so the two move together.
    const banner = i18n.t('auth.verificationBanner.message', { lng: 'zh-CN', email: 'new@example.com' });
    const screen = i18n.t('auth.register.success.checkEmailMessage', { lng: 'zh-CN', email: 'new@example.com' });

    expect(banner).toBe('验证邮箱后即可加入 Community Pod，链接已发送至 new@example.com。');
    expect(screen).toBe(banner);
    expect(i18n.t('auth.register.success.checkEmailTitle', { lng: 'zh-CN' })).toBe('欢迎加入');
    expect(`${banner}${screen}`).not.toMatch(/群组|—/);
  });

  it('uses a Chinese comma in the BYO machine hint', () => {
    const hint = i18n.t('agentByo.mode.machineHint', { lng: 'zh-CN' });
    expect(hint).toBe('在你已添加的电脑上运行，你的文件、你的 CLI');
    expect(hint).not.toContain('—');
  });
});
