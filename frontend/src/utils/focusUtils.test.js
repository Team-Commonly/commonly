import * as focusUtils from './focusUtils';
const { blurActiveElement, setupFocusManagement } = focusUtils;

describe('focusUtils', () => {
  test('blurActiveElement calls blur on active element', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const spy = jest.spyOn(input, 'blur');
    blurActiveElement();
    expect(spy).toHaveBeenCalled();
    input.remove();
  });

  test('setupFocusManagement listens for Escape key', () => {
    setupFocusManagement();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(event);
    expect(document.activeElement).not.toBe(input);
    input.remove();
  });
});

test('setupFocusManagement blurs on outside click', () => {
  setupFocusManagement();
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  const event = new MouseEvent('mousedown', { bubbles: true });
  document.body.dispatchEvent(event);
  expect(document.activeElement).not.toBe(input);
  menu.remove();
  input.remove();
});
