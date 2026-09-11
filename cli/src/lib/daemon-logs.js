import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const daemonLogsDir = (home = homedir()) => join(home, '.commonly', 'logs', 'daemon');
export const daemonSeatLogPath = (agentName, home = homedir()) => {
  const safeName = String(agentName || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return join(daemonLogsDir(home), `${safeName}.log`);
};

export const tailLines = (text, count = 50) => {
  const lines = String(text).split(/\r?\n/);
  // A trailing newline is a separator, not an empty log line.
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-Math.max(0, Number(count) || 0)).join('\n');
};

export const readLogTail = (path, count = 50) => {
  try {
    return tailLines(readFileSync(path, 'utf8'), count);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};
