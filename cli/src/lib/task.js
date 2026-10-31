/**
 * The task board from the CLI: identity, the request layer, and one-line
 * rendering. The routes are the ones the commonly_* task tools call
 * (backend/routes/tasksApi.ts), so the CLI and the MCP cannot disagree about
 * what a write means.
 *
 * Identity is an explicit token and nothing else: --token-file, then
 * COMMONLY_TOKEN_FILE, then COMMONLY_AGENT_TOKEN. The saved login and
 * COMMONLY_TOKEN are never read. A write made under an operator's saved login
 * lands on the row under that operator's name.
 */

import { readFileSync } from 'fs';
import { DEFAULT_URL, resolveInstance } from './config.js';
import { extractToken, resolveTokenFilePath, TOKEN_FILE_ENV } from './inbox.js';

export const API_URL_ENV = 'COMMONLY_API_URL';
export const TASK_TOKEN_ENV = 'COMMONLY_AGENT_TOKEN';
export const TASK_STATUSES = ['pending', 'claimed', 'done', 'blocked'];
// `update` writes only these. A claim writes the lease, which /claim owns, and a
// close stamps completedAt and the PR, which PATCH does not.
export const UPDATE_STATUSES = ['pending', 'blocked'];
export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const REQUEST_TIMEOUT_MS = 30_000;

/** A refusal made before any request: a bad flag, or no identity to send. */
export class TaskRefusal extends Error {}

/** A failed call. `status` is 0 when the server was never reached. */
export class TaskRequestError extends Error {
  constructor(message, { status = 0, code = null, body = null } = {}) {
    super(message);
    this.name = 'TaskRequestError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export const requireText = (value, flag) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new TaskRefusal(`${flag} needs a value.`);
  return text;
};

export const checkPriority = (value) => {
  const priority = String(value).trim().toUpperCase();
  if (!TASK_PRIORITIES.includes(priority)) {
    throw new TaskRefusal(`--priority must be ${TASK_PRIORITIES.join(', ')} (got '${value}').`);
  }
  return priority;
};

export const checkStatusFilter = (value) => {
  const statuses = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (statuses.length === 0 || statuses.some((s) => !TASK_STATUSES.includes(s))) {
    throw new TaskRefusal(`--status takes ${TASK_STATUSES.join(', ')}, comma-separated (got '${value}').`);
  }
  return statuses.join(',');
};

export const checkUpdateStatus = (value) => {
  const status = String(value).trim().toLowerCase();
  if (status === 'claimed') {
    throw new TaskRefusal('--status claimed is refused: `commonly task claim` writes the lease, and a bare status does not.');
  }
  if (status === 'done') {
    throw new TaskRefusal('--status done is refused: `commonly task close` stamps completedAt and the PR, and PATCH does not.');
  }
  if (!UPDATE_STATUSES.includes(status)) {
    throw new TaskRefusal(`--status must be ${UPDATE_STATUSES.join(' or ')} (got '${value}').`);
  }
  return status;
};

/** TASK-669, task-669 and 669 name one row. Anything else is refused before a request. */
export const checkTaskId = (value) => {
  const match = String(value ?? '').trim().match(/^(?:task-)?(\d+)$/i);
  if (!match) throw new TaskRefusal(`task id must look like TASK-123 (got '${value ?? ''}').`);
  return `TASK-${Number(match[1])}`;
};

/**
 * Resolve the token. A token file that exists but holds nothing is refused by
 * its path. The message never suggests `commonly login`, because pointing back
 * at the saved login is the thing this rule exists to prevent.
 */
export const resolveTaskToken = (opts = {}, env = process.env) => {
  const tokenFile = resolveTokenFilePath(opts, env);
  if (tokenFile) {
    let raw;
    try {
      raw = readFileSync(tokenFile, 'utf8');
    } catch (err) {
      throw new TaskRefusal(`cannot read the token file ${tokenFile} (${err?.code || err?.message}).`);
    }
    const token = extractToken(raw);
    if (!token) throw new TaskRefusal(`no token in ${tokenFile}. Expected a raw token, or JSON with a token field.`);
    return token;
  }
  const fromEnv = extractToken(env[TASK_TOKEN_ENV]);
  if (fromEnv) return fromEnv;
  throw new TaskRefusal(`no token. Pass --token-file <path>, or set ${TOKEN_FILE_ENV} or ${TASK_TOKEN_ENV}.`);
};

/**
 * --instance takes a URL or a saved key, and an unknown key is refused. Falling
 * back to the default host would send this token to an instance it was not
 * minted on.
 */
export const resolveTaskBaseUrl = (opts = {}, env = process.env) => {
  if (opts.instance) {
    const inst = resolveInstance(opts.instance);
    if (!inst?.url) {
      throw new TaskRefusal(`unknown instance '${opts.instance}'. Pass its URL, or a saved instance key.`);
    }
    return inst.url.replace(/\/$/, '');
  }
  const fromEnv = String(env[API_URL_ENV] || '').trim().replace(/\/$/, '');
  return fromEnv || DEFAULT_URL;
};

/** `/api/v1/tasks/<pod>` for the board, and `…/<taskId>` for one row. */
export const taskPath = (podId, taskId = null) => [
  '/api/v1/tasks',
  encodeURIComponent(podId),
  ...(taskId === null ? [] : [encodeURIComponent(taskId)]),
].join('/');

const messageFor = (status, body, text) => {
  if (body && typeof body.error === 'string' && body.error) return body.error;
  if (body && typeof body.message === 'string' && body.message) return body.message;
  const trimmed = String(text || '').trim();
  if (!trimmed) return `HTTP ${status}`;
  if (/^<(?:!doctype|html)/i.test(trimmed)) {
    const title = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return title ? title.replace(/\s+/g, ' ').trim() : 'HTML error page';
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 200);
};

/**
 * One attempt per call. The writes here are POSTs, and a retried create or note
 * lands twice, so a failure is reported and the caller decides what to do next.
 */
export const createTaskClient = ({ baseUrl, token, fetchImpl = fetch }) => {
  const send = async (method, path, body) => {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TaskRequestError(`could not reach ${baseUrl} (${err?.message || err}).`);
    }
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      throw new TaskRequestError(messageFor(res.status, parsed, text), {
        status: res.status,
        code: parsed?.code || null,
        body: parsed,
      });
    }
    return parsed;
  };

  const get = (path, params = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== ''),
    ).toString();
    return send('GET', query ? `${path}?${query}` : path);
  };

  return {
    get,
    post: (path, body = {}) => send('POST', path, body),
    patch: (path, body = {}) => send('PATCH', path, body),
  };
};

