import { forceReflow, applyBodyClass } from './styleUtils';

describe('styleUtils', () => {
  test('forceReflow reads offsetHeight', () => {
    const el = document.createElement('div');
    const spy = jest.spyOn(el, 'offsetHeight', 'get').mockReturnValue(0);
    forceReflow(el);
    expect(spy).toHaveBeenCalled();
  });

  test('applyBodyClass adds and removes class on body', () => {
    const cleanup = applyBodyClass('test-class');
    expect(document.body.classList.contains('test-class')).toBe(true);
    cleanup();
    expect(document.body.classList.contains('test-class')).toBe(false);
  });
});
