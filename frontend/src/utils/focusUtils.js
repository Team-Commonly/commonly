/**
 * Utility functions for managing focus in modals and menus
 * to prevent accessibility issues with aria-hidden
 */

// Remove focus from the active element
export const blurActiveElement = () => {
  if (document.activeElement) {
    document.activeElement.blur();
  }
};

// Add global event listeners for focus management
export const setupFocusManagement = () => {
  // For Material UI menus
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      blurActiveElement();
    }
  });
  
  // For click outside events
  document.addEventListener('mousedown', (event) => {
    const menus = document.querySelectorAll('[role="menu"]');
    const dialogs = document.querySelectorAll('[role="dialog"]');
    
    if (menus.length > 0 || dialogs.length > 0) {
      // Check if click is outside all menus and dialogs
      const isOutside = Array.from(menus).every(menu => !menu.contains(event.target)) &&
                        Array.from(dialogs).every(dialog => !dialog.contains(event.target));
      
      if (isOutside) {
        blurActiveElement();
      }
    }
  });
}; 