const clockOf = (iso) => {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : `${at.toISOString().slice(11, 16)}Z`;
};

/** One row, as a human reads it. A claimed row also says whether its lease holds. */
export const formatTaskLine = (task) => {
  const line = [task.taskId, task.status, task.priority || '-', task.assignee || '-', task.title].join('  ');
  if (task.status !== 'claimed') return line;
  const at = clockOf(task.claimExpiresAt);
  if (!at) return line;
  const lapsed = new Date(task.claimExpiresAt).getTime() < Date.now();
  return `${line} (${lapsed ? 'lease lapsed' : 'held until'} ${at})`;
};

/**
 * One line for a failed call. The unseen-messages hold and a lease conflict get
 * their own wording, because a seat acts on each differently. Everything else is
 * the server's own text.
 */
export const describeFailure = (err) => {
  if (!(err instanceof TaskRequestError)) return `Failed: ${err?.message || err}`;
  if (err.status === 0) return `Failed: ${err.message}`;
  const body = err.body || {};
  let line;
  if (err.code === 'unseen_messages') {
    const count = Number(body.unseenCount) || 0;
    line = `Failed (HTTP ${err.status}): ${count} unseen message${count === 1 ? '' : 's'} in this pod. `
      + 'Read them and retry, or pass --continue-anyway to go ahead.';
  } else {
    const detail = [
      body.claimedBy ? `held by ${body.claimedBy}` : null,
      clockOf(body.claimExpiresAt) ? `lease until ${clockOf(body.claimExpiresAt)}` : null,
    ].filter(Boolean).join(', ');
    line = `Failed (HTTP ${err.status}): ${err.message}${detail ? ` (${detail})` : ''}`;
    if (err.status === 401) {
      line += '. Check the agent token: --token-file, COMMONLY_TOKEN_FILE or COMMONLY_AGENT_TOKEN.';
    }
  }
  return line.replace(/\s+/g, ' ');
};
