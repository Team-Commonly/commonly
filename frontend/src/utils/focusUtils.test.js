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
