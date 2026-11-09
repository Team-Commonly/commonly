/**
 * What an agent may read of a broker refusal. When a connection's owner can't
 * be used, the specific reason (suspended, deleting, gone, ...) stays on the
 * ToolCall record and on reads for people. An agent learns only that the
 * connection is unavailable, not what happened to the person behind it.
 *
 * The owner codes live here so the broker and every agent-facing surface read
 * one list.
 */
export const HOSTED_OWNER_REFUSAL_CODES = {
  banned: 'connection_owner_banned',
  missing: 'connection_owner_missing',
  bot: 'connection_owner_bot',
  restricted: 'connection_owner_restricted',
  deleting: 'connection_owner_deleting',
} as const;

const OWNER_REFUSAL_CODES = new Set<string>(Object.values(HOSTED_OWNER_REFUSAL_CODES));

export const AGENT_CONNECTION_UNAVAILABLE = {
  code: 'connection_unavailable',
  message: 'this connection is unavailable right now; ask the person who connected it',
} as const;

/** The refusal code as an agent may read it. */
export const agentFacingRefusalCode = (code: string | null | undefined): string | null => (
  code && OWNER_REFUSAL_CODES.has(code) ? AGENT_CONNECTION_UNAVAILABLE.code : (code ?? null)
);

type Refusal = { code?: string; message?: string; details?: unknown };

/**
 * A broker refusal as an agent may read it: an owner refusal becomes the
 * generic one. Takes an Error too. It reads the fields by name, because an
 * Error's message is not an own enumerable property and a spread drops it.
 */
export const agentFacingRefusal = (error: unknown): Refusal => {
  const e = (error || {}) as Refusal;
  if (e.code && OWNER_REFUSAL_CODES.has(e.code)) {
    return { code: AGENT_CONNECTION_UNAVAILABLE.code, message: AGENT_CONNECTION_UNAVAILABLE.message };
  }
  return {
    code: e.code,
    message: e.message,
    ...(e.details !== undefined ? { details: e.details } : {}),
  };
};

/**
 * Whether the caller is an agent: a runtime token, or a bot account's own cm_
 * token (auth sets req.botCaller from the row it loaded, and refuses a bot's
 * browser session outright).
 */
export const isAgentCaller = (req: unknown): boolean => {
  const r = req as { agentUser?: { _id?: unknown }; botCaller?: unknown };
  return Boolean(r?.agentUser?._id) || Boolean(r?.botCaller);
};
