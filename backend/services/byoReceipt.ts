// D245 item 4: the receipt a BYO agent's computer reports with a reply — which
// adapter and model made it, how many turns, which tools, how long. Hosted
// replies have a run trace the server wrote (AgentRun); a BYO reply had
// nothing. This is the BYO side, and it is only ever what the agent's
// computer says: every stored receipt is stamped `source: 'self-reported'`,
// and a caller cannot set another source. Grant tool calls are recorded
// server-side (ToolCall) and stay the trustworthy part.
//
// Warn-only, like the message contract: a bad field is dropped and named in a
// warning, the rest is kept, and the post is never refused for it.
//
// Names are restricted to identifier characters so a receipt can carry no
// prose, markdown or markup into any surface that later shows it.

export const RECEIPT_LIMITS = Object.freeze({
  adapter: 40,
  model: 100,
  toolName: 80,
  tools: 50,
  turns: 1000,
  durationMs: 24 * 60 * 60 * 1000,
});

export type ReceiptWarningCode =
  | 'receipt_not_object'
  | 'receipt_unknown_field'
  | 'receipt_invalid_adapter'
  | 'receipt_invalid_model'
  | 'receipt_invalid_turns'
  | 'receipt_invalid_duration'
  | 'receipt_invalid_tools'
  | 'receipt_invalid_tool_name'
  | 'receipt_tools_truncated'
  | 'receipt_empty';

export interface ReceiptWarning {
  code: ReceiptWarningCode;
  message: string;
}

export interface ByoReceipt {
  adapter?: string;
  model?: string;
  turns?: number;
  tools?: string[];
  durationMs?: number;
  source: 'self-reported';
}

const KNOWN_FIELDS = new Set(['adapter', 'model', 'turns', 'tools', 'durationMs']);
const ADAPTER = /^[a-z0-9][a-z0-9._-]*$/i;
// Model ids and tool names: letters, digits and the separators real ones use
// (claude-opus-5-5, openai/gpt-5.6-sol, mcp__commonly__post, us.anthropic.x:0).
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

// A URL is all name characters, and a client that autolinks would render it as
// a link inside a tool-name chip; `://` never occurs in a real model id.
const isName = (value: unknown, pattern: RegExp, max: number): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= max && pattern.test(value)
  && !value.includes('://')
);

const isBoundedInt = (value: unknown, max: number): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
);

export const normalizeReceipt = (raw: unknown): { receipt: ByoReceipt | null; warnings: ReceiptWarning[] } => {
  const warnings: ReceiptWarning[] = [];
  if (raw === undefined || raw === null) return { receipt: null, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push({ code: 'receipt_not_object', message: 'receipt must be an object; it was not stored.' });
    return { receipt: null, warnings };
  }
  const input = raw as Record<string, unknown>;
  const receipt: Omit<ByoReceipt, 'source'> = {};

  const unknown = Object.keys(input).filter((key) => !KNOWN_FIELDS.has(key));
  if (unknown.length) {
    warnings.push({
      code: 'receipt_unknown_field',
      message: `receipt fields ${unknown.join(', ')} are not recorded; it keeps adapter, model, turns, tools and durationMs.`,
    });
  }

  if (input.adapter !== undefined) {
    if (isName(input.adapter, ADAPTER, RECEIPT_LIMITS.adapter)) receipt.adapter = input.adapter;
    else warnings.push({ code: 'receipt_invalid_adapter', message: 'receipt.adapter must be a short adapter name; it was not stored.' });
  }
  if (input.model !== undefined) {
    if (isName(input.model, NAME, RECEIPT_LIMITS.model)) receipt.model = input.model;
    else warnings.push({ code: 'receipt_invalid_model', message: 'receipt.model must be a model id; it was not stored.' });
  }
  if (input.turns !== undefined) {
    if (isBoundedInt(input.turns, RECEIPT_LIMITS.turns)) receipt.turns = input.turns;
    else warnings.push({ code: 'receipt_invalid_turns', message: `receipt.turns must be a whole number from 0 to ${RECEIPT_LIMITS.turns}; it was not stored.` });
  }
  if (input.durationMs !== undefined) {
    if (isBoundedInt(input.durationMs, RECEIPT_LIMITS.durationMs)) receipt.durationMs = input.durationMs;
    else warnings.push({ code: 'receipt_invalid_duration', message: 'receipt.durationMs must be whole milliseconds, at most a day; it was not stored.' });
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) {
      warnings.push({ code: 'receipt_invalid_tools', message: 'receipt.tools must be a list of tool names; it was not stored.' });
    } else {
      const valid = input.tools.filter((name) => isName(name, NAME, RECEIPT_LIMITS.toolName)) as string[];
      if (valid.length < input.tools.length) {
        warnings.push({ code: 'receipt_invalid_tool_name', message: 'receipt.tools kept only tool names; the other entries were dropped.' });
      }
      const unique = [...new Set(valid)];
      if (unique.length > RECEIPT_LIMITS.tools) {
        warnings.push({ code: 'receipt_tools_truncated', message: `receipt.tools keeps the first ${RECEIPT_LIMITS.tools} distinct names.` });
      }
      if (unique.length) receipt.tools = unique.slice(0, RECEIPT_LIMITS.tools);
    }
  }

  if (!Object.keys(receipt).length) {
    warnings.push({ code: 'receipt_empty', message: 'receipt had no usable fields; it was not stored.' });
    return { receipt: null, warnings };
  }
  return { receipt: { ...receipt, source: 'self-reported' }, warnings };
};
