/**
 * F525: connect codes. The connect page's one pasted line carries a code that
 * stops working once the agent has listened (or after 30 minutes), so the
 * shell history it lands in keeps nothing live. Until then it can be redeemed
 * again, so a run that stopped on a preflight fix line (#4143) connects on the
 * next paste.
 *
 * A code is minted only beside a freshly issued key. Showing a code never
 * rotates or revokes a key: only an explicit reconnect (force) does, and the
 * old code then refuses because its key is gone.
 */
import crypto from 'crypto';

// ADR-034 D4: the codes are a Postgres table (0015_agent_connect_codes.sql).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const codes = require('../repositories/agentConnectCodeRepository');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AuditLog = require('../models/AuditLog');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hash } = require('../utils/secret');

export const CONNECT_CODE_TTL_MS = 30 * 60 * 1000;
// Per code, so per agent: one code is live per agent at a time.
export const CONNECT_CODE_MAX_REDEEMS = 10;
export const CONNECT_CODE_PATTERN = /^cmc_[A-Za-z0-9_-]{22}$/;
const SEAL_INFO = 'commonly-connect-code-v1';

const sealKey = (code: string): Buffer => Buffer.from(
  crypto.hkdfSync('sha256', Buffer.from(code, 'utf8'), Buffer.alloc(0), SEAL_INFO, 32),
);
// The seal is bound to its agent and key hash, so a sealed key moved onto
// another row fails to open.
const sealAad = (agentUserId: unknown, tokenHash: string): Buffer => Buffer.from(`${String(agentUserId)}:${tokenHash}`, 'utf8');
const TAG_BYTES = 16;

export const mintConnectCode = async (
  { agentUserId, rawToken }: { agentUserId: unknown; rawToken: string },
): Promise<{ code: string; expiresAt: Date }> => {
  const code = `cmc_${crypto.randomBytes(16).toString('base64url')}`;
  const iv = crypto.randomBytes(12);
  const tokenHash = hash(rawToken);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(code), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(sealAad(agentUserId, tokenHash));
  const sealed = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONNECT_CODE_TTL_MS);
  // One live code per agent: a new one replaces the older.
  await codes.replaceForAgent({
    codeHash: hash(code),
    agentUserId: String(agentUserId),
    tokenHash,
    sealed: sealed.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    expiresAt,
  }, now);
  return { code, expiresAt };
};

export type RedeemOutcome = 'redeemed' | 'unknown' | 'used' | 'revoked' | 'rate_limited' | 'unavailable';
// The route's answer for each refusal, kept beside the outcomes so a new one
// can't silently fall through to a 404.
export const CONNECT_CODE_REFUSALS: Record<Exclude<RedeemOutcome, 'redeemed'>, [number, string]> = {
  unknown: [404, 'connect_code_unknown'],
  used: [410, 'connect_code_used'],
  revoked: [410, 'connect_code_revoked'],
  rate_limited: [429, 'connect_code_rate_limited'],
  unavailable: [503, 'connect_code_unavailable'],
};

const record = async (outcome: RedeemOutcome, agentUserId: unknown, ip?: string): Promise<void> => {
  try {
    await AuditLog.create({
      action: 'agent_connect_code_redeem',
      target: agentUserId ? String(agentUserId) : null,
      detail: outcome,
      ip: ip || null,
    });
  } catch (error) {
    console.warn('Connect code audit write failed:', (error as Error).message);
  }
};

/**
 * Trade a code for the agent's key. Every call leaves an audit row with the
 * agent (when the code matched one) and the outcome, never the code.
 */
export const redeemConnectCode = async (
  code: string, { ip }: { ip?: string } = {},
): Promise<{ outcome: RedeemOutcome; token?: string }> => {
  const codeHash = hash(code);
  const now = new Date();
  if (!codes.isAvailable()) {
    await record('unavailable', null, ip);
    return { outcome: 'unavailable' };
  }
  const row = await codes.claimRedeem(codeHash, now, CONNECT_CODE_MAX_REDEEMS);
  if (!row) {
    const capped = await codes.liveAgentFor(codeHash, now);
    const outcome: RedeemOutcome = capped ? 'rate_limited' : 'unknown';
    await record(outcome, capped, ip);
    return { outcome };
  }
  const agent = await User.findById(row.agentUserId).select('agentRuntimeTokens').lean();
  const live = (agent?.agentRuntimeTokens || []).find((entry: { tokenHash?: string }) => entry?.tokenHash === row.tokenHash);
  if (!live || live.lastListenedAt) {
    const outcome: RedeemOutcome = live ? 'used' : 'revoked';
    await codes.remove(row.codeHash);
    await record(outcome, row.agentUserId, ip);
    return { outcome };
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(code), Buffer.from(row.iv, 'base64'), { authTagLength: TAG_BYTES });
  decipher.setAAD(sealAad(row.agentUserId, row.tokenHash));
  decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
  const token = Buffer.concat([decipher.update(Buffer.from(row.sealed, 'base64')), decipher.final()]).toString('utf8');
  if (hash(token) !== row.tokenHash) throw new Error('connect code seal does not match its key');
  await record('redeemed', row.agentUserId, ip);
  return { outcome: 'redeemed', token };
};

module.exports = {
  CONNECT_CODE_TTL_MS,
  CONNECT_CODE_MAX_REDEEMS,
  CONNECT_CODE_PATTERN,
  CONNECT_CODE_REFUSALS,
  mintConnectCode,
  redeemConnectCode,
};
