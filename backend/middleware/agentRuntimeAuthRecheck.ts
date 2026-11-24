import { Request, Response } from 'express';
import { AgentInstallation } from '../models/AgentRegistry';
import User, { IUser } from '../models/User';
import AgentCredential from '../models/AgentCredential';
import { resolveTokenAgentIdentity } from '../utils/agentTokenIdentity';
import { embeddedRuntimeTokenExpired, runtimeCredentialRefusalReason } from '../services/runtimeCredentialGate';
import { credentialRefusalReason, type AgentAuthRefusalReason } from '../services/agentAuthRefusals';
import { installationIdentityFilter } from '../services/agentInstallationIdentity';
import { cloudRuntimeMayRun, CLOUD_RUN_REFUSED_REASON } from '../services/cloudRuntimeOwnership';
import { refuse, resolveSpawnChildAgentUser } from './agentRuntimeAuth';

// Its own file, not agentRuntimeAuth.ts: the read below is a projected
// User.findOne that sets nothing on the request, and that file's
// agentUserShapeContract guard (rightly) allows no projected User read there.

type InstallationRow = { _id?: unknown; podId?: unknown; agentName?: string; instanceId?: string };

/** What a held request may still claim from: its active installations now. */
export type HeldRuntimeScope = {
  installations: InstallationRow[];
  installation: InstallationRow | null;
};

/**
 * F597: re-check a request agentRuntimeAuth already let through, for a
 * long-poll (`GET /events?waitMs=`) about to claim after a wake. The hold can
 * last 25 s, and a token revoked, an agent uninstalled (from any one pod) or a
 * cloud entitlement lost in that time must not claim. Asks only what can
 * change in that window, through the same checks the middleware uses
 * (credential gate, embedded expiry, spawn child's bot User, installation
 * identity, cloud-runtime gate), with the reads in parallel.
 *
 * Refuses as a fresh request would (the same status, reason and code) and
 * returns null. Otherwise returns the identity's active installations as they
 * are now, so the caller rebuilds its pod scope from them rather than from
 * the request's start. Identity stays what the request resolved.
 */
export async function recheckHeldRuntimeAuth(req: Request, res: Response): Promise<HeldRuntimeScope | null> {
  const tokenHash = req.agentTokenHash;
  if (!tokenHash) {
    refuse(req, res, 'missing_token', 'Missing agent token');
    return null;
  }
  const byInstallation = req.agentAuthPath === 'installation';
  const agentUser = req.agentUser as IUser | undefined;
  const tokenInstallation = req.agentInstallation as InstallationRow | null | undefined;
  const { agentName, instanceId } = byInstallation
    ? { agentName: tokenInstallation?.agentName || '', instanceId: tokenInstallation?.instanceId || 'default' }
    : (agentUser ? resolveTokenAgentIdentity(agentUser) : { agentName: '', instanceId: '' });
  const embedded = !byInstallation
    && Boolean(agentUser?.agentRuntimeTokens?.some((t) => t.tokenHash === tokenHash));

  const [credential, holder, tokenRow, installations, mayRun] = await Promise.all([
    // Every recheck: a legacy token can gain a ledger row mid-hold
    // (resolveSeatCredential), and a revoke of that row must count.
    AgentCredential.findOne({ tokenHash }).lean(),
    embedded
      // isBot as in the middleware's fresh-request lookup.
      ? User.findOne({ _id: agentUser?._id, 'agentRuntimeTokens.tokenHash': tokenHash, isBot: true })
        .select({ 'agentRuntimeTokens.$': 1 }).lean()
      : Promise.resolve(null),
    byInstallation
      ? AgentInstallation.findOne({ 'runtimeTokens.tokenHash': tokenHash, status: 'active' })
        .select({ podId: 1, agentName: 1, instanceId: 1 }).lean()
      : Promise.resolve(null),
    agentName
      ? AgentInstallation.find({ ...installationIdentityFilter(agentName, instanceId), status: 'active' })
        .select({ podId: 1, agentName: 1, instanceId: 1 }).lean()
      : Promise.resolve([]),
    agentName ? cloudRuntimeMayRun(agentName, instanceId) : Promise.resolve(true),
  ]) as [
    Parameters<typeof runtimeCredentialRefusalReason>[0] | null,
    Parameters<typeof embeddedRuntimeTokenExpired>[0] | null,
    InstallationRow | null,
    InstallationRow[],
    boolean,
  ];

  const refusal = credential ? await runtimeCredentialRefusalReason(credential) : null;
  let reason: [AgentAuthRefusalReason, string] | null = null;
  if (req.agentCredential && !credential) reason = ['invalid_token', 'Invalid agent token'];
  else if (refusal) reason = [credentialRefusalReason(refusal), refusal];
  else if (byInstallation) {
    if (!tokenRow) reason = ['invalid_token', 'Invalid agent token'];
  } else if (embedded) {
    if (!holder) reason = ['invalid_token', 'Invalid agent token'];
    else if (embeddedRuntimeTokenExpired(holder, tokenHash)) reason = ['session_expired', 'Session token expired'];
  } else if (!await resolveSpawnChildAgentUser(credential as never)) {
    // A ledger-only (spawn) token resolves through its bot User; a fresh
    // request with that User gone finds no agent and refuses the token.
    reason = ['invalid_token', 'Invalid agent token'];
  }
  if (!reason && !byInstallation && installations.length === 0) {
    reason = ['agent_not_installed', 'Agent not installed'];
  }
  if (reason) {
    refuse(req, res, reason[0], reason[1], tokenHash);
    return null;
  }
  if (!mayRun) {
    res.status(403).json({ code: CLOUD_RUN_REFUSED_REASON, message: 'This agent is not running.' });
    return null;
  }
  // The legacy path keeps the token's own installation in scope even when the
  // identity-wide query misses it, as the middleware does.
  const scoped = byInstallation && tokenRow
    && !installations.some((row) => String(row._id) === String(tokenRow._id))
    ? [tokenRow, ...installations] : installations;
  return { installations: scoped, installation: byInstallation ? tokenRow : (scoped[0] || null) };
}
