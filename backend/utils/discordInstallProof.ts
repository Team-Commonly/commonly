/**
 * Discord first-install proof (F89).
 *
 * The success page's channel picker reads `GET /api/discord/channels/:guildId`,
 * which answers only for a guild already bound to one of the caller's pods. On a
 * first install nothing is bound yet, so the picker never loaded. The OAuth
 * callback is where Commonly learns which guild the bot was just added to: the
 * code exchange's token response names it. The callback has no session (Discord
 * redirects a browser there), so it hands the page a short-lived signed proof of
 * (pod, guild), and the channels route accepts that proof in place of a binding
 * when the caller belongs to the pod it names.
 *
 * The payload carries neither `id` nor `user`, so `middleware/auth` never reads
 * it as a session.
 *
 * F131: it also carries the installer's Discord user id when the callback read
 * it from `users/@me` with the token the code exchange returned. That id is
 * what makes a live relay honest on a shared channel (only that author's lines
 * are written as the installer), so it comes from Discord or not at all — the
 * proof is the only way it reaches `POST /api/integrations`.
 */
import jwt, { type JwtPayload } from 'jsonwebtoken';

import { isDiscordSnowflake } from './discordBinding';

const PURPOSE = 'discord-install';
const DISCORD_INSTALL_PROOF_TTL_SECONDS = 30 * 60;

interface DiscordInstallProofPayload extends JwtPayload {
  pur: typeof PURPOSE;
  pod: string;
  gid: string;
  // The person whose install this is: the state's user. Only they may spend it.
  uid: string;
  // Their Discord user id, from `users/@me` (F131). Absent when that read failed.
  did?: string;
}

const secret = (): string => {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set');
  return value;
};

export const mintDiscordInstallProof = (
  {
    podId, guildId, userId, discordUserId,
  }: { podId: string; guildId: string; userId: string; discordUserId?: string | null },
  ttlSeconds: number = DISCORD_INSTALL_PROOF_TTL_SECONDS,
): string => {
  const payload: DiscordInstallProofPayload = {
    pur: PURPOSE,
    pod: podId,
    gid: guildId,
    uid: userId,
    ...(isDiscordSnowflake(discordUserId) ? { did: String(discordUserId) } : {}),
  };
  return jwt.sign(payload, secret(), { expiresIn: ttlSeconds });
};

/**
 * The proof's (pod, guild, user), or null for anything that is not a live proof.
 * A proof without a user (minted before the state was signed) is not a proof.
 */
export const readDiscordInstallProof = (token: unknown): {
  podId: string; guildId: string; userId: string; discordUserId?: string;
} | null => {
  if (typeof token !== 'string' || !token) return null;
  try {
    const decoded = jwt.verify(token, secret()) as DiscordInstallProofPayload;
    if (decoded.pur !== PURPOSE || typeof decoded.pod !== 'string' || !isDiscordSnowflake(decoded.gid)) return null;
    if (typeof decoded.uid !== 'string' || !decoded.uid) return null;
    return {
      podId: decoded.pod,
      guildId: decoded.gid,
      userId: decoded.uid,
      ...(isDiscordSnowflake(decoded.did) ? { discordUserId: String(decoded.did) } : {}),
    };
  } catch {
    return null;
  }
};

// ---- The install state ----
// The OAuth `state` the install link sends Discord, and Discord hands back to the
// callback. The callback has no session, so this is the only thing that ties a
// code to the person who asked for the install. It used to be the bare string
// `pod_<id>`: a crafted callback link carrying an attacker's code and a victim's
// pod minted a proof that the victim's browser then spent binding their pod to
// the attacker's guild. Signed, short-lived and naming the user, it can only be
// obtained from install-link by someone allowed to install into that pod, and the
// proof it leads to can be spent only by that same person.
const STATE_PURPOSE = 'discord-install-state';
const DISCORD_INSTALL_STATE_TTL_SECONDS = 15 * 60;

interface DiscordInstallStatePayload extends JwtPayload {
  pur: typeof STATE_PURPOSE;
  pod: string;
  uid: string;
}

export const mintDiscordInstallState = (
  { podId, userId }: { podId: string; userId: string },
  ttlSeconds: number = DISCORD_INSTALL_STATE_TTL_SECONDS,
): string => {
  const payload: DiscordInstallStatePayload = { pur: STATE_PURPOSE, pod: podId, uid: userId };
  return jwt.sign(payload, secret(), { expiresIn: ttlSeconds });
};

/** The state's (pod, user), or null for anything that is not a live state. */
export const readDiscordInstallState = (token: unknown): { podId: string; userId: string } | null => {
  if (typeof token !== 'string' || !token) return null;
  try {
    const decoded = jwt.verify(token, secret()) as DiscordInstallStatePayload;
    if (decoded.pur !== STATE_PURPOSE || typeof decoded.pod !== 'string' || !decoded.pod) return null;
    if (typeof decoded.uid !== 'string' || !decoded.uid) return null;
    return { podId: decoded.pod, userId: decoded.uid };
  } catch {
    return null;
  }
};
