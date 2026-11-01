import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import V2ThemeSwitch from '../components/V2ThemeSwitch';
import useV2ThemePref from '../hooks/useV2ThemePref';
import { setV2Theme, V2_THEME_KEY } from '../utils/theme';

// TASK-740 (D224): the rail switch writes the one stored theme preference that
// Settings > Theme reads, and a change made elsewhere moves the switch.

const Probe: React.FC = () => <span data-testid="pref">{useV2ThemePref()}</span>;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-v2-theme');
});

describe('V2ThemeSwitch', () => {
  test('a click stores the same key and html attribute as Settings > Theme', () => {
    render(<><V2ThemeSwitch /><Probe /></>);
    fireEvent.click(screen.getByRole('button', { name: /dark/i }));
    expect(window.localStorage.getItem(V2_THEME_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-v2-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: /dark/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /light/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('pref')).toHaveTextContent('dark');
  });

  test('a preference set elsewhere moves the switch', () => {
    render(<V2ThemeSwitch />);
    act(() => setV2Theme('light'));
    expect(screen.getByRole('button', { name: /light/i })).toHaveAttribute('aria-pressed', 'true');
  });

  test('the bar variant is the small 390 switch, the rail one is the column', () => {
    const { container, rerender } = render(<V2ThemeSwitch variant="bar" />);
    expect(container.firstElementChild).toHaveClass('seg', 'seg--ic', 'seg--sm');
    rerender(<V2ThemeSwitch />);
    expect(container.firstElementChild).toHaveClass('seg--rail');
  });

  test('in Auto, an OS light/dark flip moves the switch', () => {
    let dark = false;
    let fire: () => void = () => {};
    const original = window.matchMedia;
    window.matchMedia = jest.fn().mockImplementation(() => ({
      get matches() { return dark; },
      addEventListener: (_: string, cb: () => void) => { fire = cb; },
      removeEventListener: jest.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      render(<V2ThemeSwitch />);
      expect(screen.getByRole('button', { name: /light/i })).toHaveAttribute('aria-pressed', 'true');
      act(() => { dark = true; fire(); });
      expect(screen.getByRole('button', { name: /dark/i })).toHaveAttribute('aria-pressed', 'true');
    } finally {
      window.matchMedia = original;
    }
  });
});
