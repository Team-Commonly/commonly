/**
 * Utility functions for handling styles and ensuring they're applied immediately
 */

/**
 * Forces a reflow to ensure styles are applied immediately
 * @param {HTMLElement} element - The element to force reflow on
 */
export const forceReflow = (element) => {
  if (element) {
    void element.offsetHeight;
  }
};

/**
 * Forces all stylesheets to reload
 */
export const reloadStylesheets = () => {
  const links = document.querySelectorAll('link[rel="stylesheet"]');
  links.forEach(link => {
    const href = link.getAttribute('href');
    if (href) {
      const newHref = href.includes('?') 
        ? href.split('?')[0] + '?t=' + new Date().getTime()
        : href + '?t=' + new Date().getTime();
      
      const newLink = document.createElement('link');
      newLink.rel = 'stylesheet';
      newLink.href = newHref;
      document.head.appendChild(newLink);
      
      // Remove the old stylesheet after a short delay
      setTimeout(() => {
        try {
          link.parentNode.removeChild(link);
        } catch (e) {
          console.error('Error removing old stylesheet:', e);
        }
      }, 100);
    }
  });
};

/**
 * Applies styles to elements matching the selector
 * @param {string} selector - CSS selector for elements to apply styles to
 */
export const applyStylesToElements = (selector) => {
  const elements = document.querySelectorAll(selector);
  elements.forEach(el => {
    if (el) {
      forceReflow(el);
      el.classList.add('style-applied');
    }
  });
};

/**
 * Applies a class to the body element and returns a cleanup function
 * @param {string} className - Class to add to the body
 * @returns {Function} Cleanup function to remove the class
 */
export const applyBodyClass = (className) => {
  document.body.classList.add(className);
  return () => document.body.classList.remove(className);
};

/**
 * Forces immediate style application by temporarily hiding the body
 */
export const forceImmediateStyleApplication = () => {
  document.body.style.visibility = 'hidden';
  setTimeout(() => {
    document.body.style.visibility = '';
  }, 0);
};

const styleUtils = {
  forceReflow,
  reloadStylesheets,
  applyStylesToElements,
  applyBodyClass,
  forceImmediateStyleApplication
};

export default styleUtils; 