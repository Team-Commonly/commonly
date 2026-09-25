import fs from 'fs';
import path from 'path';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../../context/AuthContext';
import V2LandingPage from '../V2LandingPage';

/**
 * TASK-154. The self-host command is 721px wide inside a 340px box at 390, so 37
 * of 86 characters showed and `cd commonly && ./install.sh` was entirely
 * off-screen (ux-lead, measured on the live hero). The Copy control is what
 * makes the hidden half reachable, so these tests pin the three things that make
 * it work rather than the markup that draws it:
 *
 *   1. the click writes SELF_HOST_COMMAND exactly — read out of the component
 *      rather than restated, so the constant stays single-sourced with the
 *      README guard #1866 added (`$` and any truncation are render-only);
 *   2. the button is OUTSIDE the scrolling region, which is the whole fix — a
 *      Copy that scrolls away is not a fix;
 *   3. a denied clipboard selects the command instead of doing nothing.
 *
 * jsdom has no layout engine, so the width claims above are not re-measured
 * here; what is asserted is the structure that addresses them. The visual gate
 * is ux-lead's, at 1200, 390 and zh-CN 390, with the clipboard read in a real
 * browser.
 */

jest.mock('axios');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;

const LANDING_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'V2LandingPage.tsx'), 'utf8');
const LANDING_CSS = fs.readFileSync(path.join(__dirname, '..', 'v2-landing.css'), 'utf8');

/** The shipped constant, read from source — never a copy of it. */
const selfHostCommand = (): string => {
  const match = /const SELF_HOST_COMMAND = '([^']+)'/.exec(LANDING_SOURCE);
  if (!match) throw new Error('SELF_HOST_COMMAND is no longer a single-quoted literal in V2LandingPage.tsx');
  return match[1];
};

/**
 * One declaration block, matched on a LINE-START selector. The ` {` is what
 * separates `.v2-landing__install {` from `.v2-landing__install-scroll {` and
 * from any indented media-block copy of the same name.
 */
const ruleBody = (selector: string): string => {
  const at = LANDING_CSS.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`${selector} is no longer a top-level rule in v2-landing.css`);
  const open = LANDING_CSS.indexOf('{', at);
  return LANDING_CSS.slice(open + 1, LANDING_CSS.indexOf('}', open));
};

/** A whole at-rule block, matched INCLUDING its trailing `{` — a bare
 *  '@media (max-width: 760px)' is a text prefix of a longer query. */
const mediaAt = (atRule: string): string => {
  const at = LANDING_CSS.indexOf(`${atRule} {`);
  if (at < 0) throw new Error(`${atRule} is no longer declared in v2-landing.css`);
  const open = LANDING_CSS.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < LANDING_CSS.length; i += 1) {
    if (LANDING_CSS[i] === '{') depth += 1;
    if (LANDING_CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return LANDING_CSS.slice(open + 1, i);
    }
  }
  throw new Error(`${atRule} is unbalanced in v2-landing.css`);
};

const renderLanding = () => render(
  <MemoryRouter>
    <V2LandingPage />
  </MemoryRouter>,
);

const installBox = () => document.querySelector('.v2-landing__install') as HTMLElement;
const installButton = () => screen.getByRole('button', { name: 'Copy install command' });

describe('landing install line copy control (TASK-154)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ isAuthenticated: false });
    mockAxiosGet.mockResolvedValue({ data: {} });
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
  });

  it('writes the shipped command exactly, with no prompt and no trailing newline', () => {
    renderLanding();
    fireEvent.click(installButton());

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(selfHostCommand());
    expect(selfHostCommand()).not.toContain('$');
  });

  it('confirms in place for 1.5s, then returns to Copy', async () => {
    jest.useFakeTimers();
    try {
      renderLanding();
      const button = installButton();
      expect(button).toHaveTextContent('Copy');

      // The write is awaited before the label swaps, so the flush is the point:
      // a click that announced "Copied" before the clipboard resolved would be
      // claiming an outcome it had not got yet.
      await act(async () => { fireEvent.click(button); });
      expect(button).toHaveTextContent('Copied');
      // Polite announcement for the state the button's own label carries: a
      // label swap on a focused button is not reliably read out.
      expect(screen.getByRole('status')).toHaveTextContent('Copied');

      act(() => { jest.advanceTimersByTime(1500); });
      expect(button).toHaveTextContent('Copy');
      expect(screen.getByRole('status')).toHaveTextContent('');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the control out of the scrolling region it exists to compensate for', () => {
    renderLanding();
    const box = installBox();
    const button = installButton();
    const scroll = box.querySelector('.v2-landing__install-scroll') as HTMLElement;

    // The scroll region is the command's wrapper, and it is where the overflow
    // lives — so the button cannot be inside it, or it scrolls out of reach.
    expect(scroll).not.toBeNull();
    expect(scroll.contains(button)).toBe(false);
    expect(button.parentElement).toBe(box);
    expect(scroll).toContainElement(document.querySelector('.v2-landing__install-cmd') as HTMLElement);

    // The CSS has to match the markup: scroll on the wrapper, not on the box.
    expect(ruleBody('.v2-landing__install')).not.toContain('overflow-x');
    expect(ruleBody('.v2-landing__install-scroll')).toContain('overflow-x: auto');
  });

  it('keeps the line 46px tall and gives the pill a 44px target on phones', () => {
    // The pill is taller than the command text, so the box's height is a
    // decision, not a consequence — and it is pinned as one.
    const box = ruleBody('.v2-landing__install');
    expect(box).toContain('min-height: 46px');
    expect(box).toContain('padding: 8px 16px');

    const phone = mediaAt('@media (max-width: 760px)');
    expect(phone).toContain('.v2-landing__install-copy { position: relative; }');
    expect(phone).toContain('height: 44px');
    // Transparent extension, so the visible pill keeps its size.
    expect(phone).not.toContain('min-height: 44px');
  });

  it('selects the command when the clipboard is unavailable, never a silent no-op', async () => {
    const selected: string[] = [];
    const range = {
      selectNodeContents: (node: Node) => { selected.push((node as HTMLElement).textContent || ''); },
    };
    (navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    window.getSelection = jest.fn().mockReturnValue({
      removeAllRanges: jest.fn(),
      addRange: jest.fn(),
    }) as unknown as typeof window.getSelection;
    document.createRange = jest.fn().mockReturnValue(range) as unknown as typeof document.createRange;

    renderLanding();
    fireEvent.click(installButton());

    // The click still has an outcome the visitor can act on: the text is
    // selected, so the OS copy menu works.
    await act(async () => { await Promise.resolve(); });
    expect(selected).toEqual([selfHostCommand()]);
    expect(installButton()).toHaveTextContent('Copy');
  });
});
