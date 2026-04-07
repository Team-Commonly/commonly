export const blurActiveElement = (): void => {
  if (document.activeElement) {
    (document.activeElement as HTMLElement).blur();
  }
};

export const setupFocusManagement = (): void => {
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      blurActiveElement();
    }
  });

  document.addEventListener('mousedown', (event: MouseEvent) => {
    const menus = document.querySelectorAll('[role="menu"]');
    const dialogs = document.querySelectorAll('[role="dialog"]');

    if (menus.length > 0 || dialogs.length > 0) {
      const isOutside =
        Array.from(menus).every((menu) => !menu.contains(event.target as Node)) &&
        Array.from(dialogs).every((dialog) => !dialog.contains(event.target as Node));

      if (isOutside) {
        blurActiveElement();
      }
    }
  });
};
