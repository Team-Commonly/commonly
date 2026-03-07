/**
 * Scroll a DOM element into view and briefly highlight it.
 *
 * @param {string} elementId - The element id attribute value.
 * @param {string} highlightClass - CSS class to add for the flash animation.
 * @param {number} [duration=1500] - How long (ms) to keep the highlight class.
 * @returns {ReturnType<typeof setTimeout> | null} The timeout handle, or null if element not found.
 */
export const scrollToElementById = (elementId, highlightClass, duration = 1500) => {
  const el = document.getElementById(elementId);
  if (!el) return null;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  el.classList.add(highlightClass);
  return setTimeout(() => el.classList.remove(highlightClass), duration);
};
