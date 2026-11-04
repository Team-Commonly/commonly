// D245: the optional message contract an agent may attach to a post — a
// one-line `summary` and a `kind`. Warn-only: nothing here refuses a post.
// A value that breaks a rule is dropped or repaired, and a warning says which.
//
// The summary is agent-authored text, so it takes the same sanitizer as the
// content (sentinels, leakage). It is stored beside the content and is never
// read for @mentions: the mention parsers read `content`/`text` only, so a
// summary cannot address anyone a second time.

export const MESSAGE_KINDS = ['answer', 'result', 'progress', 'ask', 'fyi', 'error'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

// Counted in code points, not UTF-16 units, so a cut never splits an emoji
// or a surrogate pair.
export const SUMMARY_MAX_CHARS = 120;

export type ContractWarningCode =
  | 'summary_not_string'
  | 'summary_newline'
  | 'summary_empty'
  | 'summary_truncated'
  | 'kind_unknown';

export interface ContractWarning {
  code: ContractWarningCode;
  message: string;
}

export interface MessageContract {
  summary: string | null;
  kind: MessageKind | null;
  warnings: ContractWarning[];
}

const KIND_SET: ReadonlySet<string> = new Set(MESSAGE_KINDS);

export const normalizeMessageContract = (
  input: { summary?: unknown; kind?: unknown },
  sanitize: (text: string) => string,
): MessageContract => {
  const warnings: ContractWarning[] = [];
  let summary: string | null = null;
  let kind: MessageKind | null = null;

  const rawSummary = input.summary;
  if (rawSummary !== undefined && rawSummary !== null) {
    if (typeof rawSummary !== 'string') {
      warnings.push({ code: 'summary_not_string', message: 'summary must be a string; it was not stored.' });
    } else if (rawSummary.trim()) {
      let text = rawSummary;
      if (/[\r\n]/.test(text)) {
        text = text.replace(/\s*[\r\n]+\s*/g, ' ');
        warnings.push({ code: 'summary_newline', message: 'summary is one line; its line breaks became spaces.' });
      }
      text = String(sanitize(text) || '').trim();
      if (!text) {
        warnings.push({ code: 'summary_empty', message: 'summary was empty after cleanup; it was not stored.' });
      } else {
        // The cut runs after the sanitizer, so it can split a backticked
        // span. That is safe only because a stored summary is never sanitized
        // again; re-sanitizing it on read would need the cut to move first.
        const points = Array.from(text);
        if (points.length > SUMMARY_MAX_CHARS) {
          text = points.slice(0, SUMMARY_MAX_CHARS).join('').trimEnd();
          warnings.push({
            code: 'summary_truncated',
            message: `summary is at most ${SUMMARY_MAX_CHARS} characters; it was cut to fit.`,
          });
        }
        summary = text;
      }
    }
  }

  const rawKind = input.kind;
  if (rawKind !== undefined && rawKind !== null) {
    const normalized = typeof rawKind === 'string' ? rawKind.trim().toLowerCase() : '';
    if (KIND_SET.has(normalized)) {
      kind = normalized as MessageKind;
    } else {
      warnings.push({
        code: 'kind_unknown',
        message: `kind must be one of ${MESSAGE_KINDS.join(', ')}; it was not stored.`,
      });
    }
  }

  return { summary, kind, warnings };
};
