// TASK-094 (PR A): per-spawn scoped credentials for daemon/CLI seats.
//
// A seat's supervisor mints a short-lived child credential for each spawn and
// hands THAT to the runtime instead of the seat's own lifetime token, so a
// credential file left behind by a killed spawn is a dead token rather than the
// seat's credential.
//
// The lifetime contract (Wren, 2026-09-20, after Vera 70738): renewal EXTENDS
// THE SAME VALUE rather than rotating it. The TTL therefore bounds the ABANDONED
// credential, not a stolen one: once the supervisor stops renewing — spawn ends,
// crash, SIGKILL — any holder of the value is 401 within one TTL (15 minutes),
// with no adapter involvement and nothing else required. While the supervisor is
// still renewing, a copy taken off-host is as alive as the spawn: its ceiling is
// the spawn's end + one TTL, and the absolute limit is `maxExpiresAt`
// (mint + 24h). "15 minutes" is never the exposure window for a stolen value; it
// is how long an abandoned one outlives its spawn.
//
// Scope: a child may not mint (a leaked file must not be able to manufacture a
// longer-lived one), and it can neither renew nor revoke itself — every write is
// keyed on the presenting credential being the PARENT of the target, and a child
// is nobody's parent, so a child presenting its own id is a 404 rather than a
// refusal it could argue with. Only the seat renews or revokes its own children:
// the parent link is part of every query, not a check after the fact.
import express from 'express';
// ESM import (not require) so CodeQL's js/missing-rate-limiting query recognizes
// the limiter (same pattern as routes/credentials.ts and routes/messages.ts).
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import {
  MAX_SPAWN_ID_LENGTH,
  SPAWN_ABSOLUTE_LIFETIME_SECONDS,
  SPAWN_TTL_DEFAULT_SECONDS,
  SPAWN_TTL_MAX_SECONDS,
  SPAWN_TTL_MIN_SECONDS,
  mintSpawnCredential,
  renewSpawnCredential,
  resolveSeatCredential,
  revokeOrphanSpawnCredentials,
  revokeSpawnCredential,
} from '../services/spawnCredentialService';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');

const router = express.Router();

// Keyed on the presented token hash (falling back to IP), same shape as the
// credential limiter in routes/credentials.ts. Mint/renew are frequent — one
// per spawn, plus renewals — so the cap is looser than the human surface and
// still far above any honest cadence.
const spawnCredentialRateLimit = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: { get?: (h: string) => string | undefined; ip?: string; agentTokenHash?: string }) => {
    if (req.agentTokenHash) return `tok:${req.agentTokenHash}`;
    const authHeader = req.get?.('authorization');
    if (authHeader) {
      return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(429).json({ message: 'rate limit exceeded: 240 spawn credential ops per 60s' });
  },
});

type RuntimeReq = express.Request & {
  agentUser?: { _id?: Types.ObjectId | string } | null;
  agentCredential?: { _id?: Types.ObjectId | string; scopes?: string[] } | null;
  agentTokenHash?: string;
};

const REFUSAL_STATUS: Record<string, number> = {
  child_cannot_mint: 403,
  invalid_spawn_id: 400,
  invalid_ttl: 400,
  not_found: 404,
  not_renewable: 409,
};

/**
 * Resolve the credential row that authenticates this call, backfilling one for
 * a seat token that predates the substrate.
 *
 * `installedBy` is only looked up when a backfill is actually needed (no row
 * behind the presented token), because the schema requires an owner and a
 * legacy embedded token carries none. Doing it unconditionally would add a
 * query to every mint.
 */
const seatRowFor = async (req: RuntimeReq) => {
  const agentUserId = req.agentUser?._id;
  if (!agentUserId || !req.agentTokenHash) return null;

  let installedBy: Types.ObjectId | string | null = null;
  if (!req.agentCredential) {
    const installation = await AgentInstallation.findOne({
      agentUserId,
      status: 'active',
    }).select('installedBy').lean();
    installedBy = installation?.installedBy || null;
  }

  return resolveSeatCredential({
    tokenHash: req.agentTokenHash,
    agentUserId,
    installedBy,
    label: 'Runtime token',
  });
};

