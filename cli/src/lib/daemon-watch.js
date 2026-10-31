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

const clip = (text, width) => {
  const value = String(text ?? '');
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
};

// A log line can carry a credential or a whole prompt. Redact the token shapes
// this CLI knows, and clip the rest to the width, so the view never prints
// either in full.
const TOKEN_SHAPE = /(cm_(?:daemon|agent|user)_[A-Za-z0-9_-]+|Bearer\s+\S+)/g;
export const safeLogLine = (line, width) => clip(String(line).replace(TOKEN_SHAPE, '[redacted]'), width);

// The state is the server's verdict, read by daemon-agent-states. `states` is
// that Map; without it the state is unknown, and the frame says why. An agent
// the verdict does not list has no installation on any pod this login can see.
export const agentStateLabel = (seat = {}, states = null) => {
  if (!states) return 'unknown';
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
