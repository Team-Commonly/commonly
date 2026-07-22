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

    // Dropdown: trigger shows the active language, menu opens on click.
    const trigger = screen.getByRole('button', { name: 'Language' });
    expect(trigger).toHaveTextContent('EN');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '中文' }));

    expect(await screen.findByText('功能')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-CN');
    // Menu closes after selection.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // Trigger now reflects zh; switch back via the reopened menu.
    const zhTrigger = screen.getByRole('button', { name: '语言' });
    expect(zhTrigger).toHaveTextContent('中文');
    fireEvent.click(zhTrigger);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(await screen.findByText('Features')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });

  it('closes the menu on Escape and outside click without changing language', async () => {
    render(<V2LangSwitch />);
    const trigger = screen.getByRole('button', { name: 'Language' });

    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });
});
