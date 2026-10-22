/**
 * Pod summary bodies, kept prose.
 *
 * The summary producers ask a model for `{"summary":"...","highlights":[...]}`
 * under a token cap. A capped reply stops mid-string, and
 * `{"summary":"Chat was mostly` is a valid PREFIX of JSON: `JSON.parse` fails,
 * a closing-brace search finds nothing, and a naive fallback stores the
 * envelope itself as the summary body. Every reader of the summary then shows
 * raw JSON where a recap belongs (#2406).
 *
 * The prose survives the truncation; only the envelope is lost. So recover the
 * prose, and refuse to hand back anything that still looks like an envelope.
 * Callers have a prose fallback and should use it.
 */

const JSON_ENVELOPE = /^(?:```|[[{])/;
const SUMMARY_KEY = /"summary"\s*:\s*"((?:\\.|[^"\\])*)/;

const looksLikeJsonEnvelope = (value) => JSON_ENVELOPE.test(String(value || '').trim());

const stripCodeFence = (raw) => String(raw || '')
  .trim()
  .replace(/^```[a-zA-Z]*\s*/, '')
  .replace(/```$/, '')
  .trim();

const parseJsonBlock = (raw) => {
  const text = stripCodeFence(raw);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

const unescapeJsonString = (value) => {
  // A reply cut off inside an escape leaves a dangling backslash, which is not
  // a parsable string on its own.
  const body = String(value || '').replace(/\\+$/, '');
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return body
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
};

/**
 * Pull the `summary` value out of a JSON envelope that no parser will accept,
 * including one truncated mid-sentence. Returns null when there is no such key.
 */
const salvageSummaryProse = (raw) => {
  const text = stripCodeFence(raw);
  const match = text.match(SUMMARY_KEY);
  if (!match) return null;

  const prose = unescapeJsonString(match[1]).trim();
  if (!prose) return null;

  // When the match ran to the end of the reply the last sentence is severed
  // mid-word. Cut back to the last sentence that completed, as long as that
  // keeps most of what the model said.
  const ranToEnd = text.indexOf(match[0]) + match[0].length >= text.length;
  if (!ranToEnd) return prose;
  const lastEnd = Math.max(
    prose.lastIndexOf('.'),
    prose.lastIndexOf('!'),
    prose.lastIndexOf('?'),
    prose.lastIndexOf('\n'),
  );
  const trimmed = lastEnd > 0 ? prose.slice(0, lastEnd + 1).trim() : '';
  return trimmed.length >= prose.length * 0.4 ? trimmed : prose;
};

const formatHighlights = (highlights) => {
  const lines = Array.isArray(highlights)
    ? highlights.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 5)
    : [];
  return lines.length
    ? lines.map((line) => `- ${line}`).join('\n')
    : '- No major developments in this window.';
};

/**
 * Turn one model reply into a pod chat summary, or null when nothing prose-like
 * can be recovered. Never returns a body that starts a JSON envelope.
 */
const podSummaryFromLlmReply = (raw, { messageCount = 0, maxLength = 700 } = {}) => {
  const text = stripCodeFence(raw);
  if (!text) return null;

  const parsed = parseJsonBlock(text);
  const parsedSummary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';

  let body = null;
  if (parsedSummary) {
    // A well-formed reply is kept whole; the cap below is for recovered text.
    body = [parsedSummary, 'Highlights:', formatHighlights(parsed.highlights)].join('\n\n');
  } else {
    const salvaged = salvageSummaryProse(text);
    if (salvaged) {
      body = salvaged.slice(0, maxLength);
    } else if (!looksLikeJsonEnvelope(text)) {
      // The model ignored the JSON contract and just wrote prose. Fine.
      body = text.slice(0, maxLength);
    }
  }

  if (!body) return null;
  body = body.trim();
  if (!body || looksLikeJsonEnvelope(body)) return null;

  return {
    type: 'chat-summary',
    source: 'pod',
    sourceLabel: 'Commonly',
    channel: 'pod-chat',
    messageCount,
    summary: body,
  };
};

module.exports = {
  looksLikeJsonEnvelope,
  parseJsonBlock,
  salvageSummaryProse,
  podSummaryFromLlmReply,
};