// Mint a child for one spawn. The plaintext token is returned exactly once and
// never stored — the ledger keeps only its hash, the parent link, the spawn
// label and the two expiries.
router.post('/', spawnCredentialRateLimit, agentRuntimeAuth, async (req: RuntimeReq, res: express.Response) => {
  try {
    const seat = await seatRowFor(req);
    if (!seat) return res.status(401).json({ message: 'Agent authentication required' });

    const result = await mintSpawnCredential({
      seat,
      spawnId: (req.body || {}).spawnId,
      ttlSeconds: (req.body || {}).ttlSeconds,
      agentUserId: req.agentUser?._id || null,
    });
    if (!result.ok) {
      return res.status(REFUSAL_STATUS[result.code] || 400).json({
        message: `Spawn credential refused: ${result.code}`,
        code: result.code,
      });
    }

    return res.status(201).json({
      token: result.token,
      credentialId: String(result.credentialId),
      spawnId: result.spawnId,
      expiresAt: result.expiresAt,
      maxExpiresAt: result.maxExpiresAt,
    });
  } catch (err) {
    console.error('Error minting spawn credential:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Extend a live child. Same value, not a new one. A refused renewal (expired or
// revoked child) is the caller's signal to stop, not to retry harder: the TTL is
// the authority and a late renewal must not resurrect a dead credential.
router.post('/:id/renew', spawnCredentialRateLimit, agentRuntimeAuth, async (req: RuntimeReq, res: express.Response) => {
  try {
    const seat = await seatRowFor(req);
    if (!seat) return res.status(401).json({ message: 'Agent authentication required' });
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid credential id' });

    const result = await renewSpawnCredential({
      credentialId: id,
      seatCredentialId: seat._id,
      ttlSeconds: (req.body || {}).ttlSeconds,
    });
    if (!result.ok) {
      return res.status(REFUSAL_STATUS[result.code] || 400).json({
        message: `Spawn credential renewal refused: ${result.code}`,
        code: result.code,
      });
    }
    return res.json({ expiresAt: result.expiresAt, extended: result.extended });
  } catch (err) {
    console.error('Error renewing spawn credential:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// The boot sweep: everything minted before this process started is dead by
// definition, because no spawn outlived the restart. Idempotent, and it also
// backfills the caller's own row (Q2) so a legacy-only seat on its first boot
// after the cli update is a clean 200 rather than a 500.
router.post('/revoke-orphans', spawnCredentialRateLimit, agentRuntimeAuth, async (req: RuntimeReq, res: express.Response) => {
  try {
    const seat = await seatRowFor(req);
    if (!seat) return res.status(401).json({ message: 'Agent authentication required' });

    const revoked = await revokeOrphanSpawnCredentials({ seatCredentialId: seat._id });
    return res.json({ revoked });
  } catch (err) {
    console.error('Error sweeping orphan spawn credentials:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Revoke one child. Only its own seat, and a child cannot revoke itself: a
// leaked file must not be able to hide its own row from the sweep.
router.delete('/:id', spawnCredentialRateLimit, agentRuntimeAuth, async (req: RuntimeReq, res: express.Response) => {
  try {
    const seat = await seatRowFor(req);
    if (!seat) return res.status(401).json({ message: 'Agent authentication required' });
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid credential id' });

    const result = await revokeSpawnCredential({ credentialId: id, seatCredentialId: seat._id });
    if (!result.found) return res.status(404).json({ message: 'Spawn credential not found' });
    return res.json({ revoked: result.revoked });
  } catch (err) {
    console.error('Error revoking spawn credential:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Exposed for the route tests and for a caller that wants to know the shape
// without minting (the cli reads its own cadence off these, PR B).
//
// `minTtlSeconds`/`maxTtlSeconds` are the bounds `clampSpawnTtlSeconds` actually
// applies, published so a caller is not silently clamped: asking for 3600 used
// to yield a 900s credential with no way to find that out, which is the kind of
// difference a renewal cadence is built on (Vera 71068). They are this
// service's own outputs, not a second copy of the numbers — the route test pins
// each published value to the clamp rather than to a literal, so a change to the
// clamp that does not move the published bound reddens that test.
router.get('/policy', spawnCredentialRateLimit, agentRuntimeAuth, (_req: RuntimeReq, res: express.Response) => {
  res.json({
    defaultTtlSeconds: SPAWN_TTL_DEFAULT_SECONDS,
    minTtlSeconds: SPAWN_TTL_MIN_SECONDS,
    maxTtlSeconds: SPAWN_TTL_MAX_SECONDS,
    absoluteLifetimeSeconds: SPAWN_ABSOLUTE_LIFETIME_SECONDS,
    maxSpawnIdLength: MAX_SPAWN_ID_LENGTH,
  });
});

module.exports = router;
export {};
