export const scrollToElementById = (
  elementId: string,
  highlightClass: string,
  duration = 1500,
): ReturnType<typeof setTimeout> | null => {
  const el = document.getElementById(elementId);
  if (!el) return null;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  el.classList.add(highlightClass);
  return setTimeout(() => el.classList.remove(highlightClass), duration);
};
