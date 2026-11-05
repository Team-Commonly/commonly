// @ts-nocheck
// The "i" hint must answer a desktop click. With a mouse, hovering opens it
// before the click lands, and the click used to toggle it shut under the cursor,
// so a click looked like it did nothing (D215 crawl, 2026-11-04).
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import V2Hint from '../components/V2Hint';

const setup = () => {
  render(<V2Hint label="About this">Hint body</V2Hint>);
  const trigger = screen.getByRole('button', { name: 'About this' });
  return { trigger, wrap: trigger.parentElement };
};
const isOpen = (trigger) => trigger.getAttribute('aria-expanded') === 'true';
const mouseClick = (trigger) => {
  fireEvent.pointerDown(trigger);
  fireEvent.focus(trigger);
  fireEvent.click(trigger);
};

it('a mouse click after hovering keeps the hint open, and it stays open after the pointer leaves', () => {
  const { trigger, wrap } = setup();
  fireEvent.mouseEnter(wrap);
  expect(isOpen(trigger)).toBe(true);
  mouseClick(trigger);
  expect(isOpen(trigger)).toBe(true);
  fireEvent.mouseLeave(wrap);
  expect(isOpen(trigger)).toBe(true);
});

it('a second click closes it, and blur closes a pinned hint', () => {
  const { trigger, wrap } = setup();
  fireEvent.mouseEnter(wrap);
  mouseClick(trigger);
  fireEvent.click(trigger);
  expect(isOpen(trigger)).toBe(false);

  fireEvent.mouseEnter(wrap);
  mouseClick(trigger);
  fireEvent.blur(wrap, { relatedTarget: null });
  expect(isOpen(trigger)).toBe(false);
});

it('hover alone opens and closes it', () => {
  const { trigger, wrap } = setup();
  fireEvent.mouseEnter(wrap);
  expect(isOpen(trigger)).toBe(true);
  fireEvent.mouseLeave(wrap);
  expect(isOpen(trigger)).toBe(false);
});

it('a tap with no hover opens it, and keyboard focus opens it until Escape', () => {
  const { trigger } = setup();
  mouseClick(trigger);
  expect(isOpen(trigger)).toBe(true);
  fireEvent.click(trigger);
  expect(isOpen(trigger)).toBe(false);

  fireEvent.focus(trigger);
  expect(isOpen(trigger)).toBe(true);
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(isOpen(trigger)).toBe(false);
});

it('in Safari, where a click does not focus the button, a pinned hint takes focus so blur can close it', () => {
  const { trigger, wrap } = setup();
  fireEvent.mouseEnter(wrap);
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger); // no focus event, as Safari and Firefox on macOS
  expect(isOpen(trigger)).toBe(true);
  expect(document.activeElement).toBe(trigger);
  fireEvent.mouseLeave(wrap);
  expect(isOpen(trigger)).toBe(true);
  fireEvent.blur(wrap, { relatedTarget: document.body });
  expect(isOpen(trigger)).toBe(false);
});
