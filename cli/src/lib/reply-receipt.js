// D245 item 4: the receipt the wrapper posts with a reply, so a BYO reply
// carries "how this reply was made" the way a hosted reply has its run trace.
// It is the wrapper's own account and the server stores it as self-reported
// (backend/services/byoReceipt.ts), which also bounds and checks every field.
// This side keeps to what it actually observed: an adapter that reports no
// stats sends only its name and the measured duration.

const isName = (value) => typeof value === 'string' && value.length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;

const parseLine = (raw) => {
  try { return JSON.parse(raw); } catch { return null; }
};

/**
 * What a Claude Code stream-json run says about itself: the model from the
 * init event, the turn count from the result event, and each tool it called,
 * once, in first-use order.
 */
export const claudeRunStats = (stdout) => {
  const events = String(stdout || '').split('\n').map(parseLine).filter(Boolean);
  const stats = {};
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  if (isName(init?.model)) stats.model = init.model;
  const result = [...events].reverse().find((event) => event.type === 'result');
  if (isCount(result?.num_turns)) stats.turns = result.num_turns;
  const tools = [];
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content || []) {
      if (block?.type === 'tool_use' && isName(block.name) && !tools.includes(block.name)) tools.push(block.name);
    }
  }
  if (tools.length) stats.tools = tools;
  return stats;
};

/** The receipt for one reply, or null when there is no adapter to name. */
export const buildReplyReceipt = ({ adapterName, stats = {}, durationMs } = {}) => {
  if (!isName(adapterName)) return null;
  const receipt = { adapter: adapterName };
  // A cloud-hosted model can be named by an ARN or a resource path that
  // carries the account or project it runs in; that is not this reply's to
  // publish, so such a model id is left out.
  if (isName(stats?.model) && !/^arn:|(^|\/)projects\//i.test(stats.model)) receipt.model = stats.model;
  if (isCount(stats?.turns)) receipt.turns = stats.turns;
  if (Array.isArray(stats?.tools)) {
    const tools = stats.tools.filter(isName);
    if (tools.length) receipt.tools = tools;
  }
  if (Number.isFinite(durationMs) && durationMs >= 0) receipt.durationMs = Math.round(durationMs);
  return receipt;
};
