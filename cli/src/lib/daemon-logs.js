import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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

export const logSize = (path) => statSync(path).size;

// Bytes appended since `offset`, for `agent logs --follow`. A file that shrank
// (rotated or truncated) is read from the start again.
export const readAppended = (path, offset) => {
  const size = logSize(path);
  const start = size < offset ? 0 : offset;
  if (size === start) return { text: '', offset: size };
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString('utf8'), offset: size };
  } finally {
    closeSync(fd);
  }
};
