/**
 * What the fake model says next. A turn is chosen either from a script (one
 * entry per model request) or from inline directives in the prompt, then
 * normalised into one shape that every wire format renders.
 *
 * Normalised turn:
 *   { kind, text: string[], thought, toolCalls: [{name, arguments}], stop,
 *     stall, refuse, refuseAs, error: {status, type, message, inStream, headers}, cut: {after, mode} }
 * `kind` is the legacy directive name ('reply' | 'stall' | 'refuse' | 'fail')
 * plus 'tool' and 'cut', so existing `requests[i].directive` checks keep working.
 */

/** Walk a JSON value starting at `start`, honouring strings, and return the index after it. */
const jsonEnd = (text, start) => {
  const open = text[start];
  if (open !== '{' && open !== '[') return -1;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
};

/** `[[tool:name]]` or `[[tool:name:{json}]]`; the JSON may itself contain `]]`. */
const toolDirectives = (text) => {
  const calls = [];
  const re = /\[\[tool:([A-Za-z0-9_.\-]+)(:)?/g;
  let match;
  while ((match = re.exec(text))) {
    let args = {};
    let end = re.lastIndex;
    if (match[2]) {
      const stop = jsonEnd(text, end);
      if (stop < 0) continue;
      try { args = JSON.parse(text.slice(end, stop)); } catch { continue; }
      end = stop;
    }
    if (text.slice(end, end + 2) !== ']]') continue;
    calls.push({ name: match[1], arguments: args });
    re.lastIndex = end + 2;
  }
  return calls;
};

/** Parse every directive in a prompt. Unknown text is ignored. */
export const parseDirectives = (text = '') => {
  // The legacy four keep first-match precedence, exactly as before.
  const legacy = /\[\[(reply|stall|refuse|fail)(?::([^\]]*))?\]\]/.exec(text);
  const think = /\[\[think:([^\]]*)\]\]/.exec(text);
  const cut = /\[\[cut:(\d+)(?::(silent|close))?\]\]/.exec(text);
  return {
    kind: legacy ? legacy[1] : 'reply',
    arg: legacy ? (legacy[2] ?? '') : '',
    reply: /\[\[reply:([^\]]*)\]\]/.exec(text)?.[1] ?? null,
    thought: think ? think[1] : null,
    cut: cut ? { after: Number(cut[1]), mode: cut[2] || 'silent' } : null,
    toolCalls: toolDirectives(text),
  };
};

const ERROR_DEFAULTS = { status: 500, type: null, message: 'fake provider failure', inStream: false, headers: {} };

const normaliseError = (error) => {
  if (error === undefined || error === null || error === false) return null;
  if (typeof error === 'number') return { ...ERROR_DEFAULTS, status: error };
  return { ...ERROR_DEFAULTS, ...error, status: Number(error.status) || 500 };
};

const normaliseCut = (cut) => {
  if (cut === undefined || cut === null || cut === false) return null;
  if (typeof cut === 'number') return { after: cut, mode: 'silent' };
  return { after: Number(cut.after) || 0, mode: cut.mode === 'close' ? 'close' : 'silent' };
};

const kindOf = (t) => (t.stall ? 'stall'
  : t.refuse !== null ? 'refuse'
    : t.error && !t.error.inStream ? 'fail'
      : t.cut ? 'cut'
        : t.toolCalls.length ? 'tool' : 'reply');

/** Accept a script entry in any of its short forms and return the normalised turn. */
export const normaliseTurn = (entry, { defaultReply = 'PONG' } = {}) => {
  const raw = typeof entry === 'string' ? { text: entry } : { ...(entry || {}) };
  const text = raw.text === undefined || raw.text === null ? []
    : Array.isArray(raw.text) ? raw.text.map(String) : [String(raw.text)];
  const toolCalls = (raw.toolCalls || []).map((call) => ({
    name: String(call.name),
    arguments: call.arguments === undefined ? {} : call.arguments,
  }));
  const refuse = raw.refuse === undefined || raw.refuse === false || raw.refuse === null ? null
    : raw.refuse === true ? 'I can’t help with that.' : String(raw.refuse);
  const turn = {
    text: text.length || toolCalls.length || refuse !== null || raw.thought || raw.stall || raw.error ? text : [defaultReply],
    thought: raw.thought ? String(raw.thought) : null,
    toolCalls,
    stop: raw.stop || null,
    stall: !!raw.stall,
    refuse,
    refuseAs: raw.refuseAs || null,
    error: normaliseError(raw.error),
    cut: normaliseCut(raw.cut),
  };
  return { ...turn, kind: kindOf(turn) };
};

/**
 * The turn inline directives ask for. Tool directives are phase-aware: the
 * request that follows a tool round still carries the same prompt, so without
 * the phase the model would ask for the same tool forever.
 */
export const turnFromDirectives = (prompt, toolRounds, { defaultReply = 'PONG' } = {}) => {
  const d = parseDirectives(prompt);
  if (d.kind === 'stall') return normaliseTurn({ stall: true });
  if (d.kind === 'refuse') return normaliseTurn({ refuse: true });
  if (d.kind === 'fail') return normaliseTurn({ error: Number(d.arg) || 500 });
  const reply = d.reply || defaultReply;
  if (d.toolCalls.length && toolRounds === 0) {
    return normaliseTurn({ thought: d.thought, toolCalls: d.toolCalls, cut: d.cut });
  }
  return normaliseTurn({ text: reply, thought: toolRounds === 0 ? d.thought : null, cut: d.cut }, { defaultReply });
};

/**
 * The conversation as the wire formats agree on it: the prompt is the last user
 * message that is not a tool result, a tool round is one run of tool results
 * after it, and the fresh results are the run that ends the conversation.
 */
export const conversationFacts = (all) => {
  // System and developer messages can sit between a tool result and the next
  // request (Claude Code appends one), so they never break a tool run.
  const entries = all.filter((e) => e.role !== 'system' && e.role !== 'developer');
  let promptAt = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === 'user') { promptAt = i; break; }
  }
  let toolRounds = 0;
  for (let i = promptAt + 1; i < entries.length; i += 1) {
    if (entries[i].role === 'tool' && entries[i - 1]?.role !== 'tool') toolRounds += 1;
  }
  // The results this request is reporting: the trailing run of tool entries.
  const fresh = [];
  for (let i = entries.length - 1; i >= 0 && entries[i].role === 'tool'; i -= 1) {
    fresh.unshift(...entries[i].toolResults);
  }
  const callNames = new Map();
  for (const e of entries) for (const call of e.toolCalls || []) callNames.set(call.id, call.name);
  return {
    prompt: promptAt >= 0 ? entries[promptAt].text : '',
    toolRounds,
    toolResults: fresh.map((r) => ({ ...r, name: r.name || callNames.get(r.callId) || null })),
  };
};

/** Flatten a content value (string, or an array of parts of any wire format) into text. */
export const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    return '';
  }).join('');
};
