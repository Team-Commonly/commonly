/**
 * The two escapes the backend uses, one copy each.
 *
 * `escapeRegExp` makes a string match itself literally inside a RegExp, for
 * a search, a mention match or a key prefix built from data.
 *
 * `escapeHtml` is for text placed into HTML element content or a quoted
 * attribute value, as the emails do. Telegram's HTML parse mode accepts only
 * `&amp;`, `&lt;` and `&gt;`, so telegramService keeps its own narrower escape.
 */
export const escapeRegExp = (value: unknown): string => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
