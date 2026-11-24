import { Request, Response } from 'express';
import { AgentInstallation } from '../models/AgentRegistry';
import User, { IUser } from '../models/User';
import AgentCredential from '../models/AgentCredential';
import { resolveTokenAgentIdentity } from '../utils/agentTokenIdentity';
import { embeddedRuntimeTokenExpired, runtimeCredentialRefusalReason } from '../services/runtimeCredentialGate';
import { credentialRefusalReason, type AgentAuthRefusalReason } from '../services/agentAuthRefusals';
import { installationIdentityFilter } from '../services/agentInstallationIdentity';
import { refuse } from './agentRuntimeAuth';

// Its own file, not agentRuntimeAuth.ts: the read below is a projected
// User.findOne that sets nothing on the request, and that file's
// agentUserShapeContract guard (rightly) allows no projected User read there.

/**
 * F597: re-check a request agentRuntimeAuth already let through, for a
 * long-poll (`GET /events?waitMs=`) about to claim after a wake. The hold can
 * last 25 s, and a token revoked or an agent uninstalled in that time must not
 * claim. Asks only what can change in that window, through the same checks
 * the middleware uses (credential gate, embedded expiry, installation
 * identity), with the reads in parallel:
 *   - the ledger row, when the bearer has one;
 *   - user path: the embedded token copy, and an active installation;
 *   - installation path: the active installation holding the token (one read).
 * Answers as a fresh request would (the same 401 and reason) and returns
 * false; true when the request may go on. Not a replacement for the
 * middleware: identity and pod scope stay what the request resolved.
 */
export async function recheckHeldRuntimeAuth(req: Request, res: Response): Promise<boolean> {
  const tokenHash = req.agentTokenHash;
  if (!tokenHash) {
    refuse(req, res, 'missing_token', 'Missing agent token');
    return false;
  }
  const credentialRead = req.agentCredential
    ? AgentCredential.findOne({ tokenHash }).lean() : Promise.resolve(null);
  let reason: [AgentAuthRefusalReason, string] | null = null;
  if (req.agentAuthPath === 'installation') {
    const [credential, installed] = await Promise.all([
      credentialRead,
      AgentInstallation.exists({ 'runtimeTokens.tokenHash': tokenHash, status: 'active' }),
    ]);
    const refusal = credential ? await runtimeCredentialRefusalReason(credential) : null;
    if (req.agentCredential && !credential) reason = ['invalid_token', 'Invalid agent token'];
    else if (refusal) reason = [credentialRefusalReason(refusal), refusal];
    else if (!installed) reason = ['invalid_token', 'Invalid agent token'];
  } else {
    const agentUser = req.agentUser as IUser | undefined;
    const embedded = Boolean(agentUser?.agentRuntimeTokens?.some((t) => t.tokenHash === tokenHash));
    const { agentName, instanceId } = agentUser
      ? resolveTokenAgentIdentity(agentUser) : { agentName: '', instanceId: '' };
    const [credential, holder, installed] = await Promise.all([
      credentialRead,
      embedded
        ? User.findOne({ _id: agentUser?._id, 'agentRuntimeTokens.tokenHash': tokenHash })
          .select({ 'agentRuntimeTokens.$': 1 }).lean()
        : Promise.resolve(null),
      agentName
        ? AgentInstallation.exists({ ...installationIdentityFilter(agentName, instanceId), status: 'active' })
        : Promise.resolve(null),
    ]);
    const refusal = credential ? await runtimeCredentialRefusalReason(credential) : null;
    if (req.agentCredential && !credential) reason = ['invalid_token', 'Invalid agent token'];
    else if (refusal) reason = [credentialRefusalReason(refusal), refusal];
    else if (embedded && !holder) reason = ['invalid_token', 'Invalid agent token'];
    else if (holder && embeddedRuntimeTokenExpired(holder, tokenHash)) {
      reason = ['session_expired', 'Session token expired'];
    } else if (!installed) reason = ['agent_not_installed', 'Agent not installed'];
  }
  if (!reason) return true;
  refuse(req, res, reason[0], reason[1], tokenHash);
  return false;
}
