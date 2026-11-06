// @ts-nocheck
// The "i" hint must answer a desktop click. With a mouse, hovering opens it
// before the click lands, and the click used to toggle it shut under the cursor,
// so a click looked like it did nothing (D215 crawl, 2026-11-04).
import React from 'react';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import V2Hint from '../components/V2Hint';

const setup = () => {
  render(<V2Hint label="About this">Hint body</V2Hint>);
  const trigger = screen.getByRole('button', { name: 'About this' });
  return { trigger, wrap: trigger.parentElement };
};
const isOpen = (trigger) => trigger.getAttribute('aria-expanded') === 'true';
// jsdom has no PointerEvent, so pointerType has to be put on the event by hand.
const pointer = (type, element, pointerType) => {
  const event = createEvent[type](element);
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(element, event);
};
const mouseClick = (trigger) => {
  fireEvent.pointerDown(trigger);
  fireEvent.focus(trigger);
  fireEvent.click(trigger);
};

it('a mouse click after hovering keeps the hint open, and it stays open after the pointer leaves', () => {
  const { trigger, wrap } = setup();
  pointer('pointerOver', wrap, 'mouse');
  expect(isOpen(trigger)).toBe(true);
  mouseClick(trigger);
  expect(isOpen(trigger)).toBe(true);
  pointer('pointerOut', wrap, 'mouse');
  expect(isOpen(trigger)).toBe(true);
});

it('a second click closes it, and blur closes a pinned hint', () => {
  const { trigger, wrap } = setup();
  pointer('pointerOver', wrap, 'mouse');
  mouseClick(trigger);
  fireEvent.click(trigger);
  expect(isOpen(trigger)).toBe(false);

  pointer('pointerOver', wrap, 'mouse');
  mouseClick(trigger);
  fireEvent.blur(wrap, { relatedTarget: null });
  expect(isOpen(trigger)).toBe(false);
});

it('hover alone opens and closes it', () => {
  const { trigger, wrap } = setup();
  pointer('pointerOver', wrap, 'mouse');
  expect(isOpen(trigger)).toBe(true);
  pointer('pointerOut', wrap, 'mouse');
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
  pointer('pointerOver', wrap, 'mouse');
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger); // no focus event, as Safari and Firefox on macOS
  expect(isOpen(trigger)).toBe(true);
  expect(document.activeElement).toBe(trigger);
  pointer('pointerOut', wrap, 'mouse');
  expect(isOpen(trigger)).toBe(true);
  fireEvent.blur(wrap, { relatedTarget: document.body });
  expect(isOpen(trigger)).toBe(false);
});

const tap = (element) => {
  pointer('pointerDown', element, 'touch');
  fireEvent.click(element); // no focus event: iOS doesn't focus a tapped button
};

it('a tap holds it open through the mouse events iOS replays when the next tap lands elsewhere', () => {
  const { trigger, wrap } = setup();
  tap(trigger);
  expect(isOpen(trigger)).toBe(true);
  fireEvent.mouseEnter(wrap);
  fireEvent.mouseLeave(wrap);
  pointer('pointerOut', wrap, 'touch');
  expect(isOpen(trigger)).toBe(true);
});

it('a touch pointer passing over it does not open it', () => {
  const { trigger, wrap } = setup();
  pointer('pointerOver', wrap, 'touch');
  fireEvent.mouseEnter(wrap);
  expect(isOpen(trigger)).toBe(false);
});

it('a tap on something else reaches it first, then closes the hint', () => {
  const seen = [];
  render(
    <>
      <V2Hint label="About this">Hint body</V2Hint>
      <button
        type="button"
        onClick={() => seen.push(screen.getByRole('button', { name: 'About this' }).getAttribute('aria-expanded'))}
      >Rename</button>
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'About this' });
  tap(trigger);
  tap(screen.getByRole('button', { name: 'Rename' }));
  expect(seen).toEqual(['true']);
  expect(isOpen(trigger)).toBe(false);
});

it('a tap from a pen that cannot hover opens it, though the pointer enters and leaves before the click', () => {
  const { trigger, wrap } = setup();
  pointer('pointerOver', wrap, 'pen');
  pointer('pointerDown', trigger, 'pen');
  pointer('pointerOut', wrap, 'pen');
  fireEvent.click(trigger);
  expect(isOpen(trigger)).toBe(true);
});

it('hover opens it again after a click elsewhere closed a pinned hint', () => {
  const { trigger, wrap } = setup();
  pointer('pointerOver', wrap, 'mouse');
  mouseClick(trigger);
  pointer('pointerOut', wrap, 'mouse');
  fireEvent.click(document.body);
  expect(isOpen(trigger)).toBe(false);
  pointer('pointerOver', wrap, 'mouse');
  expect(isOpen(trigger)).toBe(true);
});

it('stops listening for clicks elsewhere when it closes and when it unmounts', () => {
  const add = jest.spyOn(document, 'addEventListener');
  const remove = jest.spyOn(document, 'removeEventListener');
  const clickListeners = (spy) => spy.mock.calls.filter(([type]) => type === 'click').map(([, listener]) => listener);
  const view = render(<V2Hint label="About this">Hint body</V2Hint>);
  const trigger = screen.getByRole('button', { name: 'About this' });
  tap(trigger);
  fireEvent.click(trigger);
  expect(isOpen(trigger)).toBe(false);
  tap(trigger);
  view.unmount();
  const added = clickListeners(add);
  expect(added.length).toBeGreaterThanOrEqual(2);
  added.forEach((listener) => expect(clickListeners(remove)).toContain(listener));
  add.mockRestore();
  remove.mockRestore();
});
