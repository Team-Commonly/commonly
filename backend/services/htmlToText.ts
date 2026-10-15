/**
 * Reduce an HTML document to its readable text, for a page fetched on an
 * agent's behalf (`getFromPublicAddress`). The result goes into a model turn,
 * so the goal is the words a person would read, not a faithful rendering:
 *
 *   - script, style, noscript, template, svg, iframe, object and head content
 *     is dropped whole, and so are comments, because none of it is page text;
 *   - block-level boundaries become line breaks so paragraphs stay apart, and
 *     empty lines are dropped, so the text is one non-empty line per block;
 *   - every remaining tag is removed, the common named entities and every
 *     numeric entity are decoded, and runs of whitespace are collapsed.
 *
 * This is a reducer, not a sanitizer. Its output is plain text and is never
 * rendered as HTML anywhere; callers that need safety from the text's meaning
 * get it from the untrusted-content marker and the turn's narrowing, not here.
 */

const DROPPED_ELEMENTS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'head'];

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
};

const MAX_CODE_POINT = 0x10ffff;

const decodeNumeric = (digits: string, radix: number): string => {
  const code = parseInt(digits, radix);
  // Surrogates and out-of-range values are not characters; NUL is not text.
  if (!Number.isFinite(code) || code <= 0 || code > MAX_CODE_POINT || (code >= 0xd800 && code <= 0xdfff)) return '';
  return String.fromCodePoint(code);
};

export const decodeEntities = (text: string): string => text.replace(
  /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});/gi,
  (whole, body: string) => {
    if (body[0] === '#') {
      return body[1] === 'x' || body[1] === 'X' ? decodeNumeric(body.slice(2), 16) : decodeNumeric(body.slice(1), 10);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  },
);

export const htmlToText = (html: string): string => {
  let text = html.replace(/<!--[\s\S]*?(-->|$)/g, ' ');
  for (const tag of DROPPED_ELEMENTS) {
    // An unclosed element runs to the end of the input, as a browser would treat it.
    // `[^<>]*`, not `[^>]*`: a "<" that never closes must not send the opener
    // scanning to the end of the input once per "<", which is quadratic.
    text = text.replace(new RegExp(`<${tag}\\b[^<>]*>[\\s\\S]*?(</${tag}\\s*>|$)`, 'gi'), ' ');
  }
  text = text.replace(/<\/?([a-z][a-z0-9-]*)\b[^<>]*>/gi, (_tag, name: string) => (
    BLOCK_TAGS.has(name.toLowerCase()) ? '\n' : ' '
  ));
  // A stray '<' that never closed a tag is text, not markup; leave it.
  text = decodeEntities(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\r\u00a0]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
};
