export const forceReflow = (element: HTMLElement | null | undefined): void => {
  if (element) {
    void element.offsetHeight;
  }
};

export const reloadStylesheets = (): void => {
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
  links.forEach((link) => {
    const href = link.getAttribute('href');
    if (href) {
      const newHref = href.includes('?')
        ? `${href.split('?')[0]}?t=${new Date().getTime()}`
        : `${href}?t=${new Date().getTime()}`;

      const newLink = document.createElement('link');
      newLink.rel = 'stylesheet';
      newLink.href = newHref;
      document.head.appendChild(newLink);

      setTimeout(() => {
        try {
          link.parentNode?.removeChild(link);
        } catch (e) {
          console.error('Error removing old stylesheet:', e);
        }
      }, 100);
    }
  });
};

export const applyStylesToElements = (selector: string): void => {
  const elements = document.querySelectorAll<HTMLElement>(selector);
  elements.forEach((el) => {
    if (el) {
      forceReflow(el);
      el.classList.add('style-applied');
    }
  });
};

export const applyBodyClass = (className: string): () => void => {
  document.body.classList.add(className);
  return () => document.body.classList.remove(className);
};

export const forceImmediateStyleApplication = (): void => {
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
  forceImmediateStyleApplication,
};

export default styleUtils;
