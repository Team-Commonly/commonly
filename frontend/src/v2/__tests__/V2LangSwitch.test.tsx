import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import i18n, { i18nReady, LANGUAGE_STORAGE_KEY } from '../../i18n';
import V2LangSwitch from '../components/V2LangSwitch';

const LandingString: React.FC = () => {
  const { t } = useTranslation();
  return <div>{t('landing.nav.features')}</div>;
};

describe('V2LangSwitch', () => {
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

  it('switches a landing string, document language, and persisted preference', async () => {
    render(
      <>
        <V2LangSwitch />
        <LandingString />
      </>,
    );

    expect(screen.getByText('Features')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Simplified Chinese' }));

    expect(await screen.findByText('功能')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-CN');

    fireEvent.click(screen.getByRole('button', { name: '切换到英文' }));
    expect(await screen.findByText('Features')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });
});
