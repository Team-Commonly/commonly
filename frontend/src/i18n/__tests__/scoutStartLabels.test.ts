import { act } from '@testing-library/react';
import i18n, { i18nReady, LANGUAGE_STORAGE_KEY } from '..';

// TASK-550: Scout's welcome starts are sent to Scout by their English labels
// (backend/config/native-agents/scout.ts), so only the displayed text is
// translated, by id. Every id the welcome can offer needs a zh-CN label.
const START_IDS = ['connect-agent', 'start-pod', 'run-hosted'];

describe('Scout welcome start labels', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  afterAll(async () => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it.each(START_IDS)('shows a zh-CN label for %s with no English left in it', (id) => {
    const key = `podChat.starts.labels.${id}`;
    const zh = i18n.t(key, { lng: 'zh-CN' });
    expect(zh).not.toBe(i18n.t(key, { lng: 'en' }));
    // Short product terms such as "pod" may stay in Latin letters; longer English words may not.
    expect(zh).not.toMatch(/[A-Za-z]{4,}/);
  });

  it('keeps the English label Scout reads when the language is English', () => {
    expect(i18n.t('podChat.starts.labels.connect-agent', { lng: 'en' })).toBe('Connect an agent I already use');
    expect(i18n.t('podChat.starts.labels.start-pod', { lng: 'en' })).toBe('Start a pod for a project');
  });
});
