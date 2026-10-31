import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import i18n, { i18nReady, LANGUAGE_REGISTRY, LANGUAGE_STORAGE_KEY } from '../../i18n';
import { useAuth } from '../../context/AuthContext';
import V2LangSwitch from '../components/V2LangSwitch';
import V2NavRail from '../components/V2NavRail';
import V2LandingPage from '../landing/V2LandingPage';

jest.mock('axios');
jest.mock('../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));
jest.mock('../hooks/useV2PodAttention', () => ({
  useV2PodAttention: () => ({ attentionByPod: {}, totalNeedsYou: 0 }),
}));
jest.mock('../components/V2AccountMenu', () => {
  const MockV2AccountMenu = () => <div>account menu</div>;
  MockV2AccountMenu.displayName = 'MockV2AccountMenu';
  return { __esModule: true, default: MockV2AccountMenu };
});
jest.mock('../components/V2FeedbackMenu', () => {
  const MockV2FeedbackMenu = () => <div>feedback menu</div>;
  MockV2FeedbackMenu.displayName = 'MockV2FeedbackMenu';
  return { __esModule: true, default: MockV2FeedbackMenu };
});

// Written out on purpose, NOT derived from LANGUAGE_REGISTRY. TASK-318 left one
// registry feeding the switcher, Settings and <html lang>, and its own check
// compared SUPPORTED_LANGUAGES to the same map that defines it — an assertion
// that moves with whatever it is meant to pin (Sprint Review 5611893458).
// Changing the shipped languages has to fail here first, so that whoever adds
// one is sent through every surface below.
const EXPECTED_LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'zh-CN', label: '中文', short: '中文' },
];

const mockUseAuth = useAuth as jest.Mock;
const mockAxiosGet = axios.get as jest.Mock;

// The trigger and menu are labelled through i18n, so their accessible names
// change with the active language. Role alone is the stable handle here.
const openSwitcherMenu = (trigger: HTMLElement) => {
  fireEvent.click(trigger);
  return screen.getByRole('listbox');
};

describe('language surfaces derive from the registry', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ isAuthenticated: false, user: null });
    mockAxiosGet.mockResolvedValue({ data: {} });
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  afterAll(async () => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    await i18n.changeLanguage('en');
  });

  it('ships exactly the pinned languages', () => {
    expect(LANGUAGE_REGISTRY.map(({ code, label, short }) => ({ code, label, short })))
      .toEqual(EXPECTED_LANGUAGES);
  });

  it('offers every registered language in the switcher menu, and nothing else', () => {
    render(<V2LangSwitch />);

    const options = within(openSwitcherMenu(screen.getByRole('button', { name: 'Language' })))
      .getAllByRole('option');
    // Accessible names, not textContent: the active row carries a decorative
    // aria-hidden check mark, and stripping that glyph here would couple this
    // assertion to CHECK_ICON in the component (gate on #2436). Name
    // computation ignores aria-hidden content, so the strip is unnecessary.
    expect(options).toHaveLength(EXPECTED_LANGUAGES.length);
    EXPECTED_LANGUAGES.forEach(({ label }, index) => {
      expect(options[index]).toHaveAccessibleName(label);
    });
  });

  it('switches to each registered language from the switcher menu', async () => {
    render(<V2LangSwitch />);

    const trigger = screen.getByRole('button', { name: 'Language' });

    for (const { code, label, short } of EXPECTED_LANGUAGES) {
      // The trigger click must settle before the option is queried, so opening
      // the menu stays outside act() — fireEvent already flushes it.
      const option = within(openSwitcherMenu(trigger)).getByRole('button', { name: label });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        fireEvent.click(option);
      });
      expect(i18n.resolvedLanguage).toBe(code);
      expect(document.documentElement.lang).toBe(code);
      expect(trigger).toHaveTextContent(short);
    }
  });

  it('keeps the language menu on the rail', () => {
    render(
      <MemoryRouter>
        <V2NavRail needsYouCount={0} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument();
  });

  it('keeps the language menu on the landing nav', () => {
    render(
      <MemoryRouter>
        <V2LandingPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('button', { name: 'Language' }).length).toBeGreaterThan(0);
  });
});
