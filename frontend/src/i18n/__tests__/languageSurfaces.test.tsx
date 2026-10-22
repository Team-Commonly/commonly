import React from 'react';
import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n, { i18nReady, LANGUAGE_REGISTRY } from '..';
import V2LangSwitch from '../../v2/components/V2LangSwitch';

// The rail menu and the landing header menu both render V2LangSwitch, so the
// component is where "the menu comes from the registry" is enforced: it has to
// offer exactly the registry's languages, in registry order, under the
// registry's labels. The registry's own membership is pinned in i18n.test.ts,
// and Settings > Language is covered in V2SettingsPage.test.tsx.
const LABELS = LANGUAGE_REGISTRY.map(({ label }) => label);

// The active option carries a check mark that is aria-hidden, so read the
// option text and drop it rather than matching each label twice.
const optionLabels = (menu: HTMLElement): (string | null)[] => within(menu)
  .getAllByRole('option')
  .map((option) => option.textContent?.replace(/✓/g, '') ?? null);

describe('language surfaces', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  afterAll(async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('the rail and landing menus both render the shared switcher', () => {
    const readSource = (relative: string) => fs.readFileSync(path.join(__dirname, relative), 'utf8');

    for (const relative of ['../../v2/components/V2NavRail.tsx', '../../v2/landing/V2LandingPage.tsx']) {
      const source = readSource(relative);
      expect(source).toMatch(/<V2LangSwitch[\s/>]/);
    }
  });

  test('the switcher offers every registered language and selects each one', async () => {
    render(<V2LangSwitch />);

    for (const { code, label } of LANGUAGE_REGISTRY) {
      fireEvent.click(screen.getByRole('button', { expanded: false }));
      const menu = screen.getByRole('listbox');
      expect(optionLabels(menu)).toEqual(LABELS);
      fireEvent.click(within(menu).getByRole('button', { name: label }));

      await waitFor(() => expect(i18n.resolvedLanguage).toBe(code));
      expect(document.documentElement.lang).toBe(code);
      expect(screen.queryByRole('listbox')).toBeNull();
    }
  });
});
