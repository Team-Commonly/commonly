import { localizeInstallableDescription } from './localizeInstallableDescription';

describe('localizeInstallableDescription', () => {
  const entry = {
    description: 'One Telegram chat, one pod.',
    descriptions: {
      en: 'One Telegram chat, one pod.',
      'zh-CN': '一个 Telegram 聊天，一个 Pod。',
    },
  };

  it('uses the app language map and keeps English as the fallback', () => {
    expect(localizeInstallableDescription(entry, 'zh-CN')).toBe('一个 Telegram 聊天，一个 Pod。');
    expect(localizeInstallableDescription(entry, 'en')).toBe('One Telegram chat, one pod.');
    expect(localizeInstallableDescription(entry, 'fr')).toBe('One Telegram chat, one pod.');
  });

  it('supports marketplace rows projected with only an English map', () => {
    expect(localizeInstallableDescription({ description: 'Marketplace copy', descriptions: { en: 'Marketplace copy' } }, 'zh-CN'))
      .toBe('Marketplace copy');
  });
});
