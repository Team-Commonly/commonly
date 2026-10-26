/**
 * Escape the five HTML-significant characters for text and attribute context.
 * null and undefined render as '' rather than the string "null".
 */
export const escapeHtml = (value: unknown): string => (value == null ? '' : String(value))
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
