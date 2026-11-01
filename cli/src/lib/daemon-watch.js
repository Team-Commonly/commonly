// The live view behind `commonly daemon status --watch`: the machine, then one
// block per supervised agent with its state, last turn, last error and the tail
// of its log. Rendering is a pure function of its inputs so the layout can be
// tested at fixed widths; the redraw loop lives in the command.

import { seatKey } from './daemon-agent-states.js';

export const WATCH_INTERVAL_MS = 2000;

const ANSI = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

// A redraw clears the screen and returns the cursor home. Plain ANSI, no
// dependency; the caller decides whether to use it at all.
export const CLEAR_SCREEN = '\x1b[H\x1b[2J';

// The view is for a person watching a terminal. Anything else gets one print.
export const shouldRedraw = ({ isTTY, env = process.env } = {}) => (
  Boolean(isTTY) && !(env && env.NO_COLOR !== undefined && env.NO_COLOR !== '')
);

const relative = (iso, now) => {
  if (!iso) return 'never';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
};

// Terminal control sequences in a log or state field would reach the operator's
// terminal: a line could clear the watch, set the title, or write the clipboard.
// Strip OSC and CSI sequences, bare escapes, and C0/C1 controls before anything
// else. Tabs become spaces so the column count stays honest.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const ESC = /\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;
export const stripControls = (text) => String(text ?? '')
  .replace(OSC, '').replace(CSI, '').replace(ESC, '').replace(CONTROL, '').replace(/\t/g, '  ');

// Credential shapes the CLI knows, plus the forms that carry a credential in a
// log without a known prefix: `Authorization: Basic …`, and a quoted or bare
// `token`/`password`/`secret`/`api_key` field. Generic key/value redaction can
// over-match, which is the cheaper error for a watch that prints logs.
const CREDENTIAL = [
  [/cm_(?:daemon|agent|user)_[A-Za-z0-9_-]+/g, '[redacted]'],
  [/\bBearer\s+\S+/gi, '[redacted]'],
  [/\bBasic\s+[A-Za-z0-9+/=._-]+/g, '[redacted]'],
  [/(\bauthorization\s*[:=]\s*)(?:(?:basic|bearer|digest|token)\s+)?\S+/gi, '$1[redacted]'],
  [/(["']?\b(?:token|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\b["']?\s*[:=]\s*)(["']?)[^\s"',}&]+\2/gi, '$1$2[redacted]$2'],
];
const redact = (text) => CREDENTIAL.reduce((value, [shape, replacement]) => value.replace(shape, replacement), text);

// Every field the watch prints goes through here: control sequences out,
// credentials redacted, then clipped to the width.
const clip = (text, width) => {
  const value = redact(stripControls(text));
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
};

// A log line can carry a credential or a whole prompt; the same boundary covers it.
export const safeLogLine = (line, width) => clip(line, width);

// The state is the server's verdict, read by daemon-agent-states. `states` is
// that Map. Without it (no login, or the read failed) the seat shows its local
// process state, labelled `local`, and never a server word. An agent the verdict
// does not list has no installation on its pod.
export const agentStateLabel = (seat = {}, states = null) => {
  if (!states) return `local ${seat.state || 'unknown'}`;
  return states.get(seatKey(seat.agentName, seat.instanceId)) || 'not registered';
};

const agentBlock = (seat, { now, width, color, logTail, states }) => {
  const dim = (text) => (color ? `${ANSI.dim}${text}${ANSI.reset}` : text);
  const bold = (text) => (color ? `${ANSI.bold}${text}${ANSI.reset}` : text);
  const lines = [
    `${bold(clip(seat.agentName || 'unknown', width))}  ${agentStateLabel(seat, states)}  last turn ${relative(seat.lastTurnAt, now)}`,
  ];
  if (seat.lastError) lines.push(clip(`  error: ${seat.lastError}`, width));
  for (const line of logTail || []) lines.push(dim(`  ${safeLogLine(line, Math.max(10, width - 2))}`));
  return lines;
};

// Inputs: `machine` { name, status, lastSeenAt }, `seats` (from the daemon state
// file), `logTails` { [agentName]: string[] }, `states` (Map from
// loadReachByAgent, or null), `stateNote` (why states is null), `now` (ms),
// `width` (columns).
export const renderDaemonWatch = ({
  machine = {}, seats = [], logTails = {}, states = null, stateNote = '', now = Date.now(), width = 80, color = false,
} = {}) => {
  const bold = (text) => (color ? `${ANSI.bold}${text}${ANSI.reset}` : text);
  const out = [
    bold(clip(`${machine.name || 'machine'}: ${machine.status || 'unknown'}`, width)),
    clip(`last heartbeat ${relative(machine.lastSeenAt, now)}`, width),
  ];
  if (stateNote) out.push(clip(stateNote, width));
  out.push('');
  if (!seats.length) {
    out.push('No supervised agents on this machine.');
    return out.join('\n');
  }
  for (const seat of seats) {
    out.push(...agentBlock(seat, { now, width, color, logTail: logTails[seat.agentName] || [], states }));
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '');
};
