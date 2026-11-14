import { createClient } from './api.js';
import { CLI } from './cli-hint.js';

// F525: the Connect your own agent page's one pasted line carries a connect
// code, not the agent's lasting key, so the shell history it lands in keeps
// nothing that still works once the agent has listened. The run trades it for
// the key on POST /api/agents/runtime/connect-code (docs/agents/connect-code.md).
// The server's codes are 22 characters after the prefix; a little room either
// way, so a later format isn't refused here as "not a code".
export const CONNECT_CODE_PATTERN = /^cmc_[A-Za-z0-9_-]{16,64}$/;

const PAGE = 'the Connect your own agent page';

// One plain line per refusal. `name` is the agent the line was for.
export const connectCodeRefusalLine = (refusal, {
  name, runName = name, instanceUrl, detail, status,
} = {}) => {
  switch (refusal) {
    case 'invalid':
      return `That isn't a connect code from ${PAGE}. Copy the line from the page again and paste it whole.`;
    case 'unknown':
      return `This line's connect code has expired: each one works for 30 minutes. Get a new line from ${PAGE}.`;
    case 'used':
      return `${name} has already connected from a computer, so this line's code is spent. `
        + `On that computer, run: ${CLI} agent run ${runName}. To connect it here instead, get a new line from ${PAGE}.`;
    case 'revoked':
      return `${name}'s key has been replaced, so this line no longer works. Get the new line from ${PAGE}.`;
    case 'rate_limited':
      return 'Too many tries with this connect code. Wait a few minutes, then paste the line again.';
    case 'no_fetch':
      return 'This Node is too old to connect: Commonly needs Node 22 or later. '
        + 'Install Node 22 from nodejs.org, then paste the line again.';
    default:
      if (status) {
        return `${instanceUrl} answered HTTP ${status} to the connect code. `
          + `Check the line is the one from ${PAGE}, copy it again, and paste it whole.`;
      }
      return `Couldn't reach ${instanceUrl} to use the connect code${detail ? ` (${detail})` : ''}. `
        + 'Check this computer is online, then paste the line again.';
  }
};

const REFUSAL_BY_CODE = {
  invalid_connect_code: 'invalid',
  connect_code_unknown: 'unknown',
  connect_code_used: 'used',
  connect_code_revoked: 'revoked',
  connect_code_rate_limited: 'rate_limited',
};

/**
 * Trade a connect code for the agent's key. Returns `{ token }`, or
 * `{ refusal }` with one of the codes connectCodeRefusalLine knows. Sends no
 * bearer: the code is the credential.
 */
export const redeemConnectCode = async ({ code, instanceUrl, clientFactory = createClient }) => {
  if (typeof code !== 'string' || !CONNECT_CODE_PATTERN.test(code)) return { refusal: 'invalid' };
  if (typeof fetch !== 'function') return { refusal: 'no_fetch' };
  try {
    const body = await clientFactory({ instance: instanceUrl, token: null })
      .post('/api/agents/runtime/connect-code', { code });
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token.startsWith('cm_agent_')) return { refusal: 'unreachable', detail: 'unexpected answer' };
    return { token };
  } catch (err) {
    const known = REFUSAL_BY_CODE[err?.body?.code];
    if (known) return { refusal: known };
    return err?.status ? { refusal: 'unreachable', status: err.status } : { refusal: 'unreachable', detail: err?.message };
  }
};